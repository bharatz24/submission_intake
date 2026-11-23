import { type gmail_v1, google } from 'googleapis';
import jwt from 'jsonwebtoken';

import { config, gmailConfigured, gmailSource } from '../config.js';
import { GMAIL_OFF_RECHECK_MS, GMAIL_RECENT_IDS_MAX } from '../constants.js';
import { pool, withTransaction } from '../db/pool.js';
import { logger } from '../logger.js';
import { hasPermission } from '../permissions.js';
import {
  gmailAutoImportSince,
  gmailPollIntervalSeconds,
  POLL_INTERVAL_DEFAULT,
  resetGmailAutoImportSince,
} from './appSettings.js';
import { audit, recordSystemError } from './audit.js';
import { track } from './backgroundTasks.js';
import { messageSignals } from './classificationRules.js';
import { decryptSecret, deriveKey, encrypt } from './crypto.js';
import * as mcp from './gmailMcp.js';
import { drainQueue, enqueueMessages, type IngestOutcome } from './ingestQueue.js';
import { limits } from './limitsSettings.js';
import { buildMime, type MimeMessage } from './mime.js';
import { withAdvisoryLock } from './pgListen.js';
import {
  type AttachmentGap,
  type IncomingAttachment,
  type IncomingEmail,
  ingestGmailEmail,
  ingestSkippedEmail,
} from './pipeline.js';

/** Per-request timeout of the Gmail API (Settings → Limits). */
const requestTimeoutMs = () => limits().gmailTimeoutSeconds * 1000;

// Read, plus send for replies and forwards (services/outbound.ts). The platform never deletes or modifies mail.
// A mailbox connected before gmail.send was added must be reconnected before it can send.
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', SEND_SCOPE];

export class GmailSendError extends Error {
  constructor(
    public code: 'NOT_CONNECTED' | 'NOT_AUTHORIZED' | 'FAILED',
    message: string,
  ) {
    super(message);
  }
}

export interface OutgoingMessage extends Omit<MimeMessage, 'from'> {
  /** Gmail thread to file the message in (replies); null starts a new thread. */
  threadId: string | null;
}

export interface SentMessage {
  transport: 'OAUTH' | 'MCP';
  messageId: string | null;
  threadId: string | null;
}

/** Send from the monitored mailbox, through OAuth or the Gmail MCP server (no attachments over MCP). */
export async function sendMessage(msg: OutgoingMessage): Promise<SentMessage> {
  if (gmailSource === 'MCP') {
    if (msg.attachments?.length)
      throw new GmailSendError('FAILED', 'Attachments cannot be sent through the Gmail MCP server');
    const sent = await mcp.sendMessage(msg).catch((err) => {
      throw new GmailSendError('FAILED', `Gmail MCP send failed: ${err instanceof Error ? err.message : err}`);
    });
    return { transport: 'MCP', ...sent };
  }
  const acc = await account();
  if (!acc) throw new GmailSendError('NOT_CONNECTED', 'Gmail is not connected');
  const raw = Buffer.from(buildMime({ ...msg, from: acc.email })).toString('base64url');
  try {
    const { data } = await (
      await gmailFor(acc)
    ).users.messages.send({
      userId: 'me',
      requestBody: { raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) },
    });
    return { transport: 'OAUTH', messageId: data.id ?? null, threadId: data.threadId ?? null };
  } catch (err: any) {
    if (isInvalidGrant(err)) {
      await noteAuthFailure(acc, err);
      throw new GmailSendError(
        'NOT_AUTHORIZED',
        'Gmail authorization was revoked or expired. An admin must reconnect Gmail in Settings.',
      );
    }
    const status = err?.status ?? err?.code;
    if (status === 403 || /insufficient/i.test(String(err?.message))) {
      throw new GmailSendError(
        'NOT_AUTHORIZED',
        'The Gmail connection cannot send mail yet. An admin must reconnect Gmail in Settings to grant send access.',
      );
    }
    throw new GmailSendError('FAILED', `Gmail rejected the message: ${err instanceof Error ? err.message : err}`);
  }
}

