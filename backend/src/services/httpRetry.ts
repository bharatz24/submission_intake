import { observeOutbound } from './metrics.js';

/** Retry for idempotent GETs to external APIs: transient failures only, with backoff, jitter and Retry-After. */

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Request headers (e.g. Authorization); the method is always GET. */
  headers?: Record<string, string>;
  /** Names the integration in the outbound-call metrics (ims_outbound_request_duration_seconds). */
  integration?: string;
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export const isTransientStatus = (status: number) => TRANSIENT_STATUS.has(status);

/** Retry-After as milliseconds (delta-seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Exponential backoff with full jitter in [base·2^n / 2, base·2^n], capped. */
export function backoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** Resolves after `ms` milliseconds: the one sleep helper (retries, polling loops). */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * GET `url`, retrying network errors, timeouts and 408/425/429/5xx. Returns the last response (the caller checks
 * `ok`), or throws the last network error. Other 4xx answers are returned at once: retrying won't change them.
 */
export async function fetchWithRetry(
  url: URL | string,
  fetchImpl: typeof fetch,
  opts: RetryOptions,
): Promise<Response> {
  const wait = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= opts.attempts - 1;
    let delay: number;
    try {
      const started = performance.now();
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(opts.timeoutMs),
        ...(opts.headers ? { headers: opts.headers } : {}),
      }).catch((err: unknown) => {
        if (opts.integration) observeOutbound(opts.integration, null, (performance.now() - started) / 1000);
        throw err;
      });
      if (opts.integration) observeOutbound(opts.integration, res.status, (performance.now() - started) / 1000);
      if (last || !isTransientStatus(res.status)) return res;
      delay = Math.min(
        opts.maxDelayMs,
        retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempt, opts.baseDelayMs, opts.maxDelayMs),
      );
      await res.body?.cancel().catch(() => undefined); // free the connection before waiting
    } catch (err) {
      if (last) throw err;
      delay = backoffMs(attempt, opts.baseDelayMs, opts.maxDelayMs);
    }
    await wait(delay);
  }
}
