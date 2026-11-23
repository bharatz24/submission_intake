/** Netlify worker task dispatcher (runtime/workerTasks.ts): each task name runs the work server.ts timers did. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  runUntilIdle: vi.fn(async () => ({ ran: 0, released: 0 })),
  depth: vi.fn(async () => 0),
  requeueStalledSubmissions: vi.fn(async () => 0),
  requeueOrphanedReports: vi.fn(async () => 0),
  requeueOrphanedComparisons: vi.fn(async () => 0),
  failInterruptedChat: vi.fn(async () => undefined),
  failInterruptedDrafts: vi.fn(async () => undefined),
  pollGmailNow: vi.fn(async () => undefined),
  gmailPollIntervalSeconds: vi.fn(async () => 60),
  runScheduledCheck: vi.fn(async (_scope: string, fn: () => Promise<unknown>) => {
    await fn();
  }),
  reconcileGmail: vi.fn(async () => ({ enqueued: 0, mismatches: 0 })),
  sweepDriveOrphans: vi.fn(async () => 0),
  runRetention: vi.fn(async () => ({})),
  ensureRatesImported: vi.fn(async () => undefined),
  ensureGeoImported: vi.fn(async () => undefined),
  recordSystemError: vi.fn(async () => undefined),
  runManualPoll: vi.fn(async () => 0),
  runSync: vi.fn(async () => ({})),
  runGeoImport: vi.fn(async () => undefined),
  purgeStaleUploads: vi.fn(async () => 0),
}));

vi.mock('../src/services/jobQueue.js', () => ({ jobs: { runUntilIdle: m.runUntilIdle, depth: m.depth } }));
vi.mock('../src/services/pipeline.js', () => ({ requeueStalledSubmissions: m.requeueStalledSubmissions }));
vi.mock('../src/services/reports.js', () => ({ requeueOrphanedReports: m.requeueOrphanedReports }));
vi.mock('../src/services/comparisons.js', () => ({ requeueOrphanedComparisons: m.requeueOrphanedComparisons }));
vi.mock('../src/services/chat.js', () => ({ failInterruptedChat: m.failInterruptedChat }));
vi.mock('../src/services/emailDraft.js', () => ({ failInterruptedDrafts: m.failInterruptedDrafts }));
vi.mock('../src/services/gmail.js', () => ({ pollGmailNow: m.pollGmailNow }));
vi.mock('../src/services/appSettings.js', () => ({ gmailPollIntervalSeconds: m.gmailPollIntervalSeconds }));
vi.mock('../src/services/reconcile.js', () => ({
  CHECK_SCOPES: { gmail: 'reconcile:gmail', driveOrphans: 'reconcile:drive-orphans', retention: 'retention:purge' },
  runScheduledCheck: m.runScheduledCheck,
  reconcileGmail: m.reconcileGmail,
  sweepDriveOrphans: m.sweepDriveOrphans,
}));
vi.mock('../src/services/retention.js', () => ({ runRetention: m.runRetention }));
vi.mock('../src/services/rating/importer.js', () => ({ ensureRatesImported: m.ensureRatesImported }));
vi.mock('../src/services/rating/geoImport.js', () => ({ ensureGeoImported: m.ensureGeoImported }));
vi.mock('../src/services/audit.js', () => ({ recordSystemError: m.recordSystemError }));
vi.mock('../src/deps.js', () => ({ defaultDeps: () => ({ chunks: 'chunk-store' }) }));
vi.mock('../src/modules/uploads/chunkStore.js', () => ({ purgeStaleUploads: m.purgeStaleUploads }));
vi.mock('../src/modules/gmail/gmail.service.js', () => ({
  createGmailService: () => ({ runManualPoll: m.runManualPoll }),
}));
vi.mock('../src/modules/ims2/ims2.service.js', () => ({ createIms2Service: () => ({ runSync: m.runSync }) }));
vi.mock('../src/modules/rating/rating.service.js', () => ({
  createRatingService: () => ({ runGeoImport: m.runGeoImport }),
}));

const { runWorkerTask } = await import('../src/runtime/workerTasks.js');
const { WORKER_CLAIM_DEADLINE_MS, WORKER_HARD_DEADLINE_MS } = await import('../src/constants.js');

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockClear();
  m.depth.mockResolvedValue(0);
  m.gmailPollIntervalSeconds.mockResolvedValue(60);
});

describe('runWorkerTask', () => {
  it('jobs drains the queue within the function deadlines', async () => {
    await runWorkerTask('jobs');
    expect(m.runUntilIdle).toHaveBeenCalledTimes(1);
    expect(m.runUntilIdle).toHaveBeenCalledWith({
      claimDeadlineMs: WORKER_CLAIM_DEADLINE_MS,
      hardDeadlineMs: WORKER_HARD_DEADLINE_MS,
    });
  });

  it('recover requeues orphaned work and fails interrupted chat and drafts, without draining an empty queue', async () => {
    await runWorkerTask('recover');
    for (const fn of [
      m.requeueStalledSubmissions,
      m.requeueOrphanedReports,
      m.requeueOrphanedComparisons,
      m.failInterruptedChat,
      m.failInterruptedDrafts,
    ])
      expect(fn).toHaveBeenCalledTimes(1);
    expect(m.runUntilIdle).not.toHaveBeenCalled();
  });

  it('recover triggers jobs when queue has depth', async () => {
    m.depth.mockResolvedValue(3);
    await runWorkerTask('recover');
    expect(m.runUntilIdle).toHaveBeenCalledTimes(1);
  });

  it('gmail-poll polls once, and not when polling is turned off in Settings', async () => {
    await runWorkerTask('gmail-poll');
    expect(m.pollGmailNow).toHaveBeenCalledTimes(1);
    m.gmailPollIntervalSeconds.mockResolvedValue(0);
    await runWorkerTask('gmail-poll');
    expect(m.pollGmailNow).toHaveBeenCalledTimes(1);
  });

  it('gmail-reconcile runs the reconciliation under its lock scope', async () => {
    await runWorkerTask('gmail-reconcile');
    expect(m.runScheduledCheck).toHaveBeenCalledWith('reconcile:gmail', m.reconcileGmail);
    expect(m.reconcileGmail).toHaveBeenCalledTimes(1);
  });

  it('drive-orphans runs the sweep under its lock scope', async () => {
    await runWorkerTask('drive-orphans');
    expect(m.runScheduledCheck).toHaveBeenCalledWith('reconcile:drive-orphans', m.sweepDriveOrphans);
    expect(m.sweepDriveOrphans).toHaveBeenCalledTimes(1);
  });

  it('retention runs the purge under its lock scope', async () => {
    await runWorkerTask('retention');
    expect(m.runScheduledCheck).toHaveBeenCalledWith('retention:purge', expect.any(Function));
    expect(m.runRetention).toHaveBeenCalledTimes(1);
    expect(m.purgeStaleUploads).toHaveBeenCalledWith('chunk-store'); // abandoned chunked uploads too
  });

  it('bootstrap imports rates then ZIP data, recording a failure instead of throwing', async () => {
    await runWorkerTask('bootstrap');
    expect(m.ensureRatesImported).toHaveBeenCalledTimes(1);
    expect(m.ensureGeoImported).toHaveBeenCalledTimes(1);
    m.ensureRatesImported.mockRejectedValueOnce(new Error('no workbooks'));
    await expect(runWorkerTask('bootstrap')).resolves.toBeUndefined();
    expect(m.recordSystemError).toHaveBeenCalledWith('rates', expect.any(Error));
    expect(m.ensureGeoImported).toHaveBeenCalledTimes(2);
  });

  it('UI-started tasks run for the person who started them', async () => {
    const actor = { id: 'u1', name: 'Ann' };
    await runWorkerTask('gmail-manual-poll', { actor });
    expect(m.runManualPoll).toHaveBeenCalledWith('u1');
    await runWorkerTask('ims2-sync', { actor });
    expect(m.runSync).toHaveBeenCalledWith(actor);
    await runWorkerTask('geo-import', { actor });
    expect(m.runGeoImport).toHaveBeenCalledWith(actor);
  });

  it('a UI-started task without its actor rejects', async () => {
    await expect(runWorkerTask('ims2-sync', {})).rejects.toThrow(/needs \{ actor/);
    expect(m.runSync).not.toHaveBeenCalled();
  });

  it('unknown task rejects', async () => {
    // @ts-expect-error a task name the worker does not know
    await expect(runWorkerTask('format-disk')).rejects.toThrow(/Unknown worker task/);
  });
});