function oauthClient() {
  return new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, config.GOOGLE_REDIRECT_URI);
}

// The OAuth `state` is a JWT signed with a key derived from JWT_SECRET for this purpose alone, with its own
// audience, so it can never pass as a login token (http.ts verifyAccessToken) and a login token never passes as state.
const STATE_KEY = deriveKey(config.JWT_SECRET, 'gmail-oauth-state');
const STATE_AUDIENCE = 'ims-gmail-oauth-state';
const STATE_ISSUER = 'ims-submission-review';

export function signOAuthState(userId: string): string {
  return jwt.sign({ sub: userId, purpose: 'gmail-oauth' }, STATE_KEY, {
    algorithm: 'HS256',
    expiresIn: '10m',
    audience: STATE_AUDIENCE,
    issuer: STATE_ISSUER,
  });
}

/** The admin who started the sign-in; throws on a forged, expired or foreign state. */
export function verifyOAuthState(state: string): string {
  const payload = jwt.verify(state, STATE_KEY, {
    algorithms: ['HS256'],
    audience: STATE_AUDIENCE,
    issuer: STATE_ISSUER,
  }) as jwt.JwtPayload;
  if (payload.purpose !== 'gmail-oauth' || typeof payload.sub !== 'string') throw new Error('Invalid OAuth state');
  return payload.sub;
}

export function authUrl(userId: string): string {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: signOAuthState(userId),
  });
}

export async function handleOAuthCallback(code: string, state: string): Promise<string> {
  const actorId = verifyOAuthState(state);
  // The admin who started the sign-in must still be an active admin when Google redirects back.
  const {
    rows: [actor],
  } = await pool.query('SELECT role, disabled_at FROM users WHERE id=$1', [actorId]);
  if (!actor || !hasPermission(actor.role, 'gmail:manage') || actor.disabled_at)
    throw new Error('OAuth state belongs to a user who is no longer an active admin');
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token; revoke app access and retry');
  client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: client, timeout: requestTimeoutMs() });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress!;
  // One connected mailbox: replace it atomically so a failure never leaves none (or two).
  await withTransaction(async (db) => {
    await db.query('DELETE FROM gmail_accounts');
    await db.query('INSERT INTO gmail_accounts (email, refresh_token_enc, history_id) VALUES ($1,$2,$3)', [
      email,
      encrypt(tokens.refresh_token!),
      profile.data.historyId,
    ]);
  });
  await resetGmailAutoImportSince(actorId);
  await audit({ action: 'GMAIL_CONNECTED', entityType: 'gmail_account', entityId: email, actorId, details: { email } });
  await ensureWatch().catch((err) => logger.warn({ err }, 'gmail watch setup failed; polling only'));
  return email;
}

async function account() {
  const {
    rows: [acc],
  } = await pool.query('SELECT * FROM gmail_accounts LIMIT 1');
  return acc ?? null;
}

// One OAuth client per connected account, reused across calls so its access token (valid ~1 h) is reused instead
// of being refreshed on every poll, send and lookup. Keyed on the encrypted refresh token, so a reconnect (new
// token) or disconnect builds a fresh client. The Gmail API object carries the timeout, so a changed setting rebuilds
// it around the same OAuth client (its access token is kept).
let cachedClient: {
  key: string;
  auth: InstanceType<typeof google.auth.OAuth2>;
  timeoutMs: number;
  gmail: gmail_v1.Gmail;
} | null = null;

