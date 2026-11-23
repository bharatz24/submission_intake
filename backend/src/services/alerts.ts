import { hostname } from 'node:os';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { countSystemError, maskIds } from './metrics.js';
import { scrubText } from './piiScrub.js';

/**
 * External alerting for system errors (MON-01). Every error recorded on Monitoring (audit.ts recordSystemError) is
 * counted (ims_system_errors_total) and, when ALERT_WEBHOOK_URL is set, posted as `{ "text": ... }` (what Slack,
 * Mattermost, Teams workflows and most alert routers accept). Deduplicated per scope (ids masked) for
 * ALERT_DEDUPE_MS and capped at ALERT_MAX_PER_HOUR per process, so an outage pages once, not per message. The text is
 * PII-scrubbed and short; the post has a timeout and never throws: alerting must never break the code that reports.
 */
export const ALERT_DEDUPE_MS = 15 * 60_000;
export const ALERT_MAX_PER_HOUR = 20;
const ALERT_TIMEOUT_MS = 5000;
const ALERT_MESSAGE_CHARS = 500;

const lastSent = new Map<string, number>();
let windowStart = 0;
let sentInWindow = 0;
/** Alerts held back per scope since its last one went out, reported with the next. */
const suppressed = new Map<string, number>();

/** Clears the dedupe state (tests). */
export function resetAlerts(): void {
  lastSent.clear();
  windowStart = 0;
  sentInWindow = 0;
  suppressed.clear();
}

/** Whether an alert for `key` may go out now; counts it when it may. */
function admit(key: string, now: number): boolean {
  const last = lastSent.get(key);
  if (last !== undefined && now - last < ALERT_DEDUPE_MS) return false;
  if (now - windowStart >= 60 * 60_000) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= ALERT_MAX_PER_HOUR) return false;
  sentInWindow++;
  lastSent.set(key, now);
  // Bounded memory: forget keys older than the dedupe window.
  if (lastSent.size > 500) for (const [k, t] of lastSent) if (now - t >= ALERT_DEDUPE_MS) lastSent.delete(k);
  return true;
}

/**
 * Called for every recorded system error; returns the post (tests await it), which never rejects. `fetchImpl` is
 * injected in tests.
 */
export function onSystemError(
  scope: string,
  message: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<void> {
  try {
    countSystemError(scope);
  } catch {
    // a metrics failure is not worth more than the error being reported
  }
  const url = config.ALERT_WEBHOOK_URL;
  if (!url) return Promise.resolve();
  const key = maskIds(scope);
  if (!admit(key, opts.now ?? Date.now())) {
    if (suppressed.size < 500 || suppressed.has(key)) suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
    return Promise.resolve();
  }
  const held = suppressed.get(key) ?? 0;
  suppressed.delete(key);
  const extra = held ? ` (${held} similar alert${held === 1 ? '' : 's'} suppressed)` : '';
  const text =
    `:rotating_light: Submission Review (${config.NODE_ENV}, ${hostname()}): system error in ${scope.slice(0, 120)}\n` +
    `${scrubText(message).slice(0, ALERT_MESSAGE_CHARS)}${extra}`;
  return (opts.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
  }).then(
    async (res) => {
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) logger.warn({ status: res.status }, 'alert webhook refused the alert');
    },
    // The URL is a secret: never logged.
    (err: unknown) => logger.warn({ reason: err instanceof Error ? err.name : 'error' }, 'alert webhook unreachable'),
  );
}
