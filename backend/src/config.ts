import 'dotenv/config';

import { z } from 'zod';

/** docker-compose's development database; never used in production, where DATABASE_URL must be set. */
const DEV_DATABASE_URL = 'postgres://ims:ims_dev_password@localhost:5435/ims';

/** An encryption key setting: a passphrase, or `base64:` followed by exactly 32 bytes. */
const validEncryptionKey = (v: string) => !v.startsWith('base64:') || Buffer.from(v.slice(7), 'base64').length === 32;

/**
 * Secret values shipped in docs and examples (env.example before it was blanked, docs/deploy.md): anyone can read them,
 * so production refuses them. Matched case-insensitively, also as a substring for the `change-me` family.
 */
const PLACEHOLDER_SECRETS = ['change-me-at-least-32-characters-long-random-value'];
const PLACEHOLDER_PATTERN = /change[-_ ]?me|replace[-_ ]?me|placeholder|your[-_ ]?secret|example/i;
/** Fewer distinct characters than this (`aaaa…`, `abcabc…`, base64 of all-zero bytes) is not a random secret. */
const MIN_DISTINCT_SECRET_CHARS = 12;

/** Why a production secret is unacceptable, or null. Never includes the value, which must not reach the console. */
export function weakSecretReason(value: string): string | null {
  const v = value.trim();
  if (PLACEHOLDER_SECRETS.includes(v.toLowerCase()) || PLACEHOLDER_PATTERN.test(v))
    return 'is a placeholder value from the docs; generate a random one';
  if (new Set(v).size < MIN_DISTINCT_SECRET_CHARS) return 'is too repetitive to be random; generate a random one';
  return null;
}

/** Whether a URL is https on a host other than localhost/loopback, as production needs for browser-facing URLs. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1';
  return url.protocol === 'https:' && !loopback && host !== '0.0.0.0';
}

/** A prompt-cache lifetime Claude accepts. */
const CacheTtl = z.enum(['5m', '1h']).optional();

/**
 * Express `trust proxy`: false (the default) uses the socket address as the client IP and ignores X-Forwarded-*;
 * a number trusts that many reverse proxies in front of the API; otherwise a comma-separated list of proxy addresses,
 * subnets or the names loopback, linklocal, uniquelocal. `true` (trust every hop) is refused: any client could then
 * choose its own IP with a forged X-Forwarded-For and slip past the per-IP rate limits.
 */
const TrustProxy = z
  .string()
  .default('false')
  .transform((raw, ctx): false | number | string[] => {
    const v = raw.trim().toLowerCase();
    if (v === '' || v === 'false' || v === '0') return false;
    if (/^\d+$/.test(v)) return Number(v);
    if (v === 'true') {
      ctx.addIssue({
        code: 'custom',
        message: 'true would trust any X-Forwarded-For; give the number of proxies (e.g. 1) or their addresses',
      });
      return z.NEVER;
    }
    return raw
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  });