async function gmailFor(acc: { id?: string; refresh_token_enc: string }): Promise<gmail_v1.Gmail> {
  const key = `${acc.id ?? ''}:${acc.refresh_token_enc}`;
  const timeoutMs = requestTimeoutMs();
  if (cachedClient?.key === key && cachedClient.timeoutMs === timeoutMs) return cachedClient.gmail;
  let auth = cachedClient?.key === key ? cachedClient.auth : null;
  if (!auth) {
    auth = oauthClient();
    const token = decryptSecret(acc.refresh_token_enc);
    auth.setCredentials({ refresh_token: token.value });
    // Under an old key or format (ENCRYPTION_KEY rotation): store it under the current key. Only if nobody
    // reconnected meanwhile; a failure just means it is tried again next time.
    if (token.stale) {
      await pool
        .query('UPDATE gmail_accounts SET refresh_token_enc=$2 WHERE refresh_token_enc=$1', [
          acc.refresh_token_enc,
          encrypt(token.value),
        ])
        .catch((err) => logger.warn({ err }, 'Gmail refresh token re-encryption failed'));
    }
  }
  const gmail = google.gmail({ version: 'v1', auth, timeout: timeoutMs });
  cachedClient = { key, auth, timeoutMs, gmail };
  return gmail;
}

/** Drops the cached OAuth client (after disconnect, or when its refresh token was rejected). */
export function forgetGmailClient(): void {
  cachedClient = null;
}

// Set when Google rejects the stored refresh token (revoked access, password change, expired consent): polling
// cannot recover until an admin reconnects, so status() reports it instead of a silently stale mailbox.
let authFailure: { tokenKey: string; message: string; at: Date } | null = null;

/** True for Google's "the refresh token is no longer valid" error. */
export function isInvalidGrant(err: unknown): boolean {
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } } | null;
  return e?.response?.data?.error === 'invalid_grant' || /invalid_grant/i.test(String(e?.message ?? ''));
}

async function noteAuthFailure(acc: { refresh_token_enc: string }, err: unknown): Promise<void> {
  const first = authFailure?.tokenKey !== acc.refresh_token_enc;
  authFailure = {
    tokenKey: acc.refresh_token_enc,
    message:
      'Google rejected the stored Gmail authorization (access revoked or expired). An admin must reconnect Gmail in Settings.',
    at: new Date(),
  };
  forgetGmailClient();
  // Recorded once per token, not on every poll.
  if (first) {
    logger.error({ err }, 'gmail refresh token rejected (invalid_grant); reconnect required');
    await recordSystemError('gmail:auth', new Error(authFailure.message));
  }
}

/** The auth failure for the currently stored token, if any (a reconnect stores a new token and clears it). */
const currentAuthFailure = (acc: { refresh_token_enc: string } | null) =>
  acc && authFailure?.tokenKey === acc.refresh_token_enc ? authFailure : null;

/**
 * Live check for Settings → Connections: asks Gmail for the mailbox profile (OAuth) or opens the MCP session.
 * Returns a short description of what answered; throws when the mailbox cannot be reached.
 */
export async function gmailProbe(): Promise<string> {
  if (!gmailConfigured) throw new Error('Not configured');
  if (gmailSource === 'MCP') {
    if (!(await mcp.mcpConnected())) throw new Error(mcp.mcpState.lastError ?? 'MCP server did not connect');
    return 'MCP server connected';
  }
  const acc = await account();
  if (!acc) throw new Error('Not connected: connect Gmail first');
  try {
    const profile = await (await gmailFor(acc)).users.getProfile({ userId: 'me' });
    return `${profile.data.emailAddress ?? acc.email} · ${profile.data.messagesTotal ?? 0} messages`;
  } catch (err) {
    if (isInvalidGrant(err)) {
      await noteAuthFailure(acc, err);
      throw new Error('Google rejected the stored authorization: reconnect Gmail');
    }
    throw err;
  }
}

