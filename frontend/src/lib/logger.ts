import { env } from '../config/env';

/**
 * The frontend's only way to log (logging-monitoring skill): no `console.*` elsewhere. Debug and info stay in the
 * browser console in development. Warnings and errors also go to the server (POST /api/client-errors), so a failure
 * a user hit is in the same logs as the API's, matched by its request id when there is one.
 *
 * Reports are best-effort: never awaited, never thrown, sent with `keepalive` so one made just before a reload still
 * arrives, and the same message is reported at most once per minute so a render loop can't flood the server.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  /** Where in the app: 'error-boundary', 'route', 'event-stream'… */
  source?: string;
  /** The API request id of the failed call (ApiError / X-Request-Id). */
  requestId?: string;
  componentStack?: string | null;
}

const REPORT_EVERY_MS = 60_000;
const lastReported = new Map<string, number>();

function report(level: 'warn' | 'error', message: string, error: unknown, ctx: LogContext): void {
  const key = `${level}:${ctx.source ?? ''}:${message}`;
  const now = Date.now();
  if ((lastReported.get(key) ?? 0) > now - REPORT_EVERY_MS) return;
  lastReported.set(key, now);
  if (lastReported.size > 200) lastReported.clear();
  const err = error instanceof Error ? error : null;
  const body = {
    level,
    message: (err ? `${message}: ${err.message}` : message).slice(0, 2000),
    source: (ctx.source ?? 'app').slice(0, 100),
    stack: err?.stack?.slice(0, 8000),
    componentStack: ctx.componentStack?.slice(0, 8000) || undefined,
    // The path only (FE-11): the query and hash can hold an inbox search (applicant names, NPIs) or a token.
    url: typeof window !== 'undefined' ? window.location.pathname : undefined,
    requestId: ctx.requestId,
    release: env.mode,
  };
  try {
    void fetch(`${env.apiBase}/client-errors`, {
      method: 'POST',
      keepalive: true,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  } catch {
    // fetch unavailable (tests without a network mock): the console line below is enough.
  }
}

function write(level: LogLevel, message: string, error?: unknown, ctx: LogContext = {}): void {
  if (env.isDev || level === 'warn' || level === 'error') {
    const args = error === undefined ? [message] : [message, error];
    // The one place the app writes to the console.
    /* eslint-disable no-console */
    const sink = { debug: console.debug, info: console.info, warn: console.warn, error: console.error }[level];
    /* eslint-enable no-console */
    sink(...args);
  }
  if (level === 'warn' || level === 'error') report(level, message, error, ctx);
}

export const logger = {
  debug: (message: string, data?: unknown) => write('debug', message, data),
  info: (message: string, data?: unknown) => write('info', message, data),
  warn: (message: string, ctx?: LogContext & { error?: unknown }) => write('warn', message, ctx?.error, ctx),
  error: (message: string, error?: unknown, ctx?: LogContext) => write('error', message, error, ctx),
};

/** For tests: forget which messages were already reported. */
export function resetLoggerForTests(): void {
  lastReported.clear();
}
