// Failure text in words a reviewer understands (what happened + what to do), used wherever a failure is shown: the
// Errors tab, report and comparison failures, unsent emails, failed imports and API errors. The wording lives in
// FAILURE_MESSAGES (constants.ts); the categories mirror the backend's friendlyError.ts.
import { FAILURE_MESSAGES as M } from '../constants';

/** Raw failure text (API status + JSON, Node error codes, stack lines) that a reviewer should not have to read. */
const TECHNICAL =
  /^\s*\d{3}\b|"type"\s*:\s*"error"|\b(?:E[A-Z]{3,}|TypeError|ReferenceError|SyntaxError)\b|\n\s+at\s|[{}[\]]/;

/** Most specific first; matched against the raw text. */
const FRIENDLY: [RegExp, string][] = [
  [/credit balance|billing/i, M.credit],
  [/prompt is too long|too many tokens|context (?:length|window)/i, M.tooLong],
  [/^\s*401\b|authentication_error|api[-_ ]?key/i, M.auth],
  [/^\s*403\b|permission_error/i, M.permission],
  [/not_found_error|model.*not (?:found|available)/i, M.model],
  [/^\s*429\b|rate_limit/i, M.rateLimit],
  [/^\s*529\b|overloaded/i, M.overloaded],
  [/^\s*5\d\d\b|api_error|internal server error/i, M.serverError],
  [/truncated|max_tokens|output limit/i, M.truncated],
  [/budget/i, M.budget],
  [/did not finish within|timed? ?out|TimeoutError|ETIMEDOUT/i, M.timeout],
  [/google ?drive|googleapis/i, M.drive],
  [/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch failed|failed to fetch|load failed|network/i, M.network],
  [/invalid_request_error|^\s*400\b/i, M.badRequest],
];

export interface FriendlyOptions {
  /** Shown when there is no text at all. */
  empty?: string;
  /** Shown for technical text that matches no category. */
  unknown?: string;
  /** The text comes from code, not from a person (a browser TypeError): never shown as is. */
  technical?: boolean;
}

/**
 * A failure in plain words, plus the raw text (null when it was already plain) for admins. Messages already written
 * for people pass through unchanged.
 */
export function friendlyError(
  raw: string | null | undefined,
  opts: FriendlyOptions = {},
): { message: string; technical: string | null } {
  const { empty = M.unknown, unknown = M.unknown } = opts;
  const text = raw?.trim();
  if (!text) return { message: empty, technical: null };
  const technical = opts.technical || TECHNICAL.test(text);
  const hit = FRIENDLY.find(([re]) => re.test(text));
  if (hit && (technical || text.length > 200)) return { message: hit[1], technical: text };
  if (!technical && text.length <= 300) return { message: text, technical: null };
  return { message: hit?.[1] ?? unknown, technical: text };
}

/** Just the plain-words message. */
export const friendlyMessage = (raw: string | null | undefined, opts?: FriendlyOptions): string =>
  friendlyError(raw, opts).message;