export async function status() {
  if (gmailSource === 'MCP') {
    const connected = gmailConfigured && (await mcp.mcpConnected());
    return {
      source: gmailSource,
      configured: gmailConfigured,
      connected,
      email: null,
      mode: connected && (await gmailPollIntervalSeconds()) > 0 ? 'POLLING' : 'OFF',
      lastPollAt: mcp.mcpState.lastPollAt,
      lastHistoryId: null,
      watchExpiresAt: null,
      needsReconnect: false,
      error: mcp.mcpState.lastError,
    };
  }
  const acc = await account();
  const authError = currentAuthFailure(acc);
  return {
    source: gmailSource,
    configured: gmailConfigured,
    connected: Boolean(acc),
    email: acc?.email ?? null,
    mode: !acc
      ? 'OFF'
      : acc.watch_expires_at && new Date(acc.watch_expires_at) > new Date()
        ? 'PUSH'
        : (await gmailPollIntervalSeconds()) > 0
          ? 'POLLING'
          : 'OFF',
    lastPollAt: acc?.last_poll_at ?? null,
    lastHistoryId: acc?.history_id ?? null,
    watchExpiresAt: acc?.watch_expires_at ?? null,
    /** True when the stored authorization was rejected and only a reconnect can restore monitoring. */
    needsReconnect: Boolean(authError),
    error: authError?.message ?? null,
  };
}

export async function disconnect(actorId: string) {
  if (gmailSource === 'MCP') {
    // Account access is managed by the MCP server; here Disconnect stops polling and sending until an admin
    // resumes with a manual poll ("Check now").
    await mcp.disconnectMcp();
    return;
  }
  const acc = await account();
  if (!acc) return;
  try {
    const gmail = await gmailFor(acc);
    await gmail.users.stop({ userId: 'me' });
  } catch {
    /* watch may not exist */
  }
  await pool.query('DELETE FROM gmail_accounts');
  forgetGmailClient();
  await audit({ action: 'GMAIL_DISCONNECTED', entityType: 'gmail_account', entityId: acc.email, actorId, details: {} });
}

/** Register (or renew) a Pub/Sub watch. Gmail watches expire after 7 days. */
export async function ensureWatch(): Promise<void> {
  if (gmailSource === 'MCP' || !config.GMAIL_PUBSUB_TOPIC) return;
  const acc = await account();
  if (!acc) return;
  if (acc.watch_expires_at && new Date(acc.watch_expires_at).getTime() - Date.now() > 24 * 3600_000) return;
  const gmail = await gmailFor(acc);
  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: { topicName: config.GMAIL_PUBSUB_TOPIC, labelIds: ['INBOX'] },
  });
  await pool.query('UPDATE gmail_accounts SET watch_expires_at=$2 WHERE id=$1', [
    acc.id,
    new Date(Number(res.data.expiration)),
  ]);
}

let polling = false;
/**
 * Fetch new messages since the stored historyId (falls back to a recent search). One poll at a time across all
 * instances (advisory lock): two would read the same history and race to move the cursor.
 */
export async function pollOnce(opts: { manual?: boolean } = {}): Promise<number> {
  // A manual poll is how an admin resumes MCP mail after Disconnect.
  if (opts.manual && gmailSource === 'MCP') mcp.resumeMcp();
  return (await withAdvisoryLock('gmail:poll', pollLocked)) ?? 0;
}

async function pollLocked(): Promise<number> {
  if (polling) return 0;
  polling = true;
  try {
    if (gmailSource === 'MCP') return await pollMcp();
    const acc = await account();
    if (!acc) return 0;
    try {
      const processed = await pollOAuth(acc);
      if (currentAuthFailure(acc)) authFailure = null; // the token works again
      return processed;
    } catch (err) {
      // A rejected refresh token never heals by retrying: report it once and wait for a reconnect.
      if (isInvalidGrant(err)) {
        await noteAuthFailure(acc, err);
        return 0;
      }
      throw err;
    }
  } finally {
    polling = false;
  }
}