export const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  // Requests per minute per client IP across /api, and login/register attempts per 15 minutes per IP.
  API_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(300),
  LOGIN_RATE_LIMIT_PER_15MIN: z.coerce.number().int().min(1).default(20),
  // Where rate-limit counters live (modules/shared/rateLimitStore.ts): postgres shares them across instances and
  // deploys; memory counts per process. Unset: postgres, except under NODE_ENV=test.
  RATE_LIMIT_STORE: z.enum(['postgres', 'memory']).optional(),
  // Failed sign-ins per 15 minutes for one account from one IP; and for one account from all IPs together, set much
  // higher so a stranger cannot lock the real user out (a spread-out brute force still hits it).
  LOGIN_ACCOUNT_RATE_LIMIT_PER_15MIN: z.coerce.number().int().min(1).default(10),
  LOGIN_ACCOUNT_TOTAL_RATE_LIMIT_PER_15MIN: z.coerce.number().int().min(1).default(100),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5174'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // How background work is triggered: `server` (long-running process: job poll loop, LISTEN/NOTIFY, timers) or
  // `netlify` (functions: a background worker function drains the job table, scheduled functions trigger it).
  RUNTIME: z.enum(['server', 'netlify']).default('server'),
  // Shared secret the Netlify worker function requires on every trigger (x-worker-token). Required when RUNTIME=netlify.
  WORKER_TOKEN: z.string().min(32).optional(),
  // Reverse proxies in front of the API, for the client IP (rate limits) and req.protocol; see TrustProxy above.
  TRUST_PROXY: TrustProxy,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // The API key and default model are set in Settings → Claude API (services/anthropicSettings.ts).
  // Optional per-task overrides; each falls back to that model when unset.
  ANTHROPIC_MODEL_CLASSIFICATION: z.string().optional(),
  ANTHROPIC_MODEL_EXTRACTION: z.string().optional(),
  ANTHROPIC_MODEL_SYNTHESIS: z.string().optional(),
  ANTHROPIC_MODEL_ANALYSIS: z.string().optional(),
  ANTHROPIC_MODEL_CHAT: z.string().optional(),
  ANTHROPIC_MODEL_COMPARISON: z.string().optional(),
  ANTHROPIC_MODEL_QUOTE: z.string().optional(),
  ANTHROPIC_MODEL_EMAIL_DRAFT: z.string().optional(),
  // How long Claude keeps a task's skill text cached (claude.ts CACHE_TTL): 5m or 1h. Unset: the task's default.
  LLM_CACHE_TTL_CLASSIFICATION: CacheTtl,
  LLM_CACHE_TTL_EXTRACTION: CacheTtl,
  LLM_CACHE_TTL_SYNTHESIS: CacheTtl,
  LLM_CACHE_TTL_ANALYSIS: CacheTtl,
  LLM_CACHE_TTL_CHAT: CacheTtl,
  LLM_CACHE_TTL_COMPARISON: CacheTtl,
  LLM_CACHE_TTL_QUOTE: CacheTtl,
  LLM_CACHE_TTL_EMAIL_DRAFT: CacheTtl,
  // After processing, generate the Synthesis Report, then the Underwriting Analysis, then a quote, without a click.
  AUTO_REPORTS: z
    .string()
    .default('true')
    .transform((v) => ['true', '1', 'yes'].includes(v.trim().toLowerCase())),
  // Hold back emails that repeat a submission already in the inbox (services/duplicates.ts).
  DUPLICATE_DETECTION: z
    .string()
    .default('true')
    .transform((v) => ['true', '1', 'yes'].includes(v.trim().toLowerCase())),
  DUPLICATE_LOOKBACK_DAYS: z.coerce.number().int().min(1).default(90),
  DUPLICATE_BODY_SIMILARITY: z.coerce.number().min(0).max(1).default(0.85),
  // Defaults to the docker-compose database outside production; production must set it.
  DATABASE_URL: z.string().min(1).optional(),
  // Connections in the application pool. Unset: JOB_CONCURRENCY x 2 + 10 (each job may hold two, plus HTTP headroom).
  DB_POOL_MAX: z.coerce.number().int().min(2).max(200).optional(),
  // Connections reserved for long-held session advisory locks (pipeline runs, Gmail poll, migrator). Unset: JOB_CONCURRENCY + 4.
  DB_LOCK_POOL_MAX: z.coerce.number().int().min(2).max(100).optional(),
  // A statement running longer than this is cancelled by Postgres (application pool only); 0 disables.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  // A session idle inside an open transaction longer than this is closed by Postgres; 0 disables.
  DB_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().int().min(0).default(60_000),
  // A request waiting longer than this for a free pool connection fails with 503 instead of hanging (DB-10); 0 waits forever.
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  // A statement of the application pool waiting longer than this for a row/table lock fails (503); 0 disables.
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  // How long a migration waits for a table lock before it fails and rolls back (db/migrate.ts); 0 waits forever.
  MIGRATION_LOCK_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
  // Attachments are always stored in Google Drive (services/driveStorage.ts).
  // Drive is used as the Google account behind GOOGLE_REFRESH_TOKEN (see GOOGLE_* below), so files are owned by
  // that account and use its storage.
  // Name of the folder attachments go into, at the top of My Drive or of GDRIVE_SHARED_DRIVE_ID. The folder this app
  // created with this name is reused, and one is created if there is none. A folder made by hand is ignored.
  // Environments sharing a Google account need different names.
  GDRIVE_ROOT_FOLDER_NAME: z.string().trim().min(1).default('Submission Review'),
  GDRIVE_SHARED_DRIVE_ID: z.string().optional(),
  GDRIVE_UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  // In-memory cache of recently stored/opened files, so extraction and re-opens skip a Drive download. 0 disables.
  GDRIVE_CACHE_MB: z.coerce.number().int().min(0).default(200),
  GDRIVE_CACHE_TTL_MINUTES: z.coerce.number().int().min(1).default(30),
  // A sweep that finds more orphans than this trashes nothing and fails: real orphans are rare, so that many means the
  // database does not match Drive (another environment on the same folder, a restored database). Raise it to let one through.
  GDRIVE_ORPHAN_SWEEP_MAX: z.coerce.number().int().min(0).default(100),
  ATTACHMENT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(100 * 1024 * 1024),
  // Failed Gmail ingests are retried with backoff; after this many attempts the message is flagged on Monitoring.
  GMAIL_RETRY_ALERT_AFTER: z.coerce.number().int().min(1).default(5),
  // After this many failed attempts a Gmail message is parked (dead letter, Errors tab) until someone retries it.
  INGEST_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(20),
  // Days the daily reconciliation reads; it never reaches before the day the mailbox was connected.
  RECONCILE_DAYS: z.coerce.number().int().min(1).default(7),
  JWT_SECRET: z.string().min(32),
  // A passphrase of 32+ characters, or `base64:` + 32 random bytes (services/crypto.ts).
  // An applied migration file whose content changed: `warn` logs it, `fail` refuses to start (db/migrate.ts).
  // Unset: `fail` in production, `warn` elsewhere.
  MIGRATION_CHECKSUM_CHECK: z.enum(['warn', 'fail']).optional(),
  // The migrations could not be replayed in a scratch schema to verify the live one: `warn` carries on, `fail` stops.
  // Unset: `fail` when CI is set (a broken migration file must fail the build), `warn` elsewhere.
  MIGRATION_REPLAY_CHECK: z.enum(['warn', 'fail']).optional(),
  ENCRYPTION_KEY: z
    .string()
    .min(32)
    .refine(validEncryptionKey, 'ENCRYPTION_KEY given as base64: must decode to 32 bytes'),
  // Comma-separated old ENCRYPTION_KEY values, kept while rotating: they only decrypt, and what they decrypt is
  // re-encrypted under ENCRYPTION_KEY. Remove once nothing uses them (see docs/deploy.md → Rotating ENCRYPTION_KEY).
  ENCRYPTION_KEYS_PREVIOUS: z
    .string()
    .optional()
    .refine(
      (v) =>
        !v ||
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .every((k) => k.length >= 32 && validEncryptionKey(k)),
      'Each ENCRYPTION_KEYS_PREVIOUS entry must be a valid ENCRYPTION_KEY value',
    ),
  JWT_EXPIRES_IN: z.string().default('8h'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:3002/api/gmail/oauth/callback'),
  // Refresh token issued to GOOGLE_CLIENT_ID with the `https://www.googleapis.com/auth/drive` scope (Drive storage).
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_TOKEN_URI: z.string().default('https://oauth2.googleapis.com/token'),
  GMAIL_PUBSUB_TOPIC: z.string().optional(),
  GMAIL_PUSH_TOKEN: z.string().optional(),
  // Read mail through a Gmail MCP server instead of Google OAuth. Also used automatically when
  // GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set.
  GMAIL_ENABLE_VIA_MCP: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes'].includes(v.trim().toLowerCase())),
  GMAIL_MCP_URL: z.string().optional(),
  GMAIL_MCP_TOKEN: z.string().optional(),
  GMAIL_MCP_COMMAND: z.string().optional(),
  GMAIL_MCP_ARGS: z.string().default(''),
  GMAIL_MCP_SEARCH_TOOL: z.string().default('search_emails'),
  GMAIL_MCP_READ_TOOL: z.string().default('read_email'),
  // Called with { to, cc, bcc, subject, body, threadId?, inReplyTo? } to send replies and forwards (no attachments).
  GMAIL_MCP_SEND_TOOL: z.string().default('send_email'),
  NPI_API_BASE: z.string().default('https://npiregistry.cms.hhs.gov/api/'),
  // Rate workbooks (*.xlsx) imported as one rate group on first start or from Settings → Rate tables (services/rating/importer.ts).
  RATES_DIR: z.string().default('data/rates'),
  // Name prefix for the imported rate group (default rates-<export date of State_Lookup>); a hash of the
  // imported data is appended, so changed workbooks never replace a group that saved quotes reference.
  RATE_GROUP: z.string().optional(),
  // State of the risk retention group's domicile; its premium tax is charged on every quote.
  DOMICILE_STATE: z.string().length(2).default('NC'),
  // Load ZIP-to-county data (about 7 MB from Census and GeoNames) on first start when the tables are empty.
  GEO_AUTO_IMPORT: z
    .string()
    .default('true')
    .transform((v) => ['true', '1', 'yes'].includes(v.trim().toLowerCase())),
  // --- LLM guardrails (services/claude.ts, services/llmUsage.ts, services/promptSafety.ts) ---
  // Tokens (input incl. cache + output) all Claude calls may use in a rolling 24 hours; 0 = unlimited. The default
  // (20M) covers roughly 100 fully processed submissions with reports; beyond it AI routes answer 429 LLM_BUDGET_EXCEEDED.
  LLM_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(20_000_000),
  // Tokens one submission's on-demand and automatic-report calls (chat, Synthesis/Analysis, comparison, quote, email
  // draft) may use in a rolling 24 hours, counting all of its calls; 0 = off. Pipeline classification and extraction are
  // never refused by it. Over it, those routes answer 429 LLM_SUBMISSION_BUDGET_EXCEEDED.
  LLM_SUBMISSION_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(3_000_000),
  // AI requests (synthesis, analysis, comparisons, chat) one user may start per hour; 0 = unlimited.
  LLM_USER_HOURLY_LIMIT: z.coerce.number().int().min(0).default(60),
  // Replace SSNs, labelled dates of birth and bank/routing numbers with placeholders before text is sent to Claude.
  LLM_REDACT_PII: z
    .string()
    .default('true')
    .transform((v) => ['true', '1', 'yes'].includes(v.trim().toLowerCase())),
  // Characters of submission evidence (email body + attachments) one prompt may carry; lowest-priority sources are cut first.
  LLM_PROMPT_MAX_CHARS: z.coerce.number().int().min(10_000).default(400_000),
  // What each Claude call keeps besides its usage row (llm_transcripts): every call stores SHA-256 hashes of its system
  // prompt and outbound prompt; `decisions` also stores the full (redacted) prompt and raw output of Synthesis,
  // Analysis, quote, chat and comparison calls, `all` of every call, `off` of none.
  LLM_STORE_TRANSCRIPTS: z.enum(['off', 'decisions', 'all']).default('decisions'),
  // --- Outbound mail (services/outbound.ts) ---
  // Comma-separated recipient domains replies/forwards may go to (subdomains included); empty = any domain.
  OUTBOUND_ALLOWED_DOMAINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean),
    ),
  // Emails one user may send per hour; 0 = unlimited.
  OUTBOUND_SEND_LIMIT_PER_HOUR: z.coerce.number().int().min(0).default(30),
  // --- Manual uploads (modules/shared/uploads.ts) ---
  // Total request size across all files of one upload, and uploads buffered in memory at the same time.
  UPLOAD_MAX_TOTAL_MB: z.coerce.number().int().min(1).default(100),
  UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  // Background jobs (services/jobQueue.ts, table `jobs`): per-instance concurrency, idle poll, worker lease, retention.
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(3),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  JOB_LEASE_SECONDS: z.coerce.number().int().min(10).default(120),
  JOB_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  // SIGTERM waits this long for running jobs before releasing them to another instance.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(25_000),
  // Open notification streams per user; more are refused with 429.
  SSE_MAX_PER_USER: z.coerce.number().int().min(1).default(5),
  // Open notification streams on this instance across all users; more are refused with 503.
  SSE_MAX_TOTAL: z.coerce.number().int().min(1).default(500),
  // Bearer token for GET /api/metrics (Prometheus). Unset: the endpoint is off (404).
  METRICS_TOKEN: z.string().min(16).optional(),
  // Optional webhook (Slack-compatible: JSON {"text": ...}) that receives system errors (services/alerts.ts),
  // deduplicated and rate-limited. Treated as a secret: Slack webhook URLs carry their own credential.
  ALERT_WEBHOOK_URL: z.url({ protocol: /^https?$/ }).optional(),
  // Per-file limits for text extraction (services/textExtraction.ts).
  EXTRACTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  OCR_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  OCR_MAX_PIXELS: z.coerce.number().int().min(1).default(40_000_000),
  // Folder holding the OCR model (eng.traineddata), relative to the working directory. Shipped in assets/ocr, so OCR
  // never downloads the model at run time.
  OCR_DATA_PATH: z.string().min(1).default('assets/ocr'),
  // Apply pending migrations when the API starts (advisory-locked, so instances starting together are safe). Production
  // sets false and runs the release step instead (backup, then `node dist/db/migrate.js`; docs/deploy.md): an instance
  // then refuses to start while migrations are pending.
  MIGRATE_ON_BOOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Worker threads that parse documents (services/extractionPool.ts); 0 parses on the main thread (tests only).
  EXTRACTION_WORKERS: z.coerce.number().int().min(0).max(16).default(2),
  // Heap limit of each extraction worker. Buffers outside the JS heap are not counted: the container limit covers those.
  EXTRACTION_WORKER_MAX_MB: z.coerce.number().int().min(64).default(512),
  // Hard limit for one file (a zip reads many); the worker is terminated after it. Above EXTRACTION_TIMEOUT_MS.
  EXTRACTION_WORKER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),
  // --- IMS 2 Submission Intake queue (services/ims2IntakeQueue.ts) ---
  // The queue URL and its token are set in Settings → IMS 2 intake (services/ims2QueueSettings.ts), not here.
  // Where IMS 2's screens are, for "Open in IMS 2" links when IMS 2 returns a path such as /policy-log/101.
  // Defaults to the queue URL from Settings without its /api/submission-intake suffix.
  IMS2_APP_URL: z.url().optional(),
  IMS2_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
  // One-time secret the first (administrator) account must present while no user exists. Required for that bootstrap
  // in production, so a fresh deployment reachable before setup cannot be claimed by a stranger; unused afterwards.
  SETUP_TOKEN: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .refine((v) => !v || v.length >= 16, 'SETUP_TOKEN must be at least 16 characters'),
});

