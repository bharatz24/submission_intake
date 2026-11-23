import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import { config } from '../config.js';
import { MAX_LINKED_GAPS, PROCESSING_AUTO_RETRIES, PROCESSING_RETRY_BACKOFF_S } from '../constants.js';
import { LOCK_NAMESPACE } from '../db/advisoryLocks.js';
import { lockPool, pool, type Queryable, withTransaction } from '../db/pool.js';
import { integrations } from '../integrations/index.js';
import { logger } from '../logger.js';
import { automationSettings } from './appSettings.js';
import { audit, auditErrorText, recordSystemError } from './audit.js';
import { type ClassificationResult, classifyEmail, type ThreadEmail } from './classification.js';
import { emailSignals, type MessageSignals } from './classificationRules.js';
import { bumpContextVersion } from './contextVersion.js';
import {
  auditBasis,
  type DocRef,
  type DuplicateBasis,
  findDuplicate,
  type Fingerprints,
  fingerprints,
} from './duplicates.js';
import { verifyEvidence } from './evidence.js';
import { extractDocumentText } from './extractionPool.js';
import { extractFields, type Field, type SourceDoc, withUniqueLabels } from './fieldExtraction.js';
import { distinctValues, effectiveFields, pickBest, refreshApplicantName } from './fields.js';
import { byteLength, type FileBytes } from './fileBytes.js';
import { sniffFileType } from './fileType.js';
import { describeProcessingError } from './friendlyError.js';
import { rescanSubmission } from './injectionFlags.js';
import { currentJobSignal, jobLeaseLost } from './jobContext.js';
import { type JobAttempt, jobs } from './jobQueue.js';
import { newEmailEvent, publishNewEmail } from './notifications.js';
import {
  compareNpi,
  compareNpiToProviders,
  isValidNpi,
  type NpiClaim,
  type NpiResult,
  type NpiSearchClaim,
  type ProviderClaims,
  registryName,
  registryStructuredName,
  structureName,
  zip5,
} from './npi.js';
import { syncNpiRegistryFields } from './npiRegistryFields.js';
import { type PipelineProgress, type PipelineStep, readProgress, saveProgress } from './pipelineProgress.js';
import { startAutoReports } from './reports.js';
import {
  discardStoredFiles,
  type FileToStore,
  putDocumentFiles,
  type PutFile,
  readStoredFile,
  safeFilename,
} from './storage.js';
import { addZipCounties } from './zipCounty.js';

export interface IncomingAttachment {
  filename: string;
  mimeType: string;
  /** Gmail attachments arrive in memory; browser uploads are temporary files on disk (http.ts limitedUpload). */
  data: FileBytes;
}

export type GapReason = 'TOO_LARGE' | 'NO_CONTENT' | 'LINKED_FILE';

/** An attachment that cannot be stored for a reason retrying won't fix. Recorded on the submission, never dropped. */
export interface AttachmentGap {
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  reason: GapReason;
  detail: string | null;
}

export interface IncomingEmail {
  gmailMessageId: string | null;
  /** RFC 822 Message-ID header, when the source provides it. */
  rfcMessageId?: string | null;
  /** Headers and labels set by mail software (Auto-Submitted, List-Unsubscribe, Gmail category…), when available. */
  signals?: MessageSignals;
  threadId: string | null;
  fromAddress: string;
  toAddress: string;
  /** Cc header as received (comma-separated), so a reply can go to everyone; null when there was none. */
  ccAddress?: string | null;
  subject: string;
  bodyText: string;
  receivedAt: Date;
  attachments: IncomingAttachment[];
  /** Attachments the mail source could not deliver (over the size limit, no content returned). */
  gaps?: AttachmentGap[];
}

/** Drops NUL characters, which PostgreSQL text columns cannot store, from what an email stores as text. */
const stripNul = (s: string) => s.replaceAll('\u0000', '');
function withoutNul<T extends IncomingEmail>(email: T): T {
  return {
    ...email,
    fromAddress: stripNul(email.fromAddress),
    toAddress: stripNul(email.toAddress),
    ccAddress: email.ccAddress == null ? email.ccAddress : stripNul(email.ccAddress),
    subject: stripNul(email.subject),
    bodyText: stripNul(email.bodyText),
    attachments: email.attachments.map((a) => ({ ...a, filename: stripNul(a.filename) })),
    gaps: email.gaps?.map((g) => ({ ...g, filename: stripNul(g.filename) })),
  };
}

/**
 * Persist an email + attachments as a submission and queue processing, unless it repeats one already in the inbox.
 * Idempotent on gmailMessageId: returns the existing submission id if already ingested.
 *
 * Files are stored first and the rows committed after: network I/O never holds a DB connection, and a failed
 * upload leaves no rows behind (StorageError is thrown and the caller retries). When the commit fails, the
 * uploaded files are discarded.
 *
 * `classified` is a verdict reached before storing (ingestGmailEmail): it is saved with the rows and processing
 * skips classification, so the email is not classified twice.
 */
