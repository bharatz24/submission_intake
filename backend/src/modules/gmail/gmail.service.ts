import { IMPORT_TODAY_TIME_ZONE } from '../../constants.js';
import { pool } from '../../db/pool.js';
import type { AppDeps } from '../../deps.js';
import { AppError } from '../../http.js';
import { logger } from '../../logger.js';
import {
  gmailAutoImportSince,
  gmailPollIntervalSeconds,
  IMPORT_DAYS_MAX,
  IMPORT_DAYS_MIN,
  POLL_INTERVAL_MAX,
  POLL_INTERVAL_MIN,
  setGmailPollIntervalSeconds,
} from '../../services/appSettings.js';
import { audit } from '../../services/audit.js';
import { runInBackground, start } from '../../services/backgroundTasks.js';
import { rangeStart } from '../../services/llmUsage.js';
import { enqueueRecentGmail } from '../../services/reconcile.js';
import { countHeldForImport } from '../processing/processing.repository.js';

/** The team mailbox's connection and import settings, through the injected Gmail client. */
export function createGmailService({ gmail }: Pick<AppDeps, 'gmail'>) {
  /**
   * A poll in the background; a failure is logged, never answered (the request has its answer). Tracked, so graceful
   * shutdown waits for it (backgroundTasks.ts). Netlify: worker (a poll can take minutes); await it before answering.
   */
  const pollSoon = (why: string): Promise<void> =>
    runInBackground(
      `gmail:${why}`,
      () => gmail.pollOnce().catch((err) => logger.error({ err }, `${why} poll failed`)),
      { worker: { task: 'gmail-poll' } },
    );

  /** A manual poll, then its audit row with how many messages were processed. */
  const runManualPoll = async (actorId: string): Promise<number> => {
    const processed = await gmail.pollOnce({ manual: true });
    await audit({ action: 'GMAIL_MANUAL_POLL', entityType: 'gmail_account', actorId, details: { processed } });
    return processed;
  };

  return {
    pollSoon,
    runManualPoll,

    async authUrl(userId: string) {
      const st = await gmail.status();
      if (st.source === 'MCP')
        throw new AppError('GMAIL_VIA_MCP', 400, 'Gmail is read through MCP; no OAuth connection is needed');
      if (!st.configured)
        throw new AppError('GMAIL_NOT_CONFIGURED', 400, 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server');
      return gmail.authUrl(userId);
    },

    /**
     * "Poll now" (PERF-01): up to a few hundred messages, so it runs in the background and the request answers 202 at
     * once; new emails reach the inbox (and the notification stream) as they are stored. False when a manual poll is
     * already running on this instance. The audit row records how many were processed once it ends.
     */
    pollNow(actor: { id: string; name: string }): Promise<boolean> {
      // Netlify: worker (up to a few hundred messages).
      return start('gmail:manual-poll', () => runManualPoll(actor.id), undefined, {
        worker: { task: 'gmail-manual-poll', payload: { actor } },
      });
    },

    async importSettings() {
      const [since, pollIntervalSeconds, awaitingProcess] = await Promise.all([
        gmailAutoImportSince({ create: false }),
        gmailPollIntervalSeconds(),
        countHeldForImport(pool),
      ]);
      return {
        minDays: IMPORT_DAYS_MIN,
        maxDays: IMPORT_DAYS_MAX,
        autoImportSince: since?.toISOString() ?? null,
        pollIntervalSeconds,
        minPollIntervalSeconds: POLL_INTERVAL_MIN,
        maxPollIntervalSeconds: POLL_INTERVAL_MAX,
        // Imported emails classified but not processed yet (POST /submissions/imported/process-all).
        awaitingProcess,
      };
    },

    async setPollInterval(seconds: number, actorId: string) {
      const previous = await gmailPollIntervalSeconds();
      await setGmailPollIntervalSeconds(seconds, actorId);
      await audit({
        action: 'GMAIL_POLL_INTERVAL_CHANGED',
        entityType: 'app_setting',
        actorId,
        details: { previous, seconds },
      });
      gmail.rescheduleMonitor();
    },

    /**
     * Queues every inbox email not already here, then ingests in the background: from the last `days` days,
     * or `today` from midnight US Eastern.
     */
    async importRecent(scope: { days: number } | { today: true }, actorId: string) {
      if (!(await gmail.status()).connected)
        throw new AppError('GMAIL_NOT_CONNECTED', 409, 'Connect Gmail before importing older emails');
      if ('today' in scope) {
        const since = (await rangeStart('today', IMPORT_TODAY_TIME_ZONE))!;
        const { ids, enqueued } = await enqueueRecentGmail(1, { after: since });
        const result = { today: true, since: since.toISOString(), found: ids.length, enqueued };
        await audit({ action: 'GMAIL_IMPORT_REQUESTED', entityType: 'gmail_message', actorId, details: result });
        if (enqueued) await pollSoon('import');
        return result;
      }
      const { days } = scope;
      const { ids, enqueued } = await enqueueRecentGmail(days);
      await audit({
        action: 'GMAIL_IMPORT_REQUESTED',
        entityType: 'gmail_message',
        actorId,
        details: { days, found: ids.length, enqueued },
      });
      if (enqueued) await pollSoon('import');
      return { days, found: ids.length, enqueued };
    },
  };
}