/** Cross-field and production-only rules, so a misconfiguration fails at startup instead of on the first email. */
export const ConfigSchema = EnvSchema.superRefine((env, ctx) => {
  const need = (key: keyof typeof env, why: string) => {
    if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `required ${why}` });
  };
  if (env.RUNTIME === 'netlify') need('WORKER_TOKEN', 'when RUNTIME=netlify (authenticates worker triggers)');
  if (env.NODE_ENV === 'production') {
    need('DATABASE_URL', 'in production (the docker-compose development default is not used)');
    // Secrets copied from the docs, or not random, would let anyone forge sessions or read stored credentials.
    for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY'] as const) {
      const reason = weakSecretReason(env[key]);
      if (reason) ctx.addIssue({ code: 'custom', path: [key], message: `${key} ${reason} (production)` });
    }
    if (env.JWT_SECRET.trim() === env.ENCRYPTION_KEY.trim())
      ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEY'], message: 'must differ from JWT_SECRET (production)' });
    // A passphrase is hashed once with SHA-256 (services/crypto.ts); production takes a full-strength random key. A
    // passphrase key still in use moves to ENCRYPTION_KEYS_PREVIOUS (docs/deploy.md → Rotating ENCRYPTION_KEY).
    if (!env.ENCRYPTION_KEY.startsWith('base64:'))
      ctx.addIssue({
        code: 'custom',
        path: ['ENCRYPTION_KEY'],
        message:
          'must be base64:<32 random bytes> in production (openssl rand -base64 32); move a passphrase key to ENCRYPTION_KEYS_PREVIOUS',
      });
    // The defaults point at localhost over http: the browser origin and OAuth callback must be the real https ones.
    for (const key of ['FRONTEND_ORIGIN', 'GOOGLE_REDIRECT_URI'] as const) {
      if (!isPublicHttpsUrl(env[key]))
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must be set to an https URL on a public host (production)',
        });
    }
  }
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'] as const) {
    need(key, 'for Google Drive, where attachments are stored');
  }
});

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}
if (parsed.data.NODE_ENV === 'production' && parsed.data.OUTBOUND_ALLOWED_DOMAINS.length === 0) {
  console.warn(
    'OUTBOUND_ALLOWED_DOMAINS is empty: replies and forwards may go to any domain. Set the domains submission data may be sent to.',
  );
}

