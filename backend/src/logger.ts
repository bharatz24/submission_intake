import pino from 'pino';

import { config } from './config.js';
import { logContext } from './requestContext.js';
import { scrubText } from './services/piiScrub.js';

/** Secret keys, redacted at the top level and one level down (`*.key`), and deeper by deepRedact below. */
const SECRET_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'apiKey',
  'api_key',
  'refreshToken',
  'refresh_token',
  'accessToken',
  'access_token',
  'id_token',
  'authorization',
  'cookie',
  'setupToken',
];

/**
 * Personal data keys (spec §6), redacted at the top level and one level down (`*.key`). `name` is redacted only at the
 * top level and never as `*.name`: that would blank err.name and every nested `name` (a skill, a Drive file, a job).
 * The applicant's name is caught by `applicantName` at both levels instead.
 */
export const PII_LOG_KEYS = [
  'email',
  'from',
  'to',
  'cc',
  'subject',
  'body',
  'bodyText',
  'body_text',
  'text',
  'extractedText',
  'extracted_text',
  'content',
  'prompt',
  'question',
  'answer',
  'applicantName',
  'npi',
  'ssn',
  'dob',
  'phone',
  'address',
  'filename',
];

/**
 * Network errors carry the peer's `address` and `port` (ECONNREFUSED 127.0.0.1:5432): those are diagnostics, not
 * personal data, so `err.address` is the one `*.address` match that is kept. Every other match is censored.
 */
const censor = (value: unknown, path: string[]) =>
  path.length === 2 && path[0] === 'err' && path[1] === 'address' ? value : '[REDACTED]';

/**
 * Free-text error fields that can quote row values: the message and stack, and node-postgres's `detail` ("Key
 * (email)=(…) already exists", "Failing row contains (…)"), `where` and `hint`. Schema names (table, column,
 * constraint) are kept as diagnostics.
 */
const ERR_TEXT_FIELDS = ['message', 'stack', 'detail', 'where', 'hint'] as const;

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** A URL without its query string, which can carry tokens or codes. */
const withoutQuery = (url: unknown) => (typeof url === 'string' ? url.split('?')[0] : undefined);

/**
 * A logged error with PII scrubbed from its free-text fields (type, code and other fields stay). A googleapis (gaxios)
 * error's `response` and `config` are live fetch objects carrying the bearer token and the response body: only the
 * status and the method + URL are kept. Any other non-plain object is dropped, since the redactor deep-clones what it is
 * given and a class instance with getter-only properties makes that clone throw, crashing the process (QA-001).
 */
export function errSerializer(err: unknown) {
  const out = pino.stdSerializers.err(err as Error) as ReturnType<typeof pino.stdSerializers.err> | undefined;
  if (!out || typeof out !== 'object') return out;
  const fields = out as Record<string, unknown>;
  for (const key of ERR_TEXT_FIELDS) {
    const value = fields[key];
    if (typeof value === 'string') fields[key] = scrubText(value);
  }
  const { response, config } = fields as { response?: Record<string, unknown>; config?: Record<string, unknown> };
  if (response && typeof response === 'object')
    fields.response = { status: response.status, statusText: response.statusText };
  if (config && typeof config === 'object') fields.config = { method: config.method, url: withoutQuery(config.url) };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'response' || key === 'config' || key === 'cause' || key === 'aggregateErrors') continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && !isPlain(value)) delete fields[key];
  }
  return out;
}

/** Keys censored below the depth the redact paths reach. `name` is left alone (see PII_LOG_KEYS). */
const DEEP_REDACT_KEYS = new Set([...SECRET_KEYS, ...PII_LOG_KEYS]);
/** Levels deepRedact walks; anything deeper is replaced, so a huge or hostile object cannot stall logging. */
const DEEP_REDACT_MAX_DEPTH = 8;

/**
 * Censors secret and PII keys nested two or more levels down (`a.b.email`), which the redact paths (`k`, `*.k`) do
 * not reach (MON-04). Only plain objects and arrays are walked, so errors and requests keep going to their
 * serializers; nothing is copied unless something below it changes, and the caller's object is never mutated.
 */
export function deepRedact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value) && !isPlain(value)) return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= DEEP_REDACT_MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  let out: Record<string, unknown> | unknown[] | undefined;
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    // Keys one and two levels down are the redact paths' (`k`, `*.k`, with the err.address exception); deeper, here.
    const next =
      depth >= 2 && typeof key === 'string' && DEEP_REDACT_KEYS.has(key) && child !== undefined
        ? '[REDACTED]'
        : deepRedact(child, depth + 1, seen);
    if (next !== child) {
      out ??= Array.isArray(value) ? [...value] : { ...value };
      (out as Record<string | number, unknown>)[key] = next;
    }
  }
  seen.delete(value);
  return out ?? value;
}

/** The logger's options, exported so tests can build a logger with the same redaction and its own destination. */
export const loggerOptions = {
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      // googleapis / fetch errors can carry the request config, including the bearer token.
      'err.config.headers.authorization',
      'err.config.headers.Authorization',
      'err.response.config.headers.authorization',
      'err.response.config.headers.Authorization',
      ...SECRET_KEYS.flatMap((k) => [k, `*.${k}`]),
      'name',
      ...PII_LOG_KEYS.flatMap((k) => [k, `*.${k}`]),
    ],
    censor,
  },
  serializers: { err: errSerializer },
  formatters: { log: (obj: Record<string, unknown>) => deepRedact(obj) as Record<string, unknown> },
  // Every line carries the request or job it was written for (requestContext.ts).
  mixin: () => ({ ...logContext() }),
} satisfies pino.LoggerOptions;

export const logger = pino(loggerOptions);

/** Query parameters whose values are secrets: the Gmail push token, and the OAuth code and state. */
const SENSITIVE_QUERY = new Set(['token', 'code', 'state', 'access_token', 'refresh_token', 'id_token']);

/** The URL with sensitive query values replaced by [REDACTED], for logs. */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  if (q < 0) return url;
  const parts = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawKey = eq < 0 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        /* keep raw */
      }
      return SENSITIVE_QUERY.has(key.toLowerCase()) ? `${rawKey}=[REDACTED]` : pair;
    });
  return `${url.slice(0, q)}?${parts.join('&')}`;
}

/** Sensitive values in a parsed query object replaced by [REDACTED], for logs. */
export function redactQuery(query: unknown): unknown {
  if (!query || typeof query !== 'object') return query;
  return Object.fromEntries(
    Object.entries(query as Record<string, unknown>).map(([k, v]) => [
      k,
      SENSITIVE_QUERY.has(k.toLowerCase()) ? '[REDACTED]' : v,
    ]),
  );
}

/** pino-http serializers: the request is already serialized (wrapSerializers), so only the URL and query are scrubbed. */
export const httpSerializers = {
  req: (req: Record<string, unknown>) => ({
    ...req,
    url: redactUrl(req.url as string | undefined),
    query: redactQuery(req.query),
  }),
};
