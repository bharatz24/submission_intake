import { createApp } from './app.js';
import { config, redactedConfig } from './config.js';
import { SHUTDOWN_GRACE_MS } from './constants.js';
import { migrate, pendingMigrations } from './db/migrate.js';
import { closePools } from './db/pool.js';
import { logger } from './logger.js';
import { closeAllStreams } from './modules/events/events.routes.js';
import { startAnthropicSettings, stopAnthropicSettingsSync } from './services/anthropicSettings.js';
import { recordSystemError } from './services/audit.js';
import { drainBackground, track } from './services/backgroundTasks.js';
import { failInterruptedChat } from './services/chat.js';
import { claudeAvailable } from './services/claude.js';
import { requeueOrphanedComparisons } from './services/comparisons.js';
import { failInterruptedDrafts } from './services/emailDraft.js';
import { stopExtraction } from './services/extractionPool.js';
import { startGmailMonitor, stopGmailMonitor } from './services/gmail.js';
import { startIms2QueueSettings, stopIms2QueueSettingsSync } from './services/ims2QueueSettings.js';
import { jobs } from './services/jobQueue.js';
import { startLimitsSettings, stopLimitsSettingsSync } from './services/limitsSettings.js';
import { closeListener } from './services/pgListen.js';
import { requeueStalledSubmissions } from './services/pipeline.js';
import { ensureGeoImported } from './services/rating/geoImport.js';
import { ensureRatesImported } from './services/rating/importer.js';
import { stopWorkbookParser } from './services/rating/workbookParser.js';
import { startReconciliation, stopReconciliation } from './services/reconcile.js';
import { requeueOrphanedReports } from './services/reports.js';
import { refreshSkillOverrides, startSkillOverrideSync, stopSkillOverrideSync } from './services/skillEditor.js';

/** Logs through pino, falling back to stderr when logging itself throws (QA-001 was such a throw). */
function logSafely(level: 'error' | 'fatal', err: unknown, msg: string) {
  try {
    logger[level]({ err }, msg);
  } catch (logErr) {
    console.error(msg, err, logErr);
  }
}

/**
 * Last-resort handlers. A rejected promise nobody handled is a bug in that one task: it is logged and recorded on
 * Monitoring, and the server keeps answering. An uncaught exception leaves the process in an unknown state: it is
 * logged and the process exits with code 1, for the supervisor (compose `restart: unless-stopped`) to start it again.
 */
process.on('unhandledRejection', (reason) => {
  logSafely('error', reason, 'unhandled promise rejection');
  void recordSystemError('process:unhandledRejection', reason).catch(() => undefined);
});
process.on('uncaughtException', (err) => {
  logSafely('fatal', err, 'uncaught exception; exiting');
  process.exit(1);
});

async function main() {
  logger.info({ config: redactedConfig() }, 'configuration');
  if (config.MIGRATE_ON_BOOT) {
    const ran = await migrate();
    if (ran.length) logger.info({ ran }, 'migrations applied');
  } else {
    // Migrations are a release step here (backup first, docs/deploy.md); running on an older schema would fail later.
    const pending = await pendingMigrations();
    if (pending.length)
      throw new Error(`Pending migrations (${pending.join(', ')}): run the release step before starting the API`);
  }
  await refreshSkillOverrides();
  await startSkillOverrideSync();
  await startAnthropicSettings();
  await startIms2QueueSettings();
  await startLimitsSettings();
  // Work a previous run left unfinished with no job behind it; jobs of crashed workers come back by lease expiry.
  const requeued = {
    submissions: await requeueStalledSubmissions(),
    reports: await requeueOrphanedReports(),
    comparisons: await requeueOrphanedComparisons(),
  };
  if (requeued.submissions || requeued.reports || requeued.comparisons)
    logger.warn(requeued, 'requeued unfinished work');
  await failInterruptedChat();
  await failInterruptedDrafts();
  jobs.start();
  if (!claudeAvailable())
    logger.warn(
      'No Anthropic API key in Settings → Claude API: classification falls back to rules; reports and chat disabled',
    );

  const server = createApp().listen(config.PORT, () => logger.info(`API listening on http://localhost:${config.PORT}`));
  startGmailMonitor();
  startReconciliation();
  // Quoting needs rate tables and ZIP data; load them in the background on a fresh database.
  // Tracked, so a shutdown during the first import waits for it (backgroundTasks.ts).
  void track(
    ensureRatesImported()
      .catch((err) => {
        logger.error({ err }, 'rate import failed');
        return recordSystemError('rates', err);
      })
      .then(() => (config.GEO_AUTO_IMPORT ? ensureGeoImported() : undefined))
      .catch((err) => {
        logger.error({ err }, 'ZIP data import failed');
        return recordSystemError('geo', err);
      }),
  );

  /**
   * Graceful stop: refuse new connections and end notification streams, stop timers, let running jobs finish
   * for up to SHUTDOWN_TIMEOUT_MS (the rest go back to the queue for another instance), then close the pool.
   * A second signal exits at once.
   */
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      logger.warn({ signal }, 'second signal: exiting now');
      process.exit(1);
    }
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    closeAllStreams();
    server.closeIdleConnections();
    stopGmailMonitor();
    stopReconciliation();
    stopSkillOverrideSync();
    stopAnthropicSettingsSync();
    stopIms2QueueSettingsSync();
    stopLimitsSettingsSync();
    // Running jobs, and in-process background work (a Gmail poll or reconcile in flight, a manual poll, an IMS 2
    // sync, a ZIP reload: backgroundTasks.ts), finish within the same deadline before the pools close (PERF-04).
    const [, unfinished] = await Promise.all([
      jobs.stop(config.SHUTDOWN_TIMEOUT_MS),
      drainBackground(config.SHUTDOWN_TIMEOUT_MS),
    ]);
    if (unfinished) logger.warn({ tasks: unfinished }, 'background work still running at shutdown; it is cut off');
    // Requests still in flight after the job deadline are cut rather than holding the exit.
    const grace = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
    await closed;
    clearTimeout(grace);
    await Promise.all([stopExtraction(), stopWorkbookParser()]);
    await closeListener();
    await closePools();
    logger.info('shutdown complete');
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(
      signal,
      () =>
        void shutdown(signal).catch((err) => {
          logger.error({ err }, 'shutdown failed');
          process.exit(1);
        }),
    );
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
