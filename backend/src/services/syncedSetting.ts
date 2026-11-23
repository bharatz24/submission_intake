import { isNetlifyRuntime } from '../config.js';
import { SYNCED_SETTING_MAX_AGE_MS } from '../constants.js';
import { logger } from '../logger.js';
import { listen } from './pgListen.js';

/**
 * In-memory settings kept in step across instances (CQ-08). `listen` (a long-running server): re-read on a NOTIFY on
 * `channel` (sent by whichever instance saved a change) and every `resyncMs` as a fallback for a missed notification.
 * `poll` (RUNTIME=netlify, where a function instance holds no LISTEN connection and its timers freeze between
 * requests): re-read by ensureFresh() at the start of a request once the value is older than SYNCED_SETTING_MAX_AGE_MS.
 * Used by the Anthropic settings, Settings → Limits and the skill overrides.
 */
export function createSyncedSetting(opts: {
  channel: string;
  /** Re-reads the setting from the database into memory. */
  refresh: () => Promise<void>;
  resyncMs: number;
  /** Names the setting in the warning a failed refresh logs. */
  name: string;
  /** Default: `poll` when RUNTIME=netlify, else `listen`. */
  mode?: 'listen' | 'poll';
}) {
  const mode = opts.mode ?? (isNetlifyRuntime() ? 'poll' : 'listen');
  let resync: NodeJS.Timeout | null = null;
  let refreshedAt = 0;
  let inFlight: Promise<void> | null = null;
  const refresh = async () => {
    await opts.refresh();
    refreshedAt = Date.now();
  };
  const refreshQuietly = () => void refresh().catch((err) => logger.warn({ err }, `${opts.name} refresh failed`));
  return {
    /** Startup: load now unless `initial` is false (the caller just loaded it), then follow saves on any instance. */
    async start({ initial = true }: { initial?: boolean } = {}): Promise<void> {
      if (initial) await refresh();
      else refreshedAt = Date.now();
      if (mode === 'poll') return;
      await listen(opts.channel, refreshQuietly);
      resync ??= setInterval(refreshQuietly, opts.resyncMs).unref();
    },
    /**
     * Poll mode: re-read when the value is older than SYNCED_SETTING_MAX_AGE_MS (concurrent callers share one read).
     * A failed read is logged, not thrown: the request carries on with the value it has. Listen mode: nothing to do.
     * `maxAgeMs: 0` re-reads now: Settings screens use it so a GET right after a save on another instance is current.
     */
    async ensureFresh({ maxAgeMs = SYNCED_SETTING_MAX_AGE_MS }: { maxAgeMs?: number } = {}): Promise<void> {
      if (mode !== 'poll' || Date.now() - refreshedAt < maxAgeMs) return;
      inFlight ??= refresh()
        .catch((err: unknown) => logger.warn({ err }, `${opts.name} refresh failed`))
        .finally(() => {
          inFlight = null;
        });
      await inFlight;
    },
    stop(): void {
      if (resync) clearInterval(resync);
      resync = null;
    },
  };
}
