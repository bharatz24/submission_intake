import Anthropic from '@anthropic-ai/sdk';

import { FAILURE_MESSAGES } from '../constants.js';
import { AppError } from '../http.js';
import { StorageError } from './driveStorage.js';
import { ClaudeTimeoutError, ClaudeTruncatedError, LlmBudgetError, LlmSubmissionBudgetError } from './llmUsage.js';

/**
 * Processing failures in words an underwriter understands (what happened + what to do), stored as the submission's
 * processing_error; the raw text goes to processing_error_detail for admins. The categories and wording mirror the
 * frontend's friendlyError (frontend/src/lib/friendlyError.ts), which still words errors stored before this. The wording
 * lives in FAILURE_MESSAGES (constants.ts).
 */

const MESSAGES = FAILURE_MESSAGES;

/** Raw failure text (API status + JSON, Node error codes, stack lines) that a reviewer should not have to read. */
const TECHNICAL =
  /^\s*\d{3}\b|"type"\s*:\s*"error"|\b(?:E[A-Z]{3,}|TypeError|ReferenceError|SyntaxError)\b|\n\s+at\s|[{}[\]]/;

/** Most specific first; matched against the raw text. */
const FRIENDLY: [RegExp, string][] = [
  [/credit balance|billing/i, MESSAGES.credit],
  [/prompt is too long|too many tokens|context (?:length|window)/i, MESSAGES.tooLong],
  [/^\s*401\b|authentication_error|api[-_ ]?key/i, MESSAGES.auth],
  [/^\s*403\b|permission_error/i, MESSAGES.permission],
  [/not_found_error|model.*not (?:found|available)/i, MESSAGES.model],
  [/^\s*429\b|rate_limit/i, MESSAGES.rateLimit],
  [/^\s*529\b|overloaded/i, MESSAGES.overloaded],
  [/^\s*5\d\d\b|api_error|internal server error/i, MESSAGES.serverError],
  [/truncated|max_tokens|output limit/i, MESSAGES.truncated],
  [/budget/i, MESSAGES.budget],
  [/did not finish within|timed? ?out|TimeoutError|ETIMEDOUT/i, MESSAGES.timeout],
  [/google ?drive|googleapis/i, MESSAGES.drive],
  [/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch failed|network/i, MESSAGES.network],
  [/invalid_request_error|^\s*400\b/i, MESSAGES.badRequest],
];

/**
 * Raw failure text in plain words, plus the raw text (null when it was already plain). Messages already written for
 * people pass through unchanged. The same rules as the frontend's friendlyProcessingError.
 */
export function friendlyText(
  raw: string | null | undefined,
  unknown: string = MESSAGES.unknown,
): { message: string; technical: string | null } {
  const text = raw?.trim();
  if (!text) return { message: MESSAGES.processingFailed, technical: null };
  const hit = FRIENDLY.find(([re]) => re.test(text));
  if (hit && (TECHNICAL.test(text) || text.length > 200)) return { message: hit[1], technical: text };
  if (!TECHNICAL.test(text) && text.length <= 300) return { message: text, technical: null };
  return { message: hit?.[1] ?? unknown, technical: text };
}

/** Node / undici codes of a connection that failed or dropped: nothing about the request itself, worth another try. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
/** The same, for errors that reach us only as text (wrapped, or rethrown as a plain Error). */
const TRANSIENT_TEXT =
  /^\s*(?:429|529|5\d\d)\b|overloaded_error|rate_limit_error|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|fetch failed|socket hang up/i;

/** The error and its causes, outermost first (a fetch TypeError carries the socket error as its cause). */
function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  for (let e = err; e && out.length < 5; e = (e as { cause?: unknown }).cause) out.push(e);
  return out;
}

const codeOf = (e: unknown) =>
  e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : null;

export interface DescribedError {
  /** Plain words for underwriters: what happened and what to do. */
  message: string;
  /** The raw error text for admins; null when the message is the raw text. */
  detail: string | null;
  /** Short-lived (overload, rate limit, 5xx, timeout, dropped connection): an automatic retry may well succeed. */
  transient: boolean;
}

/** Classify a processing failure by the error object (status, class, code), falling back to its text. */
export function describeProcessingError(err: unknown, unknown: string = MESSAGES.unknown): DescribedError {
  const raw = (err instanceof Error ? err.message : String(err)).trim() || 'Unknown error';
  const known = (message: string, transient: boolean): DescribedError => ({
    message,
    detail: message === raw ? null : raw,
    transient,
  });

  if (err instanceof ClaudeTimeoutError) return known(MESSAGES.timeout, true);
  // The submission's own budget before the global one it extends: different limit, different fix.
  if (err instanceof LlmSubmissionBudgetError) return known(MESSAGES.submissionBudget, false);
  if (err instanceof LlmBudgetError) return known(MESSAGES.budget, false);
  if (err instanceof ClaudeTruncatedError) return known(MESSAGES.truncated, false);
  if (err instanceof StorageError) return known(MESSAGES.drive, err.kind === 'UNAVAILABLE');
  // The SDK's connection errors (APIConnectionTimeoutError included) have no status: the request never got an answer.
  if (err instanceof Anthropic.APIConnectionTimeoutError) return known(MESSAGES.timeout, true);
  if (err instanceof Anthropic.APIConnectionError) return known(MESSAGES.network, true);
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    const s = err.status;
    const transient = s === 429 || s >= 500;
    const text = friendlyText(raw, unknown);
    if (text.technical) return known(text.message, transient);
    const byStatus =
      s === 401
        ? MESSAGES.auth
        : s === 403
          ? MESSAGES.permission
          : s === 404
            ? MESSAGES.model
            : s === 429
              ? MESSAGES.rateLimit
              : s === 529
                ? MESSAGES.overloaded
                : s >= 500
                  ? MESSAGES.serverError
                  : MESSAGES.badRequest;
    return known(byStatus, transient);
  }
  // Written for people by our own code (a 4xx/5xx a route would show as is): passed through.
  if (err instanceof AppError) return known(err.message, false);

  const links = chain(err);
  const code = links.map(codeOf).find((c) => c && TRANSIENT_CODES.has(c));
  if (code) return known(/TIMEOUT|ETIMEDOUT/.test(code) ? MESSAGES.timeout : MESSAGES.network, true);
  const transient = links.some((e) => TRANSIENT_TEXT.test(e instanceof Error ? e.message : String(e)));
  // A short-lived failure is always worded by its category, even when its raw text is short ("fetch failed").
  const hit = transient ? FRIENDLY.find(([re]) => re.test(raw)) : undefined;
  if (hit) return known(hit[1], true);
  const text = friendlyText(raw, unknown);
  return { message: text.message, detail: text.technical, transient };
}

/** A failure outside email processing (report, comparison, quote, API request) in the same plain words. */
export const describeError = (err: unknown): DescribedError => describeProcessingError(err, MESSAGES.unknownGeneral);
