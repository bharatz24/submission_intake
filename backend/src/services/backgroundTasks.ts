import { isNetlifyRuntime } from '../config.js';
import { logger } from '../logger.js';
import { triggerWorker, type WorkerPayload, type WorkerTask } from '../runtime/workerTrigger.js';

/**
 * In-process background work that is not a durable job: a manual Gmail poll, the IMS 2 status sync, a skipped email
 * imported again, the ZIP data reload, scheduled checks. The HTTP request answers 202 at once and the work runs here,
 * tracked so that graceful shutdown (server.ts) waits for it (bounded by SHUTDOWN_TIMEOUT_MS) before closing the pools,
 * instead of cutting it off mid-write with "pool ended" errors (PERF-04).
 *
 * `start(key, ...)` is single-flight per key on this process, and remembers the last outcome per key, so a status
 * endpoint can answer "running" / "last result" (taskSnapshot).
 *
 * RUNTIME=netlify freezes a function once it has answered, so nothing may run after the response there. Work given a
 * `worker` (long: a Gmail poll, the IMS 2 sync, the ZIP reload) is handed to the background worker function instead;
 * other work (short by design, well under the 60 s function limit) is awaited before the request answers. Callers
 * therefore await runInBackground/start; on a server both return at once, as before.
 */

/** Where long work runs on Netlify: a worker task, with who asked for it. */
export interface BackgroundOptions {
  worker?: { task: WorkerTask; payload?: WorkerPayload };
}

const inFlight = new Set<Promise<unknown>>();

export interface TaskSnapshot<T = unknown> {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  result: T | null;
  error: string | null;
}
const tasks = new Map<string, TaskSnapshot & { promise: Promise<unknown> | null }>();

/** Track a promise until it settles (its own error handling stays with the caller). Returns it. */
export function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  const done = () => inFlight.delete(p);
  p.then(done, done);
  return p;
}

/**
 * Run `fn` in the background, tracked; a failure is logged (with `name`), never thrown. Netlify: the worker task in
 * `opts.worker` is triggered instead, or else `fn` is awaited; either way the returned promise settles first.
 */
export async function runInBackground(
  name: string,
  fn: () => Promise<unknown>,
  opts: BackgroundOptions = {},
): Promise<void> {
  const run = () =>
    Promise.resolve()
      .then(fn)
      .catch((err) => logger.error({ err, task: name }, 'background task failed'));
  if (!isNetlifyRuntime()) {
    void track(run());
    return;
  }
  if (opts.worker) return triggerWorker(opts.worker.task, opts.worker.payload);
  await run();
}

/**
 * Start the task `key` unless it is already running on this process; false when it is. `onError` maps the failure
 * to the stored error text (default: its message). The outcome is kept for `taskSnapshot(key)`.
 *
 * Netlify: with `opts.worker` the worker task is triggered (true; its outcome is what the task stores in the
 * database). Without, `fn` is awaited and a failure is thrown after `onError`, so the request itself reports it: a
 * status request may reach another function instance, which has no snapshot of this run.
 */
export async function start<T>(
  key: string,
  fn: () => Promise<T>,
  onError?: (err: unknown) => void,
  opts: BackgroundOptions = {},
): Promise<boolean> {
  const current = tasks.get(key);
  if (current?.running) return false;
  if (isNetlifyRuntime() && opts.worker) {
    await triggerWorker(opts.worker.task, opts.worker.payload);
    return true;
  }
  const snap: TaskSnapshot & { promise: Promise<unknown> | null } = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
    promise: null,
  };
  tasks.set(key, snap);
  const outcome: { failed: boolean; err?: unknown } = { failed: false };
  snap.promise = track(
    Promise.resolve()
      .then(fn)
      .then(
        (result) => {
          snap.result = result ?? null;
        },
        (err: unknown) => {
          snap.error = err instanceof Error ? err.message : String(err);
          try {
            onError?.(err);
          } catch {
            // the error handler must not fail the task bookkeeping
          }
          logger.warn({ err, task: key }, 'background task failed');
          outcome.failed = true;
          outcome.err = err;
        },
      )
      .finally(() => {
        snap.running = false;
        snap.finishedAt = new Date().toISOString();
        snap.promise = null;
      }),
  );
  if (isNetlifyRuntime()) {
    await snap.promise;
    if (outcome.failed) throw outcome.err;
  }
  return true;
}

/** Running state and last outcome of `key` on this process (never started: not running, all null). */
export function taskSnapshot<T = unknown>(key: string): TaskSnapshot<T> {
  const s = tasks.get(key);
  if (!s) return { running: false, startedAt: null, finishedAt: null, result: null, error: null };
  const { promise: _promise, ...rest } = s;
  return rest as TaskSnapshot<T>;
}

/** Background work still running on this process. */
export const inFlightCount = () => inFlight.size;

/**
 * Wait for every tracked task, up to `timeoutMs` (graceful shutdown, tests). Returns how many were still running
 * at the deadline. Tasks started while waiting are waited for too.
 */
export async function drainBackground(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise((r) => {
        timer = setTimeout(r, left);
      }),
    ]);
    clearTimeout(timer);
  }
  return inFlight.size;
}
