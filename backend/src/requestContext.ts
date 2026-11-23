import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation ids for the work in progress: the HTTP request, or the background job, that the current code runs for.
 * The logger adds them to every line (logger.ts `mixin`), so a service logging deep inside a request or a pipeline run
 * needs no logger passed down to be traceable: grep one requestId or jobId and see the whole story.
 */
export interface LogContext {
  requestId?: string;
  jobId?: string;
  jobKind?: string;
  dedupeKey?: string;
  attempt?: number;
  submissionId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with `ctx` added to the current context (inner keys win), for every log line `fn` writes. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

/** The correlation ids of the current request or job; empty outside of one. */
export function logContext(): LogContext {
  return storage.getStore() ?? {};
}

/** The id of the HTTP request being handled, if any (for error envelopes and audit details). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