async function pollOAuth(acc: any): Promise<number> {
  const gmail = await gmailFor(acc);
  let ids: string[] = [];
  let newHistoryId: string | null = acc.history_id;

  if (acc.history_id) {
    try {
      let pageToken: string | undefined;
      do {
        const h = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: acc.history_id,
          historyTypes: ['messageAdded'],
          labelId: 'INBOX',
          pageToken,
        });
        for (const rec of h.data.history ?? [])
          for (const m of rec.messagesAdded ?? []) if (m.message?.id) ids.push(m.message.id);
        newHistoryId = h.data.historyId ?? newHistoryId;
        pageToken = h.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (err: any) {
      if (err?.code !== 404) throw err;
      ({ ids, historyId: newHistoryId } = await recentIdsFromNow(gmail, acc.history_id)); // history expired
    }
  } else {
    ({ ids, historyId: newHistoryId } = await recentIdsFromNow(gmail, acc.history_id));
  }
  if (!newHistoryId || newHistoryId === acc.history_id) {
    newHistoryId = (await gmail.users.getProfile({ userId: 'me' })).data.historyId ?? newHistoryId;
  }

  // The IDs are durable before the cursor moves: a message that fails to ingest stays queued and is fetched again.
  await withTransaction(async (db) => {
    await enqueueMessages(db, ids, 'OAUTH');
    await db.query('UPDATE gmail_accounts SET history_id=$2, last_poll_at=now() WHERE id=$1', [acc.id, newHistoryId]);
  });
  return await drainQueue((id, opts) => ingestMessage(gmail, id, opts));
}

async function pollMcp(): Promise<number> {
  if (mcp.mcpState.paused) return 0;
  const ids = await mcp.searchMessageIds(await autoQuery(2));
  // Queued, so a failed message is retried after it has left the 2-day search window.
  await enqueueMessages(pool, ids, 'MCP');
  const processed = await drainQueue(ingestViaMcp);
  mcp.mcpState.lastPollAt = new Date();
  return processed;
}

async function ingestViaMcp(id: string, opts: { imported: boolean }): Promise<IngestOutcome> {
  let email: IncomingEmail;
  try {
    email = await mcp.fetchMessage(id);
  } catch (err) {
    // Deleted (or never existed): dropped from the queue like a 404 on the OAuth path, not retried forever.
    if (err instanceof mcp.McpMessageNotFound) return 'GONE';
    throw err;
  }
  return ingestGmailEmail({ ...email, gmailMessageId: email.gmailMessageId ?? id }, opts);
}

/** Gmail search every poll, import and reconciliation starts from. */
const GMAIL_QUERY = 'in:inbox';

/** Search for automatic ingestion: the last `days` days, but never mail received before the automatic start date. */
async function autoQuery(days: number): Promise<string> {
  const since = await gmailAutoImportSince();
  return `${GMAIL_QUERY} newer_than:${days}d after:${Math.floor(since!.getTime() / 1000)}`;
}

/**
 * IDs of messages in the inbox received in the last `days` days. `automatic` (reconciliation) also
 * excludes mail from before the automatic start date; a manual import does not. `after` narrows the
 * search to mail received from that moment on (the manual "today" import).
 */
export async function listRecentMessageIds(
  days: number,
  opts: { automatic?: boolean; after?: Date } = {},
): Promise<string[]> {
  let query = opts.automatic ? await autoQuery(days) : `${GMAIL_QUERY} newer_than:${days}d`;
  if (opts.after) query += ` after:${Math.floor(opts.after.getTime() / 1000)}`;
  if (gmailSource === 'MCP') return mcp.searchMessageIds(query, 500);
  const acc = await account();
  if (!acc) return [];
  const gmail = await gmailFor(acc);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 500, pageToken });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

/** Number of attachment parts Gmail holds for a message (OAuth only; null when it cannot be read). */
export async function gmailAttachmentCount(id: string): Promise<number | null> {
  if (gmailSource === 'MCP') return null;
  const acc = await account();
  if (!acc) return null;
  const { data: msg } = await (await gmailFor(acc)).users.messages.get({ userId: 'me', id, format: 'full' });
  return walkParts(msg.payload).attachments.length;
}

