import { z } from 'zod';

import { config, gmailConfigured } from '../config.js';
import { WORKER_CLAIM_DEADLINE_MS, WORKER_HARD_DEADLINE_MS } from '../constants.js';
import { defaultDeps } from '../deps.js';
import { logger } from '../logger.js';
import { createGmailService } from '../modules/gmail/gmail.service.js';
import { createIms2Service } from '../modules/ims2/ims2.service.js';
import { createRatingService } from '../modules/rating/rating.service.js';
import { purgeStaleUploads } from '../modules/uploads/chunkStore.js';
import { gmailPollIntervalSeconds } from '../services/appSettings.js';
import { recordSystemError } from '../services/audit.js';
import { failInterruptedChat } from '../services/chat.js';
import { requeueOrphanedComparisons } from '../services/comparisons.js';
import { failInterruptedDrafts } from '../services/emailDraft.js';
import { pollGmailNow } from '../services/gmail.js';
import { jobs } from '../services/jobQueue.js';
import { requeueStalledSubmissions } from '../services/pipeline.js';
import { ensureGeoImported } from '../services/rating/geoImport.js';
import { ensureRatesImported } from '../services/rating/importer.js';
import { CHECK_SCOPES, reconcileGmail, runScheduledCheck, sweepDriveOrphans } from '../services/reconcile.js';
import { requeueOrphanedReports } from '../services/reports.js';
import { runRetention } from '../services/retention.js';
import { isWorkerTask, type WorkerPayload, type WorkerTask } from './workerTrigger.js';

/** The person who started a UI task: required by those tasks, checked because the body arrives over HTTP. */
const ActorPayload = z.object({ actor: z.object({ id: z.string().min(1), name: z.string() }) });
const actorOf = (task: WorkerTask, payload: WorkerPayload) => {
  const parsed = ActorPayload.safeParse(payload);
  if (!parsed.success) throw new Error(`Worker task ${task} needs { actor: { id, name } }`);
  return parsed.data.actor;
};

/** Claim and run queued jobs until none is left, within the background function's 15-minute limit. */
async function drainJobs(): Promise<void> {
  const result = await jobs.runUntilIdle({
    claimDeadlineMs: WORKER_CLAIM_DEADLINE_MS,
    hardDeadlineMs: WORKER_HARD_DEADLINE_MS,
  });
  logger.info(result, 'worker drain finished');
}

/**
 * Work left with no job behind it (what server.ts does at startup), then the queue: due retries and jobs whose
 * worker was killed at the time limit (lapsed lease) are only picked up here when nothing triggered a worker.
 * Each requeue is guarded by "no queued or running job", so running it every minute beside live workers is safe.
 */
async function recover(): Promise<void> {
  const requeued = {
    submissions: await requeueStalledSubmissions(),
    reports: await requeueOrphanedReports(),
    comparisons: await requeueOrphanedComparisons(),
  };
  if (requeued.submissions || requeued.reports || requeued.comparisons)
    logger.warn(requeued, 'requeued unfinished work');
  await failInterruptedChat();
  await failInterruptedDrafts();
  if ((await jobs.depth()) > 0) await drainJobs();
}

/** The Gmail monitor tick, unless Gmail is not configured or Settings → Monitoring has polling off (interval 0). */
async function gmailPoll(): Promise<void> {
  if (!gmailConfigured) return;
  if ((await gmailPollIntervalSeconds()) <= 0) return;
  await pollGmailNow();
}

/** Rate tables, then ZIP data, on a fresh database (server.ts does this at startup). Failures recorded, not thrown. */
async function bootstrap(): Promise<void> {
  try {
    await ensureRatesImported();
  } catch (err) {
    logger.error({ err }, 'rate import failed');
    await recordSystemError('rates', err);
  }
  if (!config.GEO_AUTO_IMPORT) return;
  try {
    await ensureGeoImported();
  } catch (err) {
    logger.error({ err }, 'ZIP data import failed');
    await recordSystemError('geo', err);
  }
}

const TASKS: Record<WorkerTask, (payload: WorkerPayload) => Promise<void>> = {
  jobs: drainJobs,
  recover,
  'gmail-poll': gmailPoll,
  'gmail-reconcile': () =>
    gmailConfigured ? runScheduledCheck(CHECK_SCOPES.gmail, reconcileGmail) : Promise.resolve(),
  'drive-orphans': () => runScheduledCheck(CHECK_SCOPES.driveOrphans, sweepDriveOrphans),
  retention: async () => {
    await runScheduledCheck(CHECK_SCOPES.retention, () => runRetention());
    // Chunked uploads nobody used (a closed tab mid-upload).
    const purged = await purgeStaleUploads(defaultDeps().chunks).catch((err: unknown) => {
      logger.warn({ err }, 'stale upload purge failed');
      return 0;
    });
    if (purged) logger.info({ purged }, 'deleted abandoned chunked uploads');
  },
  bootstrap,
  'gmail-manual-poll': async (p) => {
    await createGmailService(defaultDeps()).runManualPoll(actorOf('gmail-manual-poll', p).id);
  },
  'ims2-sync': async (p) => {
    await createIms2Service(defaultDeps()).runSync(actorOf('ims2-sync', p));
  },
  'geo-import': (p) => createRatingService(defaultDeps()).runGeoImport(actorOf('geo-import', p)),
};

/** Run one task of the Netlify background worker (netlify/functions/worker-background.mts). */
export async function runWorkerTask(task: WorkerTask, payload: WorkerPayload = {}): Promise<void> {
  if (!isWorkerTask(task)) throw new Error(`Unknown worker task: ${String(task)}`);
  logger.info({ task }, 'worker task started');
  await TASKS[task](payload);
}