export async function ingestEmail(
  incoming: IncomingEmail,
  actorId: string | null,
  opts: { classified?: ClassificationResult; holdForImport?: boolean } = {},
): Promise<{ submissionId: string; created: boolean }> {
  // Mail can carry a NUL (a broken encoding); stored as-is it fails the insert, and the ingest queue retries forever.
  const email = withoutNul(incoming);
  if (email.gmailMessageId) {
    const existing = await ingestedSubmission(email.gmailMessageId);
    if (existing) return { submissionId: existing, created: false };
  }

  const submissionId = randomUUID();
  const { files, gaps } = prepareAttachments(email);
  const stored = await putDocumentFiles(submissionId, { label: email.subject, receivedAt: email.receivedAt }, files);
  const source = email.gmailMessageId ? 'EMAIL' : 'UPLOAD';
  try {
    await withTransaction(async (db) => {
      const {
        rows: [em],
      } = await db.query<{ id: string }>(
        `INSERT INTO emails (gmail_message_id, rfc_message_id, auto_submitted, list_unsubscribe, precedence, report_type, gmail_category,
                             thread_id, from_address, to_address, subject, snippet, body_text, received_at, cc_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [
          email.gmailMessageId,
          email.rfcMessageId?.trim() || null,
          email.signals?.autoSubmitted ?? null,
          email.signals?.listUnsubscribe ?? false,
          email.signals?.precedence ?? null,
          email.signals?.reportType ?? null,
          email.signals?.gmailCategory ?? null,
          email.threadId,
          email.fromAddress,
          email.toAddress,
          email.subject,
          email.bodyText.replace(/\s+/g, ' ').slice(0, 200),
          email.bodyText,
          email.receivedAt,
          email.ccAddress?.trim() || null,
        ],
      );
      await db.query('INSERT INTO submissions (id, email_id, drive_folder_id) VALUES ($1,$2,$3)', [
        submissionId,
        em!.id,
        stored.folderId,
      ]);
      await audit(
        {
          action: 'EMAIL_RECEIVED',
          entityType: 'email',
          entityId: em!.id,
          submissionId,
          actorId,
          // The email row is the reference; sender and subject are applicant data (DB-01).
          details: {
            source: email.gmailMessageId ? 'GMAIL' : 'MANUAL_UPLOAD',
            attachments: email.attachments.length,
            gaps: gaps.length,
          },
        },
        db,
      );
      for (const doc of stored.files) await addDocument(db, submissionId, doc, source, actorId);
      for (const gap of gaps) await addAttachmentGap(db, submissionId, gap, actorId);
      if (opts.classified) await saveClassification(db, submissionId, opts.classified);
      const isHeld = await checkDuplicate(db, submissionId, email, actorId);
      if (!isHeld && opts.holdForImport) {
        // Imported (Settings → Import older email): classified, but nothing else runs until a person presses Process.
        await db.query(`UPDATE submissions SET held_for_import=true, status='READY_FOR_REVIEW' WHERE id=$1`, [
          submissionId,
        ]);
        await audit(
          {
            action: 'PROCESSING_HELD',
            entityType: 'submission',
            entityId: submissionId,
            submissionId,
            actorId: null,
            details: { reason: 'imported' },
          },
          db,
        );
      } else if (!isHeld) {
        // In the same transaction: a committed submission always has its processing job.
        await enqueueProcessing(submissionId, actorId, { skipClassification: !!opts.classified }, db);
      }
      return isHeld;
    });
  } catch (err) {
    await discardStoredFiles(stored.files);
    // Push and poll ingesting the same message together: the loser hits emails.gmail_message_id UNIQUE.
    if (email.gmailMessageId && (err as { code?: string }).code === '23505') {
      const winner = await ingestedSubmission(email.gmailMessageId);
      if (winner) return { submissionId: winner, created: false };
    }
    throw err;
  }

  // Gmail ingestion has no actor; uploads (a person, or the Gmail connector run by one) never notify. Neither does
  // an import: it is past mail, possibly hundreds of emails at once.
  if (email.gmailMessageId && actorId === null && !opts.holdForImport) {
    void newEmailEvent(submissionId)
      .then((event) => event && publishNewEmail(event))
      .catch((err) => logger.warn({ err, submissionId }, 'new-email notification failed'));
  }
  return { submissionId, created: true };
}

/**
 * Automatic Gmail ingestion: classify first, store only what may be a submission. An email classified
 * NOT_SUBMISSION is never copied into the system (no rows, no Drive files); only a skipped_emails row records it.
 * SUBMISSION and REVIEW_REQUIRED are stored as usual, so a person still sees every email the check is unsure of.
 * A classification error is thrown before anything is stored, and the ingest queue retries the message later.
 */
export async function ingestGmailEmail(
  incoming: IncomingEmail & { gmailMessageId: string },
  opts: { imported?: boolean } = {},
): Promise<'CREATED' | 'EXISTING' | 'SKIPPED'> {
  const email = withoutNul(incoming);
  if (await ingestedSubmission(email.gmailMessageId)) return 'EXISTING';
  if (await isSkipped(email.gmailMessageId)) return 'SKIPPED';

  const { files, gaps } = prepareAttachments(email);
  const result = await classifyEmail(
    {
      fromAddress: email.fromAddress,
      subject: email.subject,
      bodyText: email.bodyText,
      // Files that could not be stored still count: an email whose only attachment was too large is not an empty email.
      attachmentNames: [...files, ...gaps].map((f) => f.filename),
      signals: email.signals,
      thread: await threadContext(null, email.threadId, email.receivedAt),
    },
    undefined,
    { reuse: true },
  );
  if (result.classification !== 'NOT_SUBMISSION') {
    return (await ingestEmail(email, null, { classified: result, holdForImport: opts.imported })).created
      ? 'CREATED'
      : 'EXISTING';
  }

  const { rowCount } = await pool.query(
    `INSERT INTO skipped_emails (gmail_message_id, thread_id, from_address, subject, received_at, attachment_count, confidence, reasons, method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (gmail_message_id) DO NOTHING`,
    [
      email.gmailMessageId,
      email.threadId,
      email.fromAddress,
      email.subject,
      email.receivedAt,
      files.length + gaps.length,
      result.confidence,
      result.reasons,
      result.method,
    ],
  );
  if (rowCount) {
    await audit({
      action: 'EMAIL_SKIPPED',
      entityType: 'gmail_message',
      entityId: email.gmailMessageId,
      actorId: null,
      // Sender, subject and the classifier's reasons stay on skipped_emails (purged by age), not in the audit trail.
      details: {
        attachments: files.length + gaps.length,
        confidence: result.confidence,
        method: result.method,
        reasonCount: result.reasons.length,
      },
    });
  }
  return 'SKIPPED';
}

/** An email skipped at intake, as the Ignored tab lists it (nothing else of it is stored). */
export interface SkippedEmail {
  gmailMessageId: string;
  threadId: string | null;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  attachmentCount: number;
  confidence: number;
  reasons: string[];
  method: string;
  skippedAt: string;
}

/** `q` as an ILIKE substring pattern, its wildcards escaped. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Emails skipped at intake and not deleted, newest first, matching `q` in the sender or subject. */
export async function listSkippedEmails(opts: {
  q?: string;
  limit: number;
  offset: number;
}): Promise<{ items: SkippedEmail[]; total: number }> {
  const where = `WHERE deleted_at IS NULL${opts.q ? ' AND (from_address ILIKE $1 OR subject ILIKE $1)' : ''}`;
  const params: (string | number)[] = opts.q ? [likePattern(opts.q)] : [];
  const page = `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const [
    { rows },
    {
      rows: [{ total }],
    },
  ] = await Promise.all([
    pool.query(`SELECT * FROM skipped_emails ${where} ORDER BY received_at DESC ${page}`, [
      ...params,
      opts.limit,
      opts.offset,
    ]),
    pool.query(`SELECT count(*)::int AS total FROM skipped_emails ${where}`, params),
  ]);
  return {
    total,
    items: rows.map((r) => ({
      gmailMessageId: r.gmail_message_id,
      threadId: r.thread_id,
      fromAddress: r.from_address,
      subject: r.subject,
      receivedAt: new Date(r.received_at).toISOString(),
      attachmentCount: r.attachment_count,
      confidence: r.confidence,
      reasons: r.reasons,
      method: r.method,
      skippedAt: new Date(r.skipped_at).toISOString(),
    })),
  };
}

/**
 * Delete (hide) skipped emails: the selected `ids`, otherwise every one matching `q`. The rows stay, so Gmail never
 * imports or classifies those messages again (ingestQueue.enqueueMessages); see migration 025.
 */
export async function deleteSkippedEmails(actorId: string, sel: { ids?: string[]; q?: string }): Promise<number> {
  const params: unknown[] = [actorId];
  const where = ['deleted_at IS NULL'];
  if (sel.ids) {
    params.push(sel.ids);
    where.push(`gmail_message_id = ANY($${params.length}::text[])`);
  } else if (sel.q) {
    params.push(likePattern(sel.q));
    where.push(`(from_address ILIKE $${params.length} OR subject ILIKE $${params.length})`);
  }
  return withTransaction(async (db) => {
    const { rows } = await db.query<{ gmail_message_id: string }>(
      `UPDATE skipped_emails SET deleted_at=now(), deleted_by=$1 WHERE ${where.join(' AND ')} RETURNING gmail_message_id`,
      params,
    );
    const details = sel.ids ? { bulk: sel.ids.length > 1 } : { bulk: true, ...(sel.q ? { q: sel.q } : {}) };
    for (const r of rows) {
      await audit(
        {
          action: 'SKIPPED_EMAIL_DELETED',
          entityType: 'gmail_message',
          entityId: r.gmail_message_id,
          actorId,
          details,
        },
        db,
      );
    }
    return rows.length;
  });
}

/**
 * A person overrides an intake skip ("Process as submission" on the Ignored tab): the email, fetched again from
 * Gmail, is stored as a SUBMISSION and processed, and its skipped_emails row goes. Returns the submission id.
 */
export async function ingestSkippedEmail(
  email: IncomingEmail & { gmailMessageId: string },
  actor: { id: string; name: string },
): Promise<string> {
  const {
    rows: [skip],
  } = await pool.query('SELECT reasons, method FROM skipped_emails WHERE gmail_message_id=$1', [email.gmailMessageId]);
  const reason = 'Processed as a submission from the Ignored tab';
  const { submissionId } = await ingestEmail(email, actor.id, {
    classified: {
      classification: 'SUBMISSION',
      confidence: 1,
      method: skip?.method ?? 'RULES',
      reasons: [...(skip?.reasons ?? []), `Manual override by ${actor.name}: ${reason}`],
    },
  });
  await pool.query('DELETE FROM skipped_emails WHERE gmail_message_id=$1', [email.gmailMessageId]);
  await audit({
    action: 'CLASSIFICATION_OVERRIDDEN',
    entityType: 'submission',
    entityId: submissionId,
    submissionId,
    actorId: actor.id,
    details: {
      from: 'NOT_SUBMISSION',
      to: 'SUBMISSION',
      reason,
      skippedAtIntake: true,
      gmailMessageId: email.gmailMessageId,
    },
  });
  return submissionId;
}

async function isSkipped(gmailMessageId: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM skipped_emails WHERE gmail_message_id=$1', [gmailMessageId]);
  return !!rowCount;
}

async function saveClassification(
  db: Queryable,
  submissionId: string,
  result: Omit<ClassificationResult, 'method'> & { method: string },
): Promise<void> {
  await db.query(
    'UPDATE submissions SET classification=$2, classification_confidence=$3, classification_reasons=$4, updated_at=now() WHERE id=$1',
    [submissionId, result.classification, result.confidence, result.reasons],
  );
  await audit(
    {
      action: 'EMAIL_CLASSIFIED',
      entityType: 'submission',
      entityId: submissionId,
      submissionId,
      actorId: null,
      details: { classification: result.classification, confidence: result.confidence, method: result.method },
    },
    db,
  );
}

async function ingestedSubmission(gmailMessageId: string): Promise<string | null> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    'SELECT s.id FROM submissions s JOIN emails e ON e.id=s.email_id WHERE e.gmail_message_id=$1',
    [gmailMessageId],
  );
  return row?.id ?? null;
}

// Files over Gmail's 25 MB limit arrive as links in the body instead of attachments.
const DRIVE_LINK = /https?:\/\/(?:drive|docs)\.google\.com\/[^\s<>"'()[\]]+/gi;

/** Split an email's attachments into files to store and gaps to record (oversize files, Drive/Docs links). */
export function prepareAttachments(email: Pick<IncomingEmail, 'attachments' | 'gaps' | 'bodyText'>): {
  files: FileToStore[];
  gaps: AttachmentGap[];
} {
  const files: FileToStore[] = [];
  const gaps: AttachmentGap[] = [...(email.gaps ?? [])];
  for (const att of email.attachments) {
    const filename = safeFilename(att.filename);
    const mimeType = att.mimeType || 'application/octet-stream';
    if (byteLength(att.data) > config.ATTACHMENT_MAX_BYTES) {
      gaps.push({
        filename,
        mimeType,
        sizeBytes: byteLength(att.data),
        reason: 'TOO_LARGE',
        detail: `Larger than the ${Math.round(config.ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB limit`,
      });
      continue;
    }
    files.push({ documentId: randomUUID(), filename, mimeType, data: att.data });
  }
  const links = [...new Set([...email.bodyText.matchAll(DRIVE_LINK)].map((m) => m[0].replace(/[.,;:!?]+$/, '')))];
  for (const url of links.slice(0, MAX_LINKED_GAPS)) {
    gaps.push({
      filename: /docs\.google\.com/i.test(url) ? 'Google Docs link' : 'Google Drive link',
      mimeType: null,
      sizeBytes: null,
      reason: 'LINKED_FILE',
      detail: url,
    });
  }
  return { files, gaps };
}

// Any constant works; every ingest only has to take the same one.
const DUPLICATE_LOCK = 7_007_001;

/**
 * Fingerprint a new submission and hold it back when it repeats one already in the inbox: status DUPLICATE,
 * or NOT_SUBMISSION when it certainly repeats an ignored email. Returns true when held (no classification, no processing).
 */
async function checkDuplicate(
  db: pg.PoolClient,
  submissionId: string,
  email: IncomingEmail,
  actorId: string | null,
): Promise<boolean> {
  const { rows: docs } = await db.query<DocRef>(
    'SELECT filename, mime_type AS "mimeType", size_bytes AS "sizeBytes", sha256 FROM documents WHERE submission_id=$1',
    [submissionId],
  );
  const fp = fingerprints(email, docs);
  await saveFingerprints(db, submissionId, fp);
  if (!config.DUPLICATE_DETECTION) return false;

  // Serializes the check across ingests: of two identical emails arriving together, the first committed is the original.
  await db.query('SELECT pg_advisory_xact_lock($1)', [DUPLICATE_LOCK]);
  const found = await findDuplicate(db, {
    submissionId,
    rfcMessageId: email.rfcMessageId?.trim() || null,
    receivedAt: email.receivedAt,
    fingerprints: fp,
    docs,
  });
  if (!('original' in found)) return false;
  const { original, basis } = found;
  if (original.status === 'NOT_SUBMISSION' && basis.strength === 'POSSIBLE') {
    // Only resembles an ignored email: not enough to ignore it unseen, so it is classified on its own content.
    await audit(
      {
        action: 'DUPLICATE_SUSPECTED',
        entityType: 'submission',
        entityId: submissionId,
        submissionId,
        actorId,
        details: { ...auditBasis(basis), outcome: 'CLASSIFY' },
      },
      db,
    );
    return false;
  }
  const ignored = original.status === 'NOT_SUBMISSION';
  if (ignored) {
    await db.query(
      `UPDATE submissions SET status='NOT_SUBMISSION', classification='NOT_SUBMISSION', duplicate_basis=$2,
         classification_confidence=(SELECT classification_confidence FROM submissions WHERE id=$3),
         classification_reasons=$4, updated_at=now() WHERE id=$1`,
      [submissionId, JSON.stringify(basis), original.id, [`Repeat of an ignored email. ${basis.explanation}`]],
    );
  } else {
    await db.query(
      `UPDATE submissions SET status='DUPLICATE', duplicate_of=$2, duplicate_basis=$3, updated_at=now() WHERE id=$1`,
      [submissionId, original.id, JSON.stringify(basis)],
    );
  }
  await audit(
    {
      action: 'DUPLICATE_DETECTED',
      entityType: 'submission',
      entityId: submissionId,
      submissionId,
      actorId,
      details: { ...auditBasis(basis), outcome: ignored ? 'NOT_SUBMISSION' : 'DUPLICATE' },
    },
    db,
  );
  return true;
}

/**
 * Copies held back while their original was still being classified, now that it was ignored: they get the verdict
 * a repeat of an ignored email gets at ingest. CERTAIN/HIGH matches are ignored too; POSSIBLE ones are released and
 * classified on their own content. Copies a person marked by hand are left alone.
 */
async function settleRepeatsOfIgnored(originalId: string): Promise<void> {
  const released = await withTransaction(async (db) => {
    // The same lock as checkDuplicate, so a copy being held back at this moment is settled too, not missed.
    await db.query('SELECT pg_advisory_xact_lock($1)', [DUPLICATE_LOCK]);
    const { rows: ignored } = await db.query<{ id: string; duplicate_basis: DuplicateBasis }>(
      `UPDATE submissions c SET status='NOT_SUBMISSION', classification='NOT_SUBMISSION', duplicate_of=NULL,
         classification_confidence=o.classification_confidence,
         classification_reasons=ARRAY['Repeat of an ignored email. ' || COALESCE(c.duplicate_basis->>'explanation', '')],
         updated_at=now()
       FROM submissions o
       WHERE o.id=$1 AND c.duplicate_of=$1 AND c.duplicate_basis->>'method'='AUTO' AND c.duplicate_basis->>'strength' IN ('CERTAIN','HIGH')
       RETURNING c.id, c.duplicate_basis`,
      [originalId],
    );
    const { rows: possible } = await db.query<{ id: string; duplicate_basis: DuplicateBasis }>(
      `WITH p AS (SELECT id, duplicate_basis FROM submissions
                   WHERE duplicate_of=$1 AND duplicate_basis->>'method'='AUTO' AND duplicate_basis->>'strength'='POSSIBLE' FOR UPDATE)
       UPDATE submissions s SET status='NEW', duplicate_of=NULL, duplicate_basis=NULL, updated_at=now()
       FROM p WHERE s.id=p.id RETURNING s.id, p.duplicate_basis`,
      [originalId],
    );
    for (const [rows, outcome] of [
      [ignored, 'NOT_SUBMISSION'],
      [possible, 'CLASSIFY'],
    ] as const) {
      for (const r of rows) {
        await audit(
          {
            action: 'DUPLICATE_CLEARED',
            entityType: 'submission',
            entityId: r.id,
            submissionId: r.id,
            actorId: null,
            details: {
              originalId,
              previousBasis: auditBasis(r.duplicate_basis),
              reason: 'The original was classified as ignored',
              outcome,
            },
          },
          db,
        );
      }
    }
    return possible.map((r) => r.id);
  });
  for (const id of released) await enqueueProcessing(id, null);
}

export async function saveFingerprints(db: Queryable, submissionId: string, fp: Fingerprints): Promise<void> {
  await db.query(
    `UPDATE submissions SET content_fingerprint=$2, attachment_fingerprint=$3, normalized_subject=$4, body_fingerprint=$5,
       body_tail_fingerprint=$6 WHERE id=$1`,
    [
      submissionId,
      fp.contentFingerprint,
      fp.attachmentFingerprint,
      fp.normalizedSubject,
      fp.bodyFingerprint,
      fp.bodyTailFingerprint,
    ],
  );
}

/** Insert the row for a file already stored by putDocumentFiles. No I/O besides the database. */
export async function addDocument(
  db: Queryable,
  submissionId: string,
  doc: PutFile,
  source: 'EMAIL' | 'UPLOAD',
  actorId: string | null,
) {
  await db.query(
    `INSERT INTO documents (id, submission_id, filename, mime_type, detected_type, size_bytes, sha256, storage_key, storage_backend, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      doc.documentId,
      submissionId,
      doc.filename,
      doc.mimeType,
      doc.detectedType,
      doc.sizeBytes,
      doc.sha256,
      doc.storageKey,
      doc.storageBackend,
      source,
    ],
  );
  await audit(
    {
      action: 'DOCUMENT_STORED',
      entityType: 'document',
      entityId: doc.documentId,
      submissionId,
      actorId,
      details: {
        sha256: doc.sha256,
        sizeBytes: doc.sizeBytes,
        backend: doc.storageBackend,
        declaredType: doc.mimeType,
        detectedType: doc.detectedType,
      },
    },
    db,
  );
  return doc.documentId;
}

async function addAttachmentGap(db: Queryable, submissionId: string, gap: AttachmentGap, actorId: string | null) {
  const {
    rows: [row],
  } = await db.query<{ id: string }>(
    `INSERT INTO attachment_gaps (submission_id, filename, mime_type, size_bytes, reason, detail)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [submissionId, gap.filename, gap.mimeType, gap.sizeBytes, gap.reason, gap.detail],
  );
  await audit(
    {
      action: 'ATTACHMENT_NOT_STORED',
      entityType: 'attachment_gap',
      entityId: row!.id,
      submissionId,
      actorId,
      details: { reason: gap.reason, sizeBytes: gap.sizeBytes },
    },
    db,
  );
}

/**
 * Documents an underwriter adds to an existing submission. Stored first (all or nothing), recorded, then text is
 * extracted in the background and a new context version recorded. Fields are not re-extracted: "Re-run extraction"
 * does that, so adding a file never spends Claude tokens unasked.
 */
export async function addUploadedDocuments(
  submissionId: string,
  attachments: IncomingAttachment[],
  actorId: string,
): Promise<string[]> {
  const {
    rows: [sub],
  } = await pool.query(
    'SELECT s.drive_folder_id, e.subject, e.received_at FROM submissions s JOIN emails e ON e.id=s.email_id WHERE s.id=$1',
    [submissionId],
  );
  if (!sub) throw new Error(`Submission ${submissionId} not found`);
  const files: FileToStore[] = attachments.map((a) => ({
    documentId: randomUUID(),
    filename: safeFilename(a.filename),
    mimeType: a.mimeType || 'application/octet-stream',
    data: a.data,
  }));
  const stored = await putDocumentFiles(
    submissionId,
    { label: sub.subject, receivedAt: new Date(sub.received_at) },
    files,
  );
  try {
    await withTransaction(async (db) => {
      for (const doc of stored.files) await addDocument(db, submissionId, doc, 'UPLOAD', actorId);
      if (stored.folderId && !sub.drive_folder_id) {
        await db.query('UPDATE submissions SET drive_folder_id=$2, updated_at=now() WHERE id=$1', [
          submissionId,
          stored.folderId,
        ]);
      }
    });
  } catch (err) {
    await discardStoredFiles(stored.files);
    throw err;
  }
  const ids = stored.files.map((f) => f.documentId);
  // Keyed by this upload's first document, so a second upload is never dropped as a duplicate job.
  await jobs.enqueue('extract', `extract:${submissionId}:${ids[0]}`, { submissionId, documentIds: ids, actorId });
  return ids;
}

/**
 * Queue processing; false when it is already queued or running (the running pass reads the current state).
 * `byPerson`: someone clicked a button (re-run, classification override, duplicate release), so every step runs in
 * full whatever Settings → Automation says. Otherwise (a new email, startup recovery) the settings decide.
 * `resume`: skip the steps the last run completed (submissions.pipeline_progress) and continue from the failed one;
 * otherwise the run starts over and clears that progress.
 */
export function enqueueProcessing(
  submissionId: string,
  actorId: string | null,
  opts: { skipClassification?: boolean; byPerson?: boolean; resume?: boolean } = {},
  db?: Queryable,
): Promise<boolean> {
  return jobs.enqueue(
    'process',
    `process:${submissionId}`,
    {
      submissionId,
      actorId,
      skipClassification: opts.skipClassification,
      byPerson: opts.byPerson,
      resume: opts.resume,
    },
    { db },
  );
}

/**
 * "Retry from failed step" (POST /submissions/:id/retry, Errors tab "Retry all"): a resumed run, by a person. Like
 * "Re-run" (POST /reprocess) it is byPerson, so the steps it does run in full whatever Settings → Automation says;
 * unlike it, finished steps and successfully read documents are kept. False when a run is already queued.
 * A failed submission shows as processing at once (it leaves the Errors tab), not only when a worker takes the job.
 */
export async function retryProcessing(submissionId: string, actorId: string): Promise<boolean> {
  try {
    return await withTransaction(async (db) => {
      await db.query(
        `UPDATE submissions SET status=CASE WHEN status='ERROR' THEN 'PROCESSING' ELSE status END,
           processing_error=NULL, processing_error_detail=NULL,
           pipeline_progress=pipeline_progress || '{"failedStep": null, "autoRetrying": false}'::jsonb, updated_at=now()
         WHERE id=$1`,
        [submissionId],
      );
      if (
        !(await enqueueProcessing(
          submissionId,
          actorId,
          { skipClassification: true, byPerson: true, resume: true },
          db,
        ))
      ) {
        throw new AlreadyQueued();
      }
      return true;
    });
  } catch (err) {
    if (err instanceof AlreadyQueued) return false;
    throw err;
  }
}
/**
 * Flag instruction-like text in the email and attachments (services/injectionFlags.ts). Detection never blocks a
 * submission: a failure is logged and recorded on Monitoring, and processing carries on.
 */
async function scanForInjectionSafely(submissionId: string): Promise<void> {
  try {
    const flags = await rescanSubmission(submissionId);
    if (flags.length) logger.warn({ submissionId, flags: flags.length }, 'instruction-like text found in submission');
  } catch (err) {
    logger.warn({ err, submissionId }, 'injection scan failed; processing continues');
    await recordSystemError(`injection-scan:${submissionId}`, err);
  }
}

/** Rolls retryProcessing's status change back when a run is already queued. */
class AlreadyQueued extends Error {}

// processSubmission records its own failures (status ERROR). A short-lived one (Claude overloaded, a timeout…) is
// rethrown while attempts are left, so the queue runs it again after a backoff (30 s, 60 s); every later attempt
// (that retry, or a run taken over after its worker died) resumes from the progress. Escaped errors (a lost DB) retry too.
// The lease signal stops the run between steps; Claude calls and document parsing inside a step read it from
// jobContext.ts and stop too, once another worker has taken the job over.
jobs.register(
  'process',
  ({ submissionId, actorId, skipClassification, byPerson, resume, external }, signal, job) =>
    processSubmission(submissionId, actorId, {
      skipClassification,
      byPerson,
      external,
      resume: resume || job.attempt > 1,
      attempt: job,
      signal,
    }),
  { maxAttempts: 1 + PROCESSING_AUTO_RETRIES, backoffBaseS: PROCESSING_RETRY_BACKOFF_S },
);
// Only PENDING documents are read, so a retry after a crash picks up where the last attempt stopped.
jobs.register('extract', async ({ submissionId, documentIds, actorId, bumpContext }) => {
  await extractPendingText(submissionId, documentIds);
  await scanForInjectionSafely(submissionId);
  if (bumpContext !== false) await bumpContextVersion(submissionId, 'Documents uploaded', actorId);
});

/**
 * Queue a run with classification and fields produced outside the portal (POST /external-results), under the same
 * key as any other run, so it never runs alongside one. False when a run is already queued.
 */
export function enqueueExternalResults(
  submissionId: string,
  actorId: string,
  external: ExternalResults,
  db?: Queryable,
): Promise<boolean> {
  return jobs.enqueue(
    'process',
    `process:${submissionId}`,
    { submissionId, actorId, external, byPerson: true },
    { db },
  );
}

/** Key of the background read behind POST /extract-text (external processing export). */
export const textExportKey = (submissionId: string) => `extract-export:${submissionId}`;

/**
 * POST /extract-text: read the submission's PENDING documents in the background. One attempt: a file that cannot be
 * read (e.g. missing from Drive) is reported by GET /extract-text rather than retried. False when already queued.
 */
export function enqueueTextExport(submissionId: string, actorId: string): Promise<boolean> {
  return jobs.enqueue(
    'extract',
    textExportKey(submissionId),
    { submissionId, actorId, bumpContext: false },
    { maxAttempts: 1 },
  );
}

/**
 * Startup recovery: submissions left NEW/PROCESSING without a queued or running job (e.g. ingested before the
 * durable queue existed) are queued again. Classification already done is kept, so an override survives, and the
 * run resumes after the steps already completed.
 */
export async function requeueStalledSubmissions(): Promise<number> {
  const { rows } = await pool.query<{ id: string; classified: boolean }>(
    `SELECT s.id, s.classification IS NOT NULL AS classified FROM submissions s
     WHERE s.status IN ('NEW', 'PROCESSING') AND s.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key='process:' || s.id AND j.status IN ('queued', 'running'))`,
  );
  let n = 0;
  for (const r of rows)
    if (await enqueueProcessing(r.id, null, { skipClassification: r.classified, resume: true })) n++;
  if (n) logger.warn({ requeued: n }, 'requeued submissions left unprocessed by a previous run');
  return n;
}

/** Classification + fields produced outside the portal (e.g. by the Claude CLI) instead of the API. */
export interface ExternalResults {
  classification: 'SUBMISSION' | 'NOT_SUBMISSION' | 'REVIEW_REQUIRED';
  confidence: number;
  reasons: string[];
  fields: Omit<Field, 'documentId'>[];
}

/** Local-only document text extraction (no API): fills extracted_text for PENDING documents (only `documentIds` when given). */
export async function extractPendingText(submissionId: string, documentIds?: string[]): Promise<void> {
  const { rows: pending } = await pool.query(
    `SELECT * FROM documents WHERE submission_id=$1 AND extraction_status=$2 AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
    [submissionId, 'PENDING', documentIds ?? null],
  );
  for (const doc of pending) {
    currentJobSignal()?.throwIfAborted(); // the job was taken over: its new owner reads the rest
    const data = await readStoredFile(doc);
    const r = await extractDocumentText(data, { documentId: doc.id, filename: doc.filename, mimeType: doc.mime_type });
    // An OCR worker timeout/crash says nothing about the file: it stays PENDING, so the next run reads it again.
    const status = r.transient ? 'PENDING' : r.status;
    // Files stored before content sniffing get their detected type the first time they are read.
    await pool.query(
      `UPDATE documents SET extraction_status=$2, extracted_text=$3, ocr_used=$4, page_count=$5,
         detected_type=COALESCE(detected_type, $6) WHERE id=$1`,
      [doc.id, status, r.text, r.ocrUsed, r.pageCount, sniffFileType(data)],
    );
    await audit({
      action: 'DOCUMENT_EXTRACTED',
      entityType: 'document',
      entityId: doc.id,
      submissionId,
      actorId: null,
      details: {
        status,
        ocrUsed: r.ocrUsed,
        chars: r.text.length,
        error: r.error,
        ...(r.transient ? { retryable: true } : {}),
      },
    });
  }
}

type ProcessOptions = {
  skipClassification?: boolean;
  external?: ExternalResults;
  byPerson?: boolean;
  /** Skip the steps the last run completed; otherwise the progress is cleared and every step runs. */
  resume?: boolean;
  /** The job attempt running this (none inline): a short-lived failure is retried while attempts are left. */
  attempt?: JobAttempt;
  /** The job's lease signal (none inline): checked between steps, so a run taken over by another worker stops. */
  signal?: AbortSignal;
};

/** Statuses an underwriter put the submission in: a re-run refreshes the evidence but leaves them as they are. */
const DECIDED_STATUSES = new Set(['IN_REVIEW', 'COMPLETED']);

/**
 * Process one submission. Runs are serialized per submission (the job queue runs one per key, and direct callers
 * such as tests do not) by a session advisory lock on a connection of the lock pool, so a long run never pins an
 * application connection; a second caller waits for the first.
 */
export async function processSubmission(
  submissionId: string,
  actorId: string | null,
  opts: ProcessOptions = {},
): Promise<void> {
  const lock = await lockPool.connect();
  const key = submissionId;
  let locked = false;
  let broken = false;
  try {
    // Two-key lock in the pipeline's own namespace (db/advisoryLocks.ts), apart from every single-key lock.
    await lock.query('SELECT pg_advisory_lock($1, hashtext($2))', [LOCK_NAMESPACE.processSubmission, key]);
    locked = true;
    await processLocked(submissionId, actorId, opts);
  } finally {
    // A connection that could not unlock is destroyed, so the lock never lingers in the pool.
    if (locked)
      await lock
        .query('SELECT pg_advisory_unlock($1, hashtext($2))', [LOCK_NAMESPACE.processSubmission, key])
        .catch(() => {
          broken = true;
        });
    lock.release(broken);
  }
}

async function processLocked(submissionId: string, actorId: string | null, opts: ProcessOptions): Promise<void> {
  const {
    rows: [sub],
  } = await pool.query(
    `SELECT s.*, e.from_address, e.subject, e.body_text, e.thread_id, e.received_at,
            e.auto_submitted, e.list_unsubscribe, e.precedence, e.report_type, e.gmail_category
     FROM submissions s JOIN emails e ON e.id=s.email_id WHERE s.id=$1`,
    [submissionId],
  );
  // Duplicates are held back until a person releases them (POST /submissions/:id/duplicate); deleted ones are gone.
  if (!sub || sub.deleted_at || sub.status === 'DUPLICATE') return;
  // A submission already in review or completed keeps that status: its evidence is refreshed, it is not reopened,
  // and no automatic reports are started for it (the underwriter runs them).
  const decided: string | null = DECIDED_STATUSES.has(sub.status) ? sub.status : null;
  // A resumed run skips what the last one completed (classification kept); any other run starts over.
  const resume = Boolean(opts.resume) && !opts.external;
  const progress: PipelineProgress = {
    completedSteps: resume ? readProgress(sub.pipeline_progress).completedSteps : [],
    failedStep: null,
    autoRetrying: false,
  };
  const done = (s: PipelineStep) => progress.completedSteps.includes(s);
  const complete = async (s: PipelineStep) => {
    if (!done(s)) progress.completedSteps.push(s);
    await saveProgress(submissionId, progress);
  };
  const keepClassification = opts.skipClassification || (done('classification') && sub.classification);
  // An ignored email is never processed by a re-run or a release: only a classification override changes its verdict.
  if (!opts.external && keepClassification && sub.classification === 'NOT_SUBMISSION') {
    await setStatus(submissionId, 'NOT_SUBMISSION', null);
    return;
  }
  // The run in progress: no failed step, no retry waiting (and, for a full run, nothing completed yet).
  await saveProgress(submissionId, progress);
  // Any run (Process, a re-run, a classification override) releases an imported email held for Process.
  await pool.query('UPDATE submissions SET held_for_import=false WHERE id=$1 AND held_for_import', [submissionId]);
  let step: PipelineStep = 'classification';
  try {
    // Settings → Automation only govern automatic runs: a person's re-run does every step, which is what the button promises.
    const settings = await automationSettings();
    const runs = (step: 'classification' | 'fieldExtraction' | 'npiVerification') =>
      Boolean(opts.byPerson) || settings[step] === 'AUTO';
    // 1. Classification
    if (opts.external || !keepClassification || !sub.classification) {
      // Files that could not be stored still count: an email whose only attachment was too large is not an empty email.
      const { rows: docs } = await pool.query<{ filename: string }>(
        'SELECT filename FROM documents WHERE submission_id=$1 UNION ALL SELECT filename FROM attachment_gaps WHERE submission_id=$1',
        [submissionId],
      );
      const result = opts.external
        ? {
            classification: opts.external.classification,
            confidence: opts.external.confidence,
            reasons: opts.external.reasons,
            method: 'EXTERNAL',
          }
        : await classifyEmail(
            {
              fromAddress: sub.from_address,
              subject: sub.subject,
              bodyText: sub.body_text,
              attachmentNames: docs.map((d) => d.filename),
              signals: emailSignals(sub),
              thread: await threadContext(submissionId, sub.thread_id, sub.received_at),
            },
            submissionId,
            { useLlm: runs('classification'), reuse: !opts.byPerson },
          );
      await saveClassification(pool, submissionId, result);
      await complete('classification');
      if (result.classification === 'NOT_SUBMISSION') {
        await setStatus(submissionId, 'NOT_SUBMISSION', null);
        await setHeld(submissionId, false);
        await settleRepeatsOfIgnored(submissionId);
        return;
      }
      // Manual classification and an uncertain email: held for a person's verdict. The documents are still read (no
      // Claude call), but fields, NPI, the context version and the automatic reports wait for the override
      // (POST /submissions/:id/classification) or a person's re-run.
      if (
        result.classification === 'REVIEW_REQUIRED' &&
        !opts.byPerson &&
        !opts.external &&
        settings.classification === 'MANUAL'
      ) {
        step = 'documents';
        await extractPendingText(submissionId);
        await scanForInjectionSafely(submissionId);
        await complete('documents');
        await setHeld(submissionId, true);
        await setStatus(submissionId, decided ?? 'READY_FOR_REVIEW', null);
        await audit({
          action: 'PROCESSING_HELD',
          entityType: 'submission',
          entityId: submissionId,
          submissionId,
          actorId: null,
          details: { reason: 'classification manual' },
        });
        return;
      }
    } else {
      // Kept from an earlier run (or a verdict reached before storing).
      await complete('classification');
    }

    if (!decided) await setStatus(submissionId, 'PROCESSING', null);

    // 2. Attachment processing (only documents not yet extracted; a resumed run also reads again those that failed)
    opts.signal?.throwIfAborted();
    step = 'documents';
    if (!done('documents')) {
      if (resume)
        await pool.query(
          `UPDATE documents SET extraction_status='PENDING' WHERE submission_id=$1 AND extraction_status='ERROR'`,
          [submissionId],
        );
      await extractPendingText(submissionId);
      await complete('documents');
    }
    // Every run rescans (cheap, no LLM): the body and every document's text as they are now.
    await scanForInjectionSafely(submissionId);

    // 3. Field extraction with evidence across email body + all readable documents
    opts.signal?.throwIfAborted();
    step = 'fields';
    if (!done('fields')) {
      const { rows: allDocs } = await pool.query(
        'SELECT id, filename, extracted_text, ocr_used FROM documents WHERE submission_id=$1 ORDER BY created_at',
        [submissionId],
      );
      // Labels made unique, so two attachments with the same filename map evidence to the right documentId (an external
      // result citing the bare filename gets the first copy, which keeps the bare name).
      const sources: SourceDoc[] = withUniqueLabels([
        {
          documentId: null,
          label: 'email body',
          text: `Subject: ${sub.subject}\nFrom: ${sub.from_address}\n\n${sub.body_text}`,
          ocrUsed: false,
        },
        ...allDocs.map((d) => ({ documentId: d.id, label: d.filename, text: d.extracted_text, ocrUsed: d.ocr_used })),
      ]);
      const byLabel = new Map(sources.map((s) => [s.label, s]));
      // Manual extraction: nothing is extracted when the email arrives; "Re-run extraction + NPI" on the submission does it.
      // A county the documents don't state is looked up from the practice ZIP (labelled as a ZIP lookup, never as a quote).
      const extracts = Boolean(opts.external) || runs('fieldExtraction');
      const extracted: Field[] = opts.external
        ? opts.external.fields.map((f) => ({ ...f, documentId: byLabel.get(f.sourceLabel)?.documentId ?? null }))
        : extracts
          ? await extractFields(sources, submissionId)
          : [];
      // Every evidence quote is checked against the text it claims to come from (services/evidence.ts); the ZIP
      // county lookups added after are derived, not quoted, and stay unchecked.
      const verified = verifyEvidence(extracted, sources);
      const unverified = verified.filter((f) => f.evidenceVerified === false).length;
      if (unverified)
        logger.warn(
          { submissionId, unverified, total: verified.length },
          'extracted fields with evidence not found in the source',
        );
      const fields = await addZipCounties(verified);
      const nextFieldVersion = sub.context_version + 1;
      await withTransaction(async (db) => {
        // One statement for every field (DB-13), in extraction order.
        if (fields.length)
          await db.query(
            `INSERT INTO extracted_fields (submission_id, document_id, field_name, value, confidence, evidence_quote, source_label, context_version, evidence_verified)
             SELECT $1, f.document_id, f.field_name, f.value, f.confidence, f.evidence_quote, f.source_label, $2, f.evidence_verified
             FROM jsonb_to_recordset($3::jsonb) AS f(document_id uuid, field_name text, value text, confidence real,
                  evidence_quote text, source_label text, evidence_verified boolean)`,
            [
              submissionId,
              nextFieldVersion,
              JSON.stringify(
                fields.map((f) => ({
                  document_id: f.documentId,
                  field_name: f.fieldName,
                  value: f.value,
                  confidence: f.confidence,
                  evidence_quote: f.evidenceQuote,
                  source_label: f.sourceLabel,
                  evidence_verified: 'evidenceVerified' in f ? f.evidenceVerified : null,
                })),
              ),
            ],
          );
        // Manual entries outrank the new extraction, so a corrected applicant name survives reprocessing.
        await refreshApplicantName(submissionId, db);
        // With the rows, so a resumed run never inserts the same fields twice. Skipped (manual) is not completed.
        if (extracts)
          await saveProgress(submissionId, { ...progress, completedSteps: [...progress.completedSteps, 'fields'] }, db);
      });
      if (extracts) progress.completedSteps.push('fields');
      await audit({
        action: 'FIELDS_EXTRACTED',
        entityType: 'submission',
        entityId: submissionId,
        submissionId,
        actorId: null,
        details: { count: fields.length, unverifiedEvidence: unverified, ...(extracts ? {} : { skipped: 'MANUAL' }) },
      });
    }

    // 4. NPI verification: by number for every distinct NPI found, otherwise by name + ZIP registry search.
    //    Manual: not on arrival; "Re-verify" on the NPI tab (or a re-run) does it.
    opts.signal?.throwIfAborted();
    step = 'npi';
    if (!done('npi') && runs('npiVerification')) {
      await verifySubmissionNpis(submissionId, await effectiveFields(submissionId), null);
      await complete('npi');
    }

    // 5. New context version + ready for review
    opts.signal?.throwIfAborted();
    await bumpContextVersion(
      submissionId,
      sub.context_version === 0 ? 'Initial processing' : 'Reprocessed evidence',
      actorId,
    );
    await setStatus(submissionId, decided ?? 'READY_FOR_REVIEW', null);
    await setHeld(submissionId, false);

    // 6. Synthesis Report, then Underwriting Analysis (queued; failures are recorded on the report rows)
    if (!decided)
      await startAutoReports(submissionId).catch((err) => recordSystemError(`auto-reports:${submissionId}`, err));
  } catch (err) {
    if (jobLeaseLost()) throw err; // another worker owns the job now and records its outcome
    // processing_error gets plain words for underwriters; the raw text goes to processing_error_detail, the log,
    // the audit trail and (once no automatic retry is left) Monitoring.
    const failure = describeProcessingError(err);
    const retrying = failure.transient && !!opts.attempt && opts.attempt.attempt < opts.attempt.maxAttempts;
    // Status, message and progress together, so a reader never sees the failed step without its message.
    const recordFailure = (status: string) =>
      pool.query(
        `UPDATE submissions SET status=$2, processing_error=$3, processing_error_detail=$4, pipeline_progress=$5, updated_at=now() WHERE id=$1`,
        [
          submissionId,
          status,
          failure.message,
          failure.detail,
          JSON.stringify({ ...progress, failedStep: step, autoRetrying: retrying }),
        ],
      );
    if (retrying) {
      logger.warn(
        { err, submissionId, step, attempt: opts.attempt!.attempt },
        'processing failed; retrying automatically',
      );
      // Still processing while the retry waits; a decided submission keeps its status.
      await recordFailure(decided ?? 'PROCESSING');
      await audit({
        action: 'PROCESSING_RETRY_SCHEDULED',
        entityType: 'submission',
        entityId: submissionId,
        submissionId,
        actorId: null,
        details: {
          error: auditErrorText(err),
          step,
          attempt: opts.attempt!.attempt,
          maxAttempts: opts.attempt!.maxAttempts,
        },
      });
      // Rethrown, so the job queue runs it again after its backoff; that run resumes from `step`.
      throw err;
    }
    logger.error({ err, submissionId, step }, 'processing failed');
    await recordSystemError(`process:${submissionId}`, err);
    // A decided submission keeps its status; the failure is still shown as its processing error.
    await recordFailure(decided ?? 'ERROR');
    await audit({
      action: 'PROCESSING_FAILED',
      entityType: 'submission',
      entityId: submissionId,
      submissionId,
      actorId: null,
      details: { error: auditErrorText(err), step },
    });
  }
}

export async function verifySubmissionNpis(
  submissionId: string,
  fields: { fieldName: string; value: string; confidence: number }[],
  actorId: string | null,
): Promise<void> {
  const name = pickBest(fields, 'applicant_name');
  const state = pickBest(fields, 'practice_state');
  const specialty = pickBest(fields, 'specialty');
  const stated = [
    ...new Set(
      fields
        .filter((f) => f.fieldName === 'npi')
        .map((f) => f.value.replace(/\D/g, ''))
        .filter((n) => n.length === 10),
    ),
  ];
  // Every stated number gets a check, also one failing the NPI check digit: on a group submission it is often another
  // provider's own (mistyped or placeholder) NPI, so dropping it would hide that provider's missing NPI (F-02).
  const npis = stated;
  // A group submission names several providers and the fields do not say which NPI is whose: each NPI is compared with
  // the listed provider it belongs to, not with the first one named (F-01).
  const names = distinctValues(fields, 'applicant_name');
  const providers: ProviderClaims | undefined =
    names.length > 1
      ? { names, states: distinctValues(fields, 'practice_state'), specialties: distinctValues(fields, 'specialty') }
      : undefined;
  for (const npi of npis) await verifyNpi(submissionId, { npi, name, state, specialty }, actorId, undefined, providers);
  // NPIs a person entered are re-checked with the claim they were entered with, and never dropped as stale.
  const { rows: manual } = await pool.query(
    `SELECT npi, claimed_name, claimed_state, claimed_specialty FROM npi_verifications WHERE submission_id=$1 AND source='MANUAL'`,
    [submissionId],
  );
  for (const m of manual.filter((r) => !npis.includes(r.npi))) {
    await verifyNpi(
      submissionId,
      {
        npi: m.npi,
        name: m.claimed_name ?? name,
        state: m.claimed_state ?? state,
        specialty: m.claimed_specialty ?? specialty,
      },
      actorId,
      { source: 'MANUAL' },
    );
  }
  if (!npis.length && !manual.length) {
    const zip =
      zip5(pickBest(fields, 'practice_zip')) ??
      fields
        .filter((f) => f.fieldName === 'practice_location' || f.fieldName === 'mailing_address')
        .map((f) => zip5(f.value))
        .find(Boolean) ??
      null;
    npis.push(await verifyNpiBySearch(submissionId, { name, zip, state, specialty }, actorId));
  }
  // Checks for NPIs no longer on the submission (or an earlier search's hit) are stale; drop them.
  const { rows: removed } = await pool.query(
    `DELETE FROM npi_verifications WHERE submission_id=$1 AND source <> 'MANUAL' AND npi <> ALL($2::text[]) RETURNING npi, status`,
    [submissionId, npis],
  );
  if (removed.length) {
    await audit({
      action: 'NPI_VERIFICATIONS_REMOVED',
      entityType: 'submission',
      entityId: submissionId,
      submissionId,
      actorId,
      details: { removed },
    });
  }
  await syncNpiRegistryFields(submissionId);
}

/**
 * No NPI on the submission: find it in the registry by name + ZIP, using specialty to pick between several hits.
 * Returns the NPI the result was saved under ('' when no single record matched).
 */
export async function verifyNpiBySearch(
  submissionId: string,
  claim: NpiSearchClaim,
  actorId: string | null,
): Promise<string> {
  let npi = '';
  let result: NpiResult;
  try {
    const outcome = await integrations().npi.search(claim);
    if (outcome.match) {
      npi = outcome.match.number;
      result = compareNpi(
        { npi, name: claim.name, state: claim.state, specialty: claim.specialty },
        { found: true, result: outcome.match },
      );
      if (outcome.widened) {
        const loc = (outcome.match.addresses ?? []).find((a: any) => a.address_purpose === 'LOCATION');
        result.mismatches.unshift(
          `Found by ${outcome.widened} search, not name + ZIP: submission ZIP ${claim.zip ?? 'not stated'} vs registry ZIP ${loc ? String(loc.postal_code).slice(0, 5) : 'unknown'}`,
        );
        if (result.status === 'MATCH') result.status = 'PARTIAL_MATCH';
      }
    } else {
      const shown = outcome.candidates.slice(0, 5).map((c) => {
        const loc = (c.addresses ?? []).find((a: any) => a.address_purpose === 'LOCATION');
        const tax = ((c.taxonomies ?? []).find((t: any) => t.primary) ?? c.taxonomies?.[0])?.desc;
        return `Candidate ${c.number}: ${registryName(c)}${tax ? `, ${tax}` : ''}${loc ? `, ${loc.city} ${loc.state} ${String(loc.postal_code).slice(0, 5)}` : ''}`;
      });
      result = {
        status: 'NOT_VERIFIED',
        registryName: null,
        registryTaxonomy: null,
        registryState: null,
        registryStatus: null,
        mismatches: [`Not verified: ${outcome.reason}`, ...shown],
        registryData: null,
      };
    }
    await audit({
      action: 'NPI_SEARCHED',
      entityType: 'submission',
      entityId: submissionId,
      submissionId,
      actorId,
      // Which registry fields were searched, not their values (the applicant's name and ZIP; DB-01).
      details: {
        queryFields: Object.keys(outcome.query).sort(),
        candidates: outcome.candidates.length,
        npi: npi || null,
        reason: outcome.reason,
      },
    });
  } catch (err) {
    result = {
      status: 'ERROR',
      registryName: null,
      registryTaxonomy: null,
      registryState: null,
      registryStatus: null,
      mismatches: [`Registry search failed: ${err instanceof Error ? err.message : err}`],
      registryData: null,
    };
  }
  await saveNpiResult(
    submissionId,
    { npi, name: claim.name, state: claim.state, specialty: claim.specialty },
    result,
    actorId,
  );
  return npi;
}

/** Where a check came from and who entered it; MANUAL checks are removable and never dropped as stale. */
export interface NpiOrigin {
  source: 'EXTRACTED' | 'MANUAL';
  note?: string | null;
}

export async function verifyNpi(
  submissionId: string,
  stated: { npi: string; name?: string | null; state?: string | null; specialty?: string | null },
  actorId: string | null,
  origin: NpiOrigin = { source: 'EXTRACTED' },
  /** Set on a group submission: the NPI is compared with whichever listed provider it belongs to. */
  providers?: ProviderClaims,
) {
  let claim: NpiClaim = stated;
  let result;
  try {
    // A number failing the check digit cannot be in the registry: no call, and the result says why.
    const lookup = isValidNpi(stated.npi)
      ? await integrations().npi.lookup(stated.npi)
      : { found: false, result: null };
    if (providers) ({ claim, result } = compareNpiToProviders(stated.npi, providers, lookup));
    else result = compareNpi(stated, lookup);
  } catch (err) {
    result = {
      status: 'ERROR' as const,
      registryName: null,
      registryTaxonomy: null,
      registryState: null,
      registryStatus: null,
      mismatches: [`Registry lookup failed: ${err instanceof Error ? err.message : err}`],
      registryData: null,
    };
  }
  return saveNpiResult(submissionId, claim, result, actorId, origin);
}

async function saveNpiResult(
  submissionId: string,
  claim: NpiClaim,
  result: NpiResult,
  actorId: string | null,
  origin: NpiOrigin = { source: 'EXTRACTED' },
) {
  const {
    rows: [prior],
  } = await pool.query(
    'SELECT id, status, auto_status, mismatches FROM npi_verifications WHERE submission_id=$1 AND npi=$2',
    [submissionId, claim.npi],
  );
  const reviewed = Boolean(prior?.auto_status);
  // A failed registry call says nothing about the NPI: an underwriter's decision stands until the registry answers.
  if (reviewed && result.status === 'ERROR') {
    await audit({
      action: 'NPI_VERIFIED',
      entityType: 'npi_verification',
      entityId: prior.id,
      submissionId,
      actorId,
      details: { npi: claim.npi, status: result.status, mismatches: result.mismatches, source: origin.source },
    });
    return result;
  }
  // A decision covers the differences the underwriter saw; any change to them needs a fresh look.
  const keepOverride =
    reviewed &&
    result.status === prior.auto_status &&
    JSON.stringify(result.mismatches) === JSON.stringify(prior.mismatches);
  const claimed = structureName(claim.name);
  const registry = registryStructuredName(result.registryData);
  const {
    rows: [row],
  } = await pool.query(
    `INSERT INTO npi_verifications (submission_id, npi, claimed_name, claimed_state, claimed_specialty, status, registry_name, registry_taxonomy, registry_state, registry_status, mismatches, registry_data,
       claimed_type, claimed_first_name, claimed_last_name, claimed_entity_name, registry_type, registry_first_name, registry_last_name, registry_entity_name, source, added_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (submission_id, npi) DO UPDATE SET
       claimed_name=EXCLUDED.claimed_name, claimed_state=EXCLUDED.claimed_state, claimed_specialty=EXCLUDED.claimed_specialty,
       status=EXCLUDED.status, registry_name=EXCLUDED.registry_name, registry_taxonomy=EXCLUDED.registry_taxonomy,
       registry_state=EXCLUDED.registry_state, registry_status=EXCLUDED.registry_status, mismatches=EXCLUDED.mismatches,
       registry_data=EXCLUDED.registry_data,
       claimed_type=EXCLUDED.claimed_type, claimed_first_name=EXCLUDED.claimed_first_name, claimed_last_name=EXCLUDED.claimed_last_name,
       claimed_entity_name=EXCLUDED.claimed_entity_name, registry_type=EXCLUDED.registry_type, registry_first_name=EXCLUDED.registry_first_name,
       registry_last_name=EXCLUDED.registry_last_name, registry_entity_name=EXCLUDED.registry_entity_name, verified_at=now(),
       -- Once a person entered an NPI it stays theirs, even when extraction later finds the same number.
       source=CASE WHEN npi_verifications.source='MANUAL' THEN 'MANUAL' ELSE EXCLUDED.source END,
       added_by=COALESCE(npi_verifications.added_by, EXCLUDED.added_by), note=COALESCE(EXCLUDED.note, npi_verifications.note),
       auto_status=CASE WHEN $24::boolean THEN npi_verifications.auto_status END,
       override_note=CASE WHEN $24::boolean THEN npi_verifications.override_note END,
       override_by=CASE WHEN $24::boolean THEN npi_verifications.override_by END,
       override_at=CASE WHEN $24::boolean THEN npi_verifications.override_at END
     RETURNING id`,
    [
      submissionId,
      claim.npi,
      claim.name ?? null,
      claim.state ?? null,
      claim.specialty ?? null,
      keepOverride ? prior.status : result.status,
      result.registryName,
      result.registryTaxonomy,
      result.registryState,
      result.registryStatus,
      result.mismatches,
      JSON.stringify(result.registryData),
      claimed.type,
      claimed.firstName,
      claimed.lastName,
      claimed.entityName,
      registry.type,
      registry.firstName,
      registry.lastName,
      registry.entityName,
      origin.source,
      origin.source === 'MANUAL' ? actorId : null,
      origin.note ?? null,
      keepOverride,
    ],
  );
  await audit({
    action: 'NPI_VERIFIED',
    entityType: 'npi_verification',
    entityId: row.id,
    submissionId,
    actorId,
    details: { npi: claim.npi, status: result.status, mismatches: result.mismatches, source: origin.source },
  });
  if (reviewed && !keepOverride) {
    await audit({
      action: 'NPI_OVERRIDE_CLEARED',
      entityType: 'npi_verification',
      entityId: row.id,
      submissionId,
      actorId,
      details: {
        npi: claim.npi,
        overriddenStatus: prior.status,
        reviewedMismatches: prior.mismatches,
        status: result.status,
        mismatches: result.mismatches,
      },
    });
  }
  // A matched record fills the contact details the submission leaves out (phone, mailing address).
  await syncNpiRegistryFields(submissionId);
  return result;
}

/**
 * Earlier emails in the same thread (subjects and verdicts), so a short follow-up is not ignored for lack of context.
 * Skipped emails count as NOT_SUBMISSION. `submissionId` is null for an email not stored yet.
 */
async function threadContext(
  submissionId: string | null,
  threadId: string | null,
  receivedAt: Date,
): Promise<ThreadEmail[]> {
  if (!threadId) return [];
  const { rows } = await pool.query(
    `SELECT subject, classification, received_at FROM (
       SELECT e.subject, s.classification, e.received_at FROM submissions s JOIN emails e ON e.id=s.email_id
        WHERE e.thread_id=$1 AND s.id IS DISTINCT FROM $2::uuid AND e.received_at <= $3
       UNION ALL
       SELECT subject, 'NOT_SUBMISSION', received_at FROM skipped_emails WHERE thread_id=$1 AND received_at <= $3
     ) t ORDER BY received_at LIMIT 20`,
    [threadId, submissionId, receivedAt],
  );
  return rows.map((r) => ({
    subject: r.subject,
    classification: r.classification,
    receivedAt: new Date(r.received_at),
  }));
}

/** Failures are recorded in processLocked's catch (with their raw detail); this clears that detail. */
async function setStatus(submissionId: string, status: string, error: string | null) {
  await pool.query(
    'UPDATE submissions SET status=$2, processing_error=$3, processing_error_detail=NULL, updated_at=now() WHERE id=$1',
    [submissionId, status, error],
  );
}

async function setHeld(submissionId: string, held: boolean) {
  await pool.query(
    'UPDATE submissions SET held_for_classification=$2 WHERE id=$1 AND held_for_classification IS DISTINCT FROM $2',
    [submissionId, held],
  );
}