/** Fallback when there is no usable history cursor: every message of the last 2 days (all pages, not just 50). */
async function recentIds(gmail: gmail_v1.Gmail): Promise<string[]> {
  const q = await autoQuery(2);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 500, pageToken });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < GMAIL_RECENT_IDS_MAX);
  if (pageToken)
    logger.warn(
      { fetched: ids.length },
      'gmail history-gap fallback hit its limit; older messages are left to reconciliation',
    );
  return ids;
}

/**
 * The fallback with its new cursor: the historyId is read BEFORE the search, so a message arriving between the two
 * is past the cursor and comes in through history on the next poll (at worst twice; ingest is idempotent).
 */
async function recentIdsFromNow(
  gmail: gmail_v1.Gmail,
  fallback: string | null,
): Promise<{ ids: string[]; historyId: string | null }> {
  const historyId = (await gmail.users.getProfile({ userId: 'me' })).data.historyId ?? fallback;
  return { ids: await recentIds(gmail), historyId };
}

async function ingestMessage(gmail: gmail_v1.Gmail, id: string, opts: { imported: boolean }): Promise<IngestOutcome> {
  const email = await readMessage(gmail, id);
  return typeof email === 'string' ? email : ingestGmailEmail(email, opts);
}

/**
 * "Process as submission" on an email skipped at intake: fetch it from Gmail again and store it as a submission.
 * Returns the new submission's id, or null when the message is no longer in the mailbox.
 */
export async function importSkippedMessage(id: string, actor: { id: string; name: string }): Promise<string | null> {
  let email: IncomingEmail & { gmailMessageId: string };
  if (gmailSource === 'MCP') {
    const m = await mcp.fetchMessage(id);
    email = { ...m, gmailMessageId: m.gmailMessageId ?? id };
  } else {
    const acc = await account();
    if (!acc) throw new GmailSendError('NOT_CONNECTED', 'Gmail is not connected');
    const read = await readMessage(await gmailFor(acc), id);
    if (typeof read === 'string') return null;
    email = read;
  }
  return ingestSkippedEmail(email, actor);
}

/** A Gmail message as an incoming email; GONE when it was deleted, EXISTING when it is not mail to ingest. */
async function readMessage(
  gmail: gmail_v1.Gmail,
  id: string,
): Promise<(IncomingEmail & { gmailMessageId: string }) | 'GONE' | 'EXISTING'> {
  let msg: gmail_v1.Schema$Message;
  try {
    ({ data: msg } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' }));
  } catch (err: any) {
    if ((err?.status ?? err?.code) === 404) return 'GONE';
    throw err;
  }
  if (msg.labelIds?.includes('DRAFT')) return 'EXISTING';
  // Mail this mailbox sent is skipped, unless it also landed in this inbox and the app did not send it: an underwriter
  // forwarding a broker's submission to the intake mailbox from the same account ("Fwd: ...") is SENT + INBOX.
  if (msg.labelIds?.includes('SENT') && (!msg.labelIds.includes('INBOX') || (await sentByApp(id)))) return 'EXISTING';
  const headers = Object.fromEntries((msg.payload?.headers ?? []).map((h) => [h.name!.toLowerCase(), h.value ?? '']));
  const { text, html, attachments } = walkParts(msg.payload);
  const files: IncomingAttachment[] = [];
  const gaps: AttachmentGap[] = [];
  for (const a of attachments) {
    if (a.size > config.ATTACHMENT_MAX_BYTES) {
      // Not downloaded, but recorded on the submission so it is never missed silently.
      gaps.push({
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.size,
        reason: 'TOO_LARGE',
        detail: `Larger than the ${Math.round(config.ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB limit`,
      });
      continue;
    }
    const encoded = a.attachmentId
      ? (await gmail.users.messages.attachments.get({ userId: 'me', messageId: id, id: a.attachmentId })).data.data
      : a.data;
    files.push({ filename: a.filename, mimeType: a.mimeType, data: Buffer.from(encoded ?? '', 'base64url') });
  }
  return {
    gmailMessageId: id,
    rfcMessageId: headers['message-id'] || null,
    signals: messageSignals(headers, msg.labelIds ?? []),
    threadId: msg.threadId ?? null,
    fromAddress: headers.from ?? '',
    toAddress: headers.to ?? '',
    ccAddress: headers.cc || null,
    subject: headers.subject ?? '(no subject)',
    bodyText: text || htmlToText(html),
    receivedAt: new Date(Number(msg.internalDate ?? Date.now())),
    attachments: files,
    gaps,
  };
}

/** True when the message is one the app sent itself (a reply or follow-up from the workspace). */
async function sentByApp(gmailMessageId: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM outbound_emails WHERE gmail_message_id=$1', [gmailMessageId]);
  return !!rowCount;
}

// Gmail usually returns attachments by attachmentId, but small ones can arrive inline in body.data.
interface AttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string | null;
  data: string | null;
  size: number;
}