// Dropped from the schema, so a line left behind by an upgrade would otherwise be ignored without a word.
for (const key of ['STORAGE_DRIVER', 'STORAGE_PATH'] as const) {
  if (process.env[key])
    console.warn(`${key} is no longer used: attachments are always stored in Google Drive. Delete the line.`);
}
for (const key of ['IMS2_API_BASE', 'IMS2_INTAKE_TOKEN'] as const) {
  if (process.env[key])
    console.warn(
      `${key} is no longer used: the direct IMS 2 hand-off was removed; set the queue URL and token in Settings → IMS 2 intake. Delete the line.`,
    );
}
for (const key of ['IMS2_INTAKE_QUEUE_BASE', 'SUBMISSION_INTAKE_TOKEN'] as const) {
  if (process.env[key])
    console.warn(
      `${key} is no longer read from the environment: set the IMS 2 intake queue URL and token in Settings → IMS 2 intake. Delete the line.`,
    );
}
if (process.env.GMAIL_QUERY) {
  console.warn(
    'GMAIL_QUERY is no longer used: the inbox search is fixed to "in:inbox" (services/gmail.ts). Delete the line.',
  );
}
if (process.env.GMAIL_POLL_INTERVAL_SECONDS) {
  console.warn(
    'GMAIL_POLL_INTERVAL_SECONDS is no longer used: set the interval in Settings → Monitoring → Gmail monitoring. Delete the line.',
  );
}
if (process.env.GDRIVE_ROOT_FOLDER_ID) {
  console.warn(
    'GDRIVE_ROOT_FOLDER_ID is no longer used: the server keeps its own folder named GDRIVE_ROOT_FOLDER_NAME (see the README). Delete the line.',
  );
}

