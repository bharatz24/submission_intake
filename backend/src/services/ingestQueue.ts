import { config } from '../config.js';
import {
  INGEST_BACKOFF_MAX,
  INGEST_BACKOFF_UNIT,
  INGEST_BATCH_SIZE,
  INGEST_LEASE_INTERVAL,
  INGEST_MAX_PER_DRAIN,
} from '../constants.js';
import { pool, type Queryable } from '../db/pool.js';
import { logger } from '../logger.js';
import { audit, recordSystemError } from './audit.js';
import { isRetryableDriveError, StorageError } from './driveStorage.js';
import { withAdvisoryLock } from './pgListen.js';

/**
 * gmail_ingest_queue: Gmail message IDs seen but not yet ingested. IDs are inserted before the poll cursor moves
 * and a row is deleted only once the email and all its attachments are stored, so a failed ingest is fetched
 * from Gmail again later instead of being lost. Retries back off up to every 6 hours; after GMAIL_RETRY_ALERT_AFTER
 * attempts the row is flagged on Monitoring, and after INGEST_MAX_ATTEMPTS it is parked (PERF-07, a dead letter):
 * never claimed again, kept on the Errors tab, until someone retries it (which unparks it). The row is never deleted
 * on failure, so the message is not lost.
 */

export type QueueSource = 'OAUTH' | 'MCP';

/**
 * Outcome of one ingest attempt; GONE means the message no longer exists in Gmail, SKIPPED that it was classified
 * as not a submission and nothing but a skipped_emails row was stored.
 */
export type IngestOutcome = 'CREATED' | 'EXISTING' | 'GONE' | 'SKIPPED';

/**
 * Queue message IDs not ingested (or skipped) yet. Run in the same transaction that moves the poll cursor.
 * `imported`: a manual import (Settings → Import older email); those emails are classified but wait for Process.
 * A message already queued keeps the way it was queued.
 */
