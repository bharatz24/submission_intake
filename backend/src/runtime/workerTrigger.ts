import { config } from '../config.js';
import { WORKER_TRIGGER_TIMEOUT_MS } from '../constants.js';
import { logger } from '../logger.js';

/** Work the Netlify background worker function (`worker-background`) can be asked to do (runtime/workerTasks.ts). */
export const WORKER_TASKS = [
  'jobs',
  'recover',
  'gmail-poll',
  'gmail-reconcile',
  'drive-orphans',
  'retention',
  'bootstrap',
  // Started by a person from the UI (runInBackground/start in services/backgroundTasks.ts); the payload names them.
  'gmail-manual-poll',
  'ims2-sync',
  'geo-import',
] as const;
export type WorkerTask = (typeof WORKER_TASKS)[number];
/** Who asked for a task started from the UI (audit rows and "last run by"). */
export interface WorkerPayload {
  actor?: { id: string; name: string };
}

export const isWorkerTask = (v: unknown): v is WorkerTask =>
  typeof v === 'string' && (WORKER_TASKS as readonly string[]).includes(v);

/** Path of the background worker function on the site. */
export const WORKER_FUNCTION_PATH = '/.netlify/functions/worker-background';

/**
 * Base URL of this deploy. Production uses the site URL; any other context (deploy preview, branch deploy) uses its
 * own deploy URL, so a staging deploy never wakes the production worker. Netlify sets these at function runtime.
 */
export function workerBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CONTEXT && env.CONTEXT !== 'production') return env.DEPLOY_URL ?? env.URL;
  return env.URL ?? env.DEPLOY_URL;
}

/**
 * Ask the background worker function to run `task`. Netlify answers a background function with 202 at once, so this
 * returns quickly. A failure is logged and swallowed: the scheduled one-minute kick (`recover`) is the safety net.
 */
export async function triggerWorker(
  task: WorkerTask,
  payload: WorkerPayload = {},
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const base = workerBaseUrl();
  if (!base || !config.WORKER_TOKEN) {
    logger.warn({ task }, 'worker trigger skipped: site URL or WORKER_TOKEN missing');
    return;
  }
  try {
    const res = await fetchFn(new URL(WORKER_FUNCTION_PATH, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-token': config.WORKER_TOKEN },
      body: JSON.stringify({ task, ...payload }),
      signal: AbortSignal.timeout(WORKER_TRIGGER_TIMEOUT_MS),
    });
    if (!res.ok) logger.warn({ task, status: res.status }, 'worker trigger refused');
  } catch (err) {
    logger.warn({ err, task }, 'worker trigger failed; the scheduled kick will pick the work up');
  }
}