export function walkParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  acc = { text: '', html: '', attachments: [] as AttachmentRef[] },
) {
  if (!part) return acc;
  if (part.filename && (part.body?.attachmentId || part.body?.data)) {
    acc.attachments.push({
      filename: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      attachmentId: part.body.attachmentId ?? null,
      data: part.body.attachmentId ? null : (part.body.data ?? null),
      size: part.body.size ?? 0,
    });
  } else if (part.mimeType === 'text/plain' && part.body?.data && !acc.text) {
    acc.text = Buffer.from(part.body.data, 'base64url').toString('utf8');
  } else if (part.mimeType === 'text/html' && part.body?.data && !acc.html) {
    acc.html = Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const p of part.parts ?? []) walkParts(p, acc);
  return acc;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let timer: NodeJS.Timeout | null = null;
let monitorTick: (() => Promise<void>) | null = null;

/**
 * One monitor tick: renew the Pub/Sub watch when due, then poll. A failure is logged and recorded on Monitoring, never
 * thrown. Run by the monitor timer here, and by the Netlify worker's `gmail-poll` task (runtime/workerTasks.ts).
 */
export async function pollGmailNow(): Promise<void> {
  try {
    await ensureWatch();
    await pollOnce();
  } catch (err) {
    logger.error({ err }, 'gmail poll failed');
    await recordSystemError('gmail:poll', err);
  }
}

/**
 * Polls every `gmailPollIntervalSeconds()` (Settings → Monitoring), read again before each wait so a change made on
 * any instance applies after at most one interval; setGmailPollInterval also reschedules this instance at once.
 */
export function startGmailMonitor(): void {
  if (!gmailConfigured) {
    logger.info({ source: gmailSource }, 'Gmail not configured; monitor disabled (manual upload still available)');
    return;
  }
  monitorTick = pollGmailNow;
  void scheduleNext(true);
}

/** Bumped on every (re)schedule: a chain that was superseded while it polled stops instead of running a second loop. */
let generation = 0;
async function scheduleNext(runNow: boolean): Promise<void> {
  const mine = ++generation;
  if (timer) clearTimeout(timer);
  timer = null;
  const seconds = await gmailPollIntervalSeconds().catch((err) => {
    logger.error({ err }, 'reading the Gmail poll interval failed');
    return POLL_INTERVAL_DEFAULT;
  });
  if (!monitorTick || mine !== generation) return;
  // Tracked, so graceful shutdown waits for a poll in flight before closing the pools.
  if (seconds > 0 && runNow) await track(monitorTick());
  if (!monitorTick || mine !== generation) return;
  timer = setTimeout(() => void scheduleNext(true), seconds > 0 ? seconds * 1000 : GMAIL_OFF_RECHECK_MS);
}

/** Applies a changed interval on this instance now (polling once if it was just turned on or shortened). */
export function rescheduleGmailMonitor(): void {
  if (monitorTick) void scheduleNext(true);
}

export function stopGmailMonitor(): void {
  monitorTick = null;
  if (timer) clearTimeout(timer);
  void mcp.closeMcp();
}
