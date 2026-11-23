import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The lease signal of the background job the current code runs for (set by jobQueue.ts around each handler). Claude
 * calls pick it up (claude.ts responseDeadline), so a job taken over by another worker stops its LLM work at once
 * instead of spending tokens on a result nobody will save. No handler has to pass the signal down by hand.
 */
const storage = new AsyncLocalStorage<AbortSignal>();

export function withJobSignal<T>(signal: AbortSignal, fn: () => T): T {
  return storage.run(signal, fn);
}

/** The current job's lease signal; undefined outside a job (an HTTP request, a test). */
export function currentJobSignal(): AbortSignal | undefined {
  return storage.getStore();
}

/**
 * True once the current job's lease was lost: another worker owns the job now and will write its outcome, so a failure
 * here (usually the aborted Claude call itself) must not be recorded as the job's result.
 */
export function jobLeaseLost(): boolean {
  return storage.getStore()?.aborted === true;
}
