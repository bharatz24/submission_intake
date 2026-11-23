import { config, gmailConfigured, gmailSource } from '../config.js';
import {
  DRIVE_ORPHAN_LOOKUP_BATCH,
  DRIVE_ORPHAN_SWEEP_EVERY_MS,
  DRIVE_ORPHAN_SWEEP_FIRST_AFTER_MS,
  GMAIL_RECONCILE_EVERY_MS,
  GMAIL_RECONCILE_FIRST_AFTER_MS,
  ORPHAN_AGE_MS,
  RETENTION_EVERY_MS,
  RETENTION_FIRST_AFTER_MS,
} from '../constants.js';
import { pool } from '../db/pool.js';
import { integrations } from '../integrations/index.js';
import { logger } from '../logger.js';
import { audit, recordSystemError } from './audit.js';
import { track } from './backgroundTasks.js';
import * as gmail from './gmail.js';
import { enqueueMessages } from './ingestQueue.js';
import { withAdvisoryLock } from './pgListen.js';
import { runRetention } from './retention.js';

/**
 * Checks that turn "no document was missed" into something verified every day:
 * - Gmail ↔ DB: every recent message in the inbox is ingested or queued, and each ingested message has as
 *   many documents + recorded gaps as Gmail has attachments.
 * - Drive orphan sweep (weekly): files this app uploaded that no document row points to (a crash between upload
 *   and commit) are moved to trash.
 */

/**
 * Queue every message in the inbox from the last `days` days that is neither ingested nor queued.
 * `automatic` leaves out mail received before automatic ingestion started (services/appSettings.ts); without it this
 * is a manual import, whose emails are classified but wait for a person to press Process.
 */
export async function enqueueRecentGmail(
  days: number,
  opts: { automatic?: boolean; after?: Date } = {},
): Promise<{ ids: string[]; enqueued: number }> {
  const ids = await integrations().gmail.listRecentMessageIds(days, opts);
  return { ids, enqueued: await enqueueMessages(pool, ids, gmailSource, { imported: !opts.automatic }) };
}

export async function reconcileGmail(): Promise<{ enqueued: number; mismatches: number }> {
  const { ids, enqueued } = await enqueueRecentGmail(config.RECONCILE_DAYS, { automatic: true });
  if (enqueued) {
    logger.warn({ enqueued }, 'reconciliation found gmail messages that were neither ingested nor queued');
    await audit({
      action: 'RECONCILE_ENQUEUED',
      entityType: 'gmail_message',
      actorId: null,
      details: { enqueued, days: config.RECONCILE_DAYS },
    });
  }

  let mismatches = 0;
  const { rows } = await pool.query<{ gmail_message_id: string; stored: number }>(
    `SELECT e.gmail_message_id,
       (SELECT count(*)::int FROM documents d WHERE d.submission_id=s.id)
       + (SELECT count(*)::int FROM attachment_gaps g WHERE g.submission_id=s.id AND g.reason<>'LINKED_FILE') AS stored
     FROM emails e JOIN submissions s ON s.email_id=e.id
     WHERE e.gmail_message_id = ANY($1)`,
    [ids],
  );
  for (const row of rows) {
    const expected = await gmail.gmailAttachmentCount(row.gmail_message_id).catch((err) => {
      logger.warn({ err, id: row.gmail_message_id }, 'reconciliation could not read gmail message');
      return null;
    });
    if (expected === null || expected === row.stored) continue;
    mismatches++;
    // The window overlaps from day to day: a mismatch is reported once, not on every run.
    const scope = `reconcile:${row.gmail_message_id}`;
    const { rowCount } = await pool.query('SELECT 1 FROM system_errors WHERE scope=$1 LIMIT 1', [scope]);
    if (!rowCount)
      await recordSystemError(
        scope,
        `Gmail has ${expected} attachment(s) but ${row.stored} are stored or recorded as gaps`,
      );
  }
  return { enqueued, mismatches };
}