/** Pool sizes for RUNTIME=netlify: each function instance serves one request at a time against a pooled (Neon) URL. */
const NETLIFY_DB_POOL_MAX = 3;
const NETLIFY_DB_LOCK_POOL_MAX = 2;

/** The parsed environment with its derived defaults filled in (pool sizes, migration checks, development database). */
export function resolveConfig(data: z.infer<typeof ConfigSchema>) {
  const netlify = data.RUNTIME === 'netlify';
  return {
    ...data,
    DATABASE_URL: data.DATABASE_URL ?? DEV_DATABASE_URL,
    DB_POOL_MAX: data.DB_POOL_MAX ?? (netlify ? NETLIFY_DB_POOL_MAX : data.JOB_CONCURRENCY * 2 + 10),
    DB_LOCK_POOL_MAX: data.DB_LOCK_POOL_MAX ?? (netlify ? NETLIFY_DB_LOCK_POOL_MAX : data.JOB_CONCURRENCY + 4),
    MIGRATION_CHECKSUM_CHECK: data.MIGRATION_CHECKSUM_CHECK ?? (data.NODE_ENV === 'production' ? 'fail' : 'warn'),
    MIGRATION_REPLAY_CHECK: data.MIGRATION_REPLAY_CHECK ?? (process.env.CI ? 'fail' : 'warn'),
  };
}

