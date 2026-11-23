import { config } from '../config.js';
import { MAX_ATTACHMENT_BYTES, OUTBOUND_DB_RETRY_ATTEMPTS, OUTBOUND_DB_RETRY_MS } from '../constants.js';
import { pool } from '../db/pool.js';
import { AppError, notFound } from '../http.js';
import { integrations } from '../integrations/index.js';
import { logger } from '../logger.js';
import { audit } from './audit.js';
import * as gmail from './gmail.js';
import { addressOf } from './mime.js';
import { readStoredFile } from './storage.js';
export { MAX_ATTACHMENT_BYTES } from '../constants.js';

export const OUTBOUND_MODES = ['REPLY', 'REPLY_ALL', 'FORWARD'] as const;
export type OutboundMode = (typeof OUTBOUND_MODES)[number];

export interface OutboundInput {
  mode: OutboundMode;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  documentIds: string[];
  /** One per compose dialog (header Idempotency-Key or body field): a retry with it never sends a second email. */
  idempotencyKey?: string | null;
}

/**
 * Recipients whose domain is not in `allowed` (exact domain or a subdomain of it). An empty list allows every domain.
 * OUTBOUND_ALLOWED_DOMAINS keeps a typo or a pasted address from sending submission data outside the business.
 */
export function rejectedRecipients(addresses: string[], allowed: string[] = config.OUTBOUND_ALLOWED_DOMAINS): string[] {
  if (!allowed.length) return [];
  return addresses.filter((a) => {
    const domain = addressOf(a)?.split('@')[1]?.toLowerCase();
    return !domain || !allowed.some((d) => domain === d || domain.endsWith(`.${d}`));
  });
}

/**
 * Send a reply, reply-all or forward from the monitored mailbox and record it. Checks repeat the client's:
 * recipients (and the domain allowlist), document ownership, attachment size, Gmail connection. Replies stay in
 * the original Gmail thread.
 *
 * Idempotent (P2-05): the row is written PENDING before Gmail is called and marked SENT or FAILED after. A retry
 * with the same key returns the SENT row (`replayed`), is refused while the first attempt is PENDING, and only a
 * FAILED attempt is sent again. If recording SENT fails after Gmail accepted the message, the PENDING row keeps
 * everything that was sent, so the email is never lost or sent twice.
 */