export async function sweepDriveOrphans(): Promise<number> {
  const orphans: { id: string; name: string }[] = [];
  let page: { id: string; name: string }[] = [];
  const flush = async () => {
    const { rows } = await pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM documents WHERE storage_backend='GDRIVE' AND storage_key = ANY($1)`,
      [page.map((f) => f.id)],
    );
    const known = new Set(rows.map((r) => r.storage_key));
    orphans.push(...page.filter((f) => !known.has(f.id)));
    page = [];
  };
  for await (const f of integrations().drive.listAppFiles(new Date(Date.now() - ORPHAN_AGE_MS))) {
    page.push(f);
    if (page.length < DRIVE_ORPHAN_LOOKUP_BATCH) continue;
    await flush();
    if (orphans.length > config.GDRIVE_ORPHAN_SWEEP_MAX) break;
  }
  if (page.length) await flush();
  // Counted before anything is trashed. Thrown so the run shows as failed on Monitoring, not as a clean sweep.
  if (orphans.length > config.GDRIVE_ORPHAN_SWEEP_MAX) {
    throw new Error(
      `Drive orphan sweep stopped: more than ${config.GDRIVE_ORPHAN_SWEEP_MAX} files have no document here, nothing was trashed. Check that no other environment uses GDRIVE_ROOT_FOLDER_NAME="${config.GDRIVE_ROOT_FOLDER_NAME}" and the database is the right one. If they are real leftovers, raise GDRIVE_ORPHAN_SWEEP_MAX for one run.`,
    );
  }
  for (const f of orphans) {
    await integrations().drive.trash(f.id);
    logger.info({ fileId: f.id, name: f.name }, 'trashed orphaned drive file');
  }
  const trashed = orphans.length;
  if (trashed)
    await audit({ action: 'DRIVE_ORPHANS_TRASHED', entityType: 'drive', actorId: null, details: { trashed } });
  return trashed;
}

const timers: NodeJS.Timeout[] = [];

/** Advisory-lock scopes of the scheduled checks; one instance runs each at a time. */
export const CHECK_SCOPES = {
  gmail: 'reconcile:gmail',
  driveOrphans: 'reconcile:drive-orphans',
  retention: 'retention:purge',
} as const;

/**
 * Run a scheduled check under its advisory lock (skipped while another instance runs it). A failure is logged and
 * recorded on Monitoring, never thrown: the failure handler must not fail itself either.
 */
export async function runScheduledCheck(scope: string, fn: () => Promise<unknown>): Promise<void> {
  await withAdvisoryLock(scope, fn).catch(async (err: unknown) => {
    try {
      logger.error({ err, scope }, 'scheduled check failed');
      await recordSystemError(scope, err);
    } catch (inner) {
      console.error(`scheduled check ${scope} failed, and recording the failure failed too`, inner);
    }
  });
}

function every(ms: number, firstAfterMs: number, scope: string, fn: () => Promise<unknown>) {
  // Every instance has the timer; the advisory lock lets one of them run the check at a time.
  // Tracked, so graceful shutdown waits for a check in flight before closing the pools.
  const run = () => void track(runScheduledCheck(scope, fn));
  timers.push(setTimeout(run, firstAfterMs).unref(), setInterval(run, ms).unref());
}

export function startReconciliation(): void {
  // First runs are delayed so startup and the first Gmail poll are not slowed down.
  if (gmailConfigured)
    every(GMAIL_RECONCILE_EVERY_MS, GMAIL_RECONCILE_FIRST_AFTER_MS, CHECK_SCOPES.gmail, reconcileGmail);
  every(DRIVE_ORPHAN_SWEEP_EVERY_MS, DRIVE_ORPHAN_SWEEP_FIRST_AFTER_MS, CHECK_SCOPES.driveOrphans, sweepDriveOrphans);
  // Settings → Retention; with every period at "keep forever" (the default) a run deletes nothing.
  every(RETENTION_EVERY_MS, RETENTION_FIRST_AFTER_MS, CHECK_SCOPES.retention, () => runRetention());
}

export function stopReconciliation(): void {
  for (const t of timers.splice(0)) clearTimeout(t);
}