export const config = resolveConfig(parsed.data);

/** Whether this process runs as Netlify functions (RUNTIME=netlify) rather than a long-running server. */
export const isNetlifyRuntime = (): boolean => config.RUNTIME === 'netlify';

/** Anthropic model IDs look like `claude-opus-5-5`; anything else is most likely a typo that fails on the first call. */
export const isValidModelId = (id: string) => /^claude-[a-z0-9-.]+$/.test(id);
for (const key of [
  'ANTHROPIC_MODEL_CLASSIFICATION',
  'ANTHROPIC_MODEL_EXTRACTION',
  'ANTHROPIC_MODEL_SYNTHESIS',
  'ANTHROPIC_MODEL_ANALYSIS',
  'ANTHROPIC_MODEL_CHAT',
  'ANTHROPIC_MODEL_COMPARISON',
  'ANTHROPIC_MODEL_QUOTE',
  'ANTHROPIC_MODEL_EMAIL_DRAFT',
] as const) {
  const v = config[key];
  if (v && !isValidModelId(v))
    console.warn(`${key}="${v}" does not look like an Anthropic model ID (claude-...); check the value.`);
}
export const googleOAuthConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
export const gmailSource: 'MCP' | 'OAUTH' = config.GMAIL_ENABLE_VIA_MCP || !googleOAuthConfigured ? 'MCP' : 'OAUTH';
export const gmailMcpConfigured = Boolean(config.GMAIL_MCP_URL || config.GMAIL_MCP_COMMAND);
export const gmailConfigured = gmailSource === 'MCP' ? gmailMcpConfigured : googleOAuthConfigured;

/** Settings whose values are secrets: the startup log says only whether each is set. */
const SECRET_CONFIG_KEYS = new Set<string>([
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'ENCRYPTION_KEYS_PREVIOUS',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GMAIL_PUSH_TOKEN',
  'GMAIL_MCP_TOKEN',
  'SETUP_TOKEN',
  'WORKER_TOKEN',
  'ALERT_WEBHOOK_URL',
]);

/**
 * The effective configuration for the startup log: secrets shown as `[set]`, and the database password masked in
 * connection URLs. Any key whose name looks secret (…SECRET…, …PASSWORD…, …_TOKEN, …_KEY) is masked too, so a key added
 * later without updating SECRET_CONFIG_KEYS still never reaches the log.
 */
export function redactedConfig(source: Record<string, unknown> = config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SECRET_CONFIG_KEYS.has(key) || /SECRET|PASSWORD|_TOKEN$|_KEYS?(_PREVIOUS)?$/.test(key)) {
      out[key] = '[set]';
    } else if (typeof value === 'string' && /^postgres(ql)?:\/\//.test(value)) {
      out[key] = value.replace(/(:\/\/[^:/@]+):[^@]*@/, '$1:[REDACTED]@');
    } else {
      out[key] = value;
    }
  }
  return out;
}