export async function enqueueMessages(
  db: Queryable,
  ids: string[],
  source: QueueSource,
  opts: { imported?: boolean } = {},
): Promise<number> {
  if (!ids.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO gmail_ingest_queue (gmail_message_id, source, imported)
     SELECT t.mid, $2, $3 FROM unnest($1::text[]) AS t(mid)
     WHERE NOT EXISTS (SELECT 1 FROM emails e WHERE e.gmail_message_id=t.mid)
       AND NOT EXISTS (SELECT 1 FROM skipped_emails k WHERE k.gmail_message_id=t.mid)
     ON CONFLICT (gmail_message_id) DO NOTHING`,
    [[...new Set(ids)], source, Boolean(opts.imported)],
  );
  return rowCount ?? 0;
}

interface QueueRow {
  gmail_message_id: string;
  attempts: number;
  alerted_at: Date | null;
  imported: boolean;
}

/** Due and not parked: what the drain may claim. */
const DUE = 'next_attempt_at <= now() AND parked_at IS NULL';

/** Ingests one queued message; `imported` says it came from a manual import. */
export type IngestFn = (id: string, opts: { imported: boolean }) => Promise<IngestOutcome>;

/** Claim due rows, oldest first, by leasing them; no transaction is held while a message is ingested. */
async function claim(limit: number): Promise<QueueRow[]> {
  const { rows } = await pool.query<QueueRow>(
    `UPDATE gmail_ingest_queue q SET next_attempt_at = now() + ${INGEST_LEASE_INTERVAL}
     WHERE q.gmail_message_id IN (
       SELECT gmail_message_id FROM gmail_ingest_queue WHERE ${DUE}
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING q.gmail_message_id, q.attempts, q.alerted_at, q.imported`,
    [limit],
  );
  return rows;
}

let draining = false;

/**
 * Ingest every due queued message with `ingest`. Returns the number of submissions created. One drain at a time
 * across all instances (advisory lock): leases already keep rows apart, the lock keeps Gmail API use serial.
 */
export async function drainQueue(ingest: IngestFn): Promise<number> {
  if (draining) return 0;
  draining = true;
  try {
    return (await withAdvisoryLock('gmail_ingest_queue:drain', () => drainLocked(ingest))) ?? 0;
  } finally {
    draining = false;
  }
}

async function drainLocked(ingest: IngestFn): Promise<number> {
  let created = 0;
  for (let handled = 0; handled < INGEST_MAX_PER_DRAIN; ) {
    const rows = await claim(INGEST_BATCH_SIZE);
    if (!rows.length) break;
    for (const row of rows) {
      handled++;
      try {
        const outcome = await ingest(row.gmail_message_id, { imported: row.imported });
        await pool.query('DELETE FROM gmail_ingest_queue WHERE gmail_message_id=$1', [row.gmail_message_id]);
        if (outcome === 'CREATED') created++;
        if (outcome === 'GONE') {
          await audit({
            action: 'GMAIL_MESSAGE_GONE',
            entityType: 'gmail_message',
            entityId: row.gmail_message_id,
            actorId: null,
            details: { attempts: row.attempts },
          });
        }
      } catch (err) {
        await recordFailure(row, err);
      }
    }
  }
  return created;
}

async function recordFailure(row: QueueRow, err: unknown): Promise<void> {
  const attempts = row.attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, id: row.gmail_message_id, attempts }, 'failed to ingest gmail message; will retry');
  const alert = attempts >= config.GMAIL_RETRY_ALERT_AFTER && !row.alerted_at;
  const park = attempts >= config.INGEST_MAX_ATTEMPTS;
  await pool.query(
    `UPDATE gmail_ingest_queue SET attempts=$2::int, last_error=$3,
       next_attempt_at = now() + least(power(2, $2::int) * interval '${INGEST_BACKOFF_UNIT}', interval '${INGEST_BACKOFF_MAX}'),
       alerted_at = CASE WHEN $4 THEN now() ELSE alerted_at END,
       parked_at = CASE WHEN $5 THEN now() ELSE NULL END
     WHERE gmail_message_id=$1`,
    [row.gmail_message_id, attempts, message.slice(0, 2000), alert, park],
  );
  if (park) {
    logger.error({ id: row.gmail_message_id, attempts }, 'gmail message parked after too many failed ingests');
    await recordSystemError(
      `gmail:${row.gmail_message_id}`,
      new Error(`Parked after ${attempts} failed attempts: ${message}`),
    );
    await audit({
      action: 'GMAIL_INGEST_PARKED',
      entityType: 'gmail_message',
      entityId: row.gmail_message_id,
      actorId: null,
      details: { attempts, error: message.slice(0, 500) },
    });
    return;
  }
  // A permanent problem (bad credentials, missing folder) is surfaced at once; transient ones only once they persist.
  const permanent = err instanceof StorageError ? err.kind === 'CONFIG' : false;
  if ((permanent && attempts === 1) || alert) await recordSystemError(`gmail:${row.gmail_message_id}`, err);
  if (alert) {
    await audit({
      action: 'GMAIL_INGEST_DELAYED',
      entityType: 'gmail_message',
      entityId: row.gmail_message_id,
      actorId: null,
      details: { attempts, error: message.slice(0, 500), retryable: isRetryableDriveError(err) },
    });
  }
}

export interface FailedMessage {
  gmailMessageId: string;
  source: QueueSource;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  firstSeenAt: string;
  /** Parked after INGEST_MAX_ATTEMPTS: not retried until someone retries it. */
  parked: boolean;
}

/** Queued messages that failed at least once (Inbox → Errors tab). The email itself is not stored yet, so only the error is known. */
export async function listFailed(limit = 200): Promise<FailedMessage[]> {
  const { rows } = await pool.query(
    `SELECT gmail_message_id, source, attempts, last_error, next_attempt_at, created_at, parked_at FROM gmail_ingest_queue
     WHERE attempts > 0 ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    gmailMessageId: r.gmail_message_id,
    source: r.source,
    attempts: r.attempts,
    lastError: r.last_error,
    nextAttemptAt: new Date(r.next_attempt_at).toISOString(),
    firstSeenAt: new Date(r.created_at).toISOString(),
    parked: r.parked_at !== null,
  }));
}

/**
 * Make one queued message due now, unparking it; false when it is no longer queued (ingested, skipped or gone
 * meanwhile). A parked message gets one more attempt before it is parked again.
 */
export async function retryMessage(gmailMessageId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE gmail_ingest_queue SET next_attempt_at=now(), parked_at=NULL WHERE gmail_message_id=$1',
    [gmailMessageId],
  );
  return !!rowCount;
}

/** Make every queued message due now, parked ones included (Settings → Monitoring "Retry now"). */
export async function retryNow(): Promise<number> {
  const { rowCount } = await pool.query('UPDATE gmail_ingest_queue SET next_attempt_at=now(), parked_at=NULL');
  return rowCount ?? 0;
}

export async function queueStats(): Promise<{
  waiting: number;
  alerted: number;
  parked: number;
  oldest: string | null;
}> {
  const {
    rows: [r],
  } = await pool.query(
    `SELECT count(*)::int AS waiting, count(alerted_at)::int AS alerted, count(parked_at)::int AS parked,
       min(created_at) AS oldest FROM gmail_ingest_queue`,
  );
  return {
    waiting: r.waiting,
    alerted: r.alerted,
    parked: r.parked,
    oldest: r.oldest ? new Date(r.oldest).toISOString() : null,
  };
}