export async function sendOutbound(submissionId: string, input: OutboundInput, actorId: string) {
  const {
    rows: [sub],
  } = await pool.query(
    `SELECT s.id, e.gmail_message_id, e.thread_id, e.rfc_message_id FROM submissions s JOIN emails e ON e.id=s.email_id
     WHERE s.id=$1 AND s.deleted_at IS NULL`,
    [submissionId],
  );
  if (!sub) throw notFound('Submission');

  const key = input.idempotencyKey?.trim() || null;
  let retryOf: string | null = null;
  if (key) {
    const earlier = await byKey(actorId, key);
    if (earlier) {
      const outcome = settled(earlier, submissionId);
      if (outcome) return outcome;
      retryOf = earlier.id; // FAILED: try again on the same row
    }
  }

  const invalid = [...input.to, ...input.cc, ...input.bcc].filter((a) => !addressOf(a) || /[\r\n]/.test(a));
  if (invalid.length)
    throw new AppError('INVALID_ADDRESS', 400, `Invalid email address: ${invalid.join(', ')}`, { invalid });
  if (!input.to.length) throw new AppError('VALIDATION_ERROR', 400, 'Add at least one recipient');
  const rejected = rejectedRecipients([...input.to, ...input.cc, ...input.bcc]);
  if (rejected.length) {
    const allowed = config.OUTBOUND_ALLOWED_DOMAINS;
    throw new AppError(
      'RECIPIENT_NOT_ALLOWED',
      400,
      `Mail can only be sent to ${allowed.join(', ')} addresses. Not allowed: ${rejected.join(', ')}`,
      { rejected, allowedDomains: allowed },
    );
  }

  const status = await integrations().gmail.status();
  if (!status.connected)
    throw new AppError('GMAIL_NOT_CONNECTED', 409, 'Gmail is not connected, so mail cannot be sent');

  const documentIds = [...new Set(input.documentIds)];
  const { rows: docs } = documentIds.length
    ? await pool.query('SELECT * FROM documents WHERE id = ANY($1::uuid[]) AND submission_id=$2', [
        documentIds,
        submissionId,
      ])
    : { rows: [] as any[] };
  if (docs.length !== documentIds.length) {
    throw new AppError('FOREIGN_DOCUMENT', 400, 'Only documents of this submission can be attached');
  }
  if (docs.length && status.source === 'MCP') {
    throw new AppError(
      'ATTACHMENTS_UNSUPPORTED',
      400,
      'Attachments cannot be sent when Gmail is connected through MCP',
    );
  }
  const totalBytes = docs.reduce((n, d) => n + Number(d.size_bytes), 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new AppError(
      'ATTACHMENTS_TOO_LARGE',
      400,
      `Attachments total ${(totalBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
      { totalBytes },
    );
  }
  const attachments = await Promise.all(
    docs.map(async (d) => ({ filename: d.filename, mimeType: d.mime_type, data: await readStoredFile(d) })),
  );

  // Claim the send: a new PENDING row, or the FAILED row of an earlier attempt with this key. Losing the race to a
  // concurrent request with the same key means that request sends; this one reports its outcome instead.
  const values = [
    submissionId,
    input.mode,
    input.to,
    input.cc,
    input.bcc,
    input.subject,
    input.body,
    documentIds,
    status.source,
  ];
  const {
    rows: [claimed],
  } = retryOf
    ? await pool.query(
        `UPDATE outbound_emails SET status='PENDING', error=NULL, mode=$2, to_addresses=$3, cc_addresses=$4, bcc_addresses=$5, subject=$6, body=$7,
         document_ids=$8, transport=$9, sent_at=now() WHERE id=$10 AND submission_id=$1 AND status='FAILED' RETURNING id`,
        [...values, retryOf],
      )
    : await pool.query(
        `INSERT INTO outbound_emails (submission_id, mode, to_addresses, cc_addresses, bcc_addresses, subject, body, document_ids, transport,
         sent_by, idempotency_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING')
       ON CONFLICT (sent_by, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
        [...values, actorId, key],
      );
  if (!claimed) {
    const other = key ? await byKey(actorId, key) : null;
    const outcome = other && settled(other, submissionId);
    if (outcome) return outcome;
    throw new AppError(
      'SEND_IN_PROGRESS',
      409,
      'This email is already being sent; check the sent emails before trying again',
    );
  }
  const id = claimed.id as string;

  // A reply threads only when the original came from Gmail; manual intake has no thread to join.
  const threaded = input.mode !== 'FORWARD' && !!sub.gmail_message_id;
  let sent: gmail.SentMessage;
  try {
    sent = await integrations().gmail.send({
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      body: input.body,
      attachments,
      threadId: threaded ? sub.thread_id : null,
      inReplyTo: threaded ? sub.rfc_message_id : null,
    });
  } catch (err) {
    await pool
      .query(`UPDATE outbound_emails SET status='FAILED', error=$2 WHERE id=$1`, [
        id,
        (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      ])
      .catch((e) => logger.error({ err: e, outboundId: id }, 'Could not mark an unsent email FAILED'));
    if (err instanceof gmail.GmailSendError) {
      throw new AppError(
        `GMAIL_${err.code === 'FAILED' ? 'SEND_FAILED' : err.code}`,
        err.code === 'FAILED' ? 502 : 409,
        err.message,
      );
    }
    throw err;
  }

  // Gmail accepted it: from here on nothing may fail the request (a retry would be refused, never re-sent).
  try {
    await withRetry(() =>
      pool.query(
        `UPDATE outbound_emails SET status='SENT', transport=$2, gmail_message_id=$3, gmail_thread_id=$4, sent_at=now() WHERE id=$1`,
        [id, sent.transport, sent.messageId, sent.threadId],
      ),
    );
    await audit({
      action: input.mode === 'FORWARD' ? 'EMAIL_FORWARDED' : 'EMAIL_REPLIED',
      entityType: 'outbound_email',
      entityId: id,
      submissionId,
      actorId,
      details: {
        mode: input.mode,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc.length,
        subject: input.subject,
        threaded,
        attachments: docs.map((d) => d.filename),
        transport: sent.transport,
        gmailMessageId: sent.messageId,
      },
    });
    const {
      rows: [full],
    } = await pool.query(`${OUTBOUND_SELECT} WHERE o.id=$1`, [id]);
    return { email: mapOutbound(full), replayed: false };
  } catch (err) {
    logger.error(
      { err, outboundId: id, submissionId, gmailMessageId: sent.messageId, to: input.to },
      'Email was sent but recording it failed; its row stays PENDING',
    );
    return {
      email: {
        id,
        mode: input.mode,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.body,
        documentIds,
        transport: sent.transport,
        gmailMessageId: sent.messageId,
        gmailThreadId: sent.threadId,
        status: 'SENT' as OutboundStatus,
        error: null,
        sentBy: { id: actorId, name: '' },
        sentAt: new Date().toISOString(),
      },
      replayed: false,
    };
  }
}

type OutboundStatus = 'PENDING' | 'SENT' | 'FAILED';

async function byKey(actorId: string, key: string) {
  const {
    rows: [r],
  } = await pool.query(`${OUTBOUND_SELECT} WHERE o.sent_by=$1 AND o.idempotency_key=$2`, [actorId, key]);
  return r as Record<string, any> | undefined;
}

/** The outcome of an earlier attempt with the same key, or null when that attempt FAILED and may be retried. */
function settled(r: Record<string, any>, submissionId: string) {
  if (r.submission_id !== submissionId) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'This idempotency key was already used for another submission');
  }
  if (r.status === 'SENT') return { email: mapOutbound(r), replayed: true };
  if (r.status === 'PENDING') {
    throw new AppError(
      'SEND_IN_PROGRESS',
      409,
      'This email is already being sent (or its result is unknown); check the sent emails before trying again',
    );
  }
  return null;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = OUTBOUND_DB_RETRY_ATTEMPTS): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, OUTBOUND_DB_RETRY_MS * i));
    }
  }
}

export const OUTBOUND_SELECT = `SELECT o.*, u.name AS sent_by_name FROM outbound_emails o JOIN users u ON u.id=o.sent_by`;

export function mapOutbound(r: any) {
  return {
    id: r.id,
    mode: r.mode,
    to: r.to_addresses,
    cc: r.cc_addresses,
    bcc: r.bcc_addresses,
    subject: r.subject,
    body: r.body,
    documentIds: r.document_ids,
    transport: r.transport,
    gmailMessageId: r.gmail_message_id,
    gmailThreadId: r.gmail_thread_id,
    status: (r.status ?? 'SENT') as OutboundStatus,
    error: r.error ?? null,
    sentBy: { id: r.sent_by, name: r.sent_by_name ?? '' },
    sentAt: new Date(r.sent_at).toISOString(),
  };
}
