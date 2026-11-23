/**
 * Backend tuning constants: limits, timeouts, intervals, budgets and model defaults, in one place.
 * Imports nothing from the project, so any module can import it without creating a cycle.
 * Environment-driven settings live in config.ts; this file holds only fixed values.
 */

// ---- HTTP & auth ----

/** How long a token's account state (role, token version, disabled) is cached; other processes see changes within this. */
export const AUTH_CACHE_MS = 30_000;
/** Lifetime of the Gmail OAuth state cookie: the state's own lifetime (services/gmail.ts). */
export const OAUTH_COOKIE_MAX_AGE_MS = 10 * 60_000;
/** Maximum JSON request body accepted by express.json. */
export const JSON_BODY_LIMIT = '1mb';
/** On shutdown, requests still in flight after the job deadline are cut after this long rather than holding the exit. */
export const SHUTDOWN_GRACE_MS = 5000;

// ---- Server-sent events ----

/** Interval of the SSE keep-alive comment. */
export const SSE_HEARTBEAT_MS = 25_000;
/** How often an open stream re-checks its account (disabled, signed out everywhere, role changed); it ends when that fails. */
export const SSE_REVALIDATE_MS = 45_000;
/** Reconnect delay the browser is told to use (`retry:` field). */
export const SSE_RETRY_MS = 5000;

// ---- Uploads & request limits ----

/** Per-file size limit of submission document uploads (default of Settings → Limits; also caps one part of a zip). */
export const UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Maximum files in one submission upload. */
export const UPLOAD_MAX_FILES = 20;
/**
 * Chunked uploads (RUNTIME=netlify): a function takes at most 6 MB per request, and binary bodies arrive base64-encoded
 * (4/3 larger), so each chunk is 3 MiB.
 */
export const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
/** A chunked upload no request has used after this long is abandoned; the retention task deletes it. */
export const UPLOAD_STALE_MS = 24 * 3600_000;
/** Size limit of a rating lookup workbook (.xlsx) uploaded from Settings. */
export const RATE_WORKBOOK_MAX_BYTES = 20 * 1024 * 1024;
/** Earlier chat messages (questions and answers) sent with a new question. */
export const CHAT_HISTORY_TURNS = 20;

// ---- LLM (models, token limits, pricing) ----

/** Default Claude model when Settings has none. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
/** Offered in the Settings model field; any claude-* ID is accepted. */
export const SUGGESTED_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
/**
 * Default and bounds of the output caps (thinking included) of synthesis, analysis and comparison, each its own
 * setting in Settings → Limits. The floor sits above the longest report so far (19,612 tokens), so no setting can cut
 * a normal report; the ceiling is the old fixed limit.
 */
export const REPORT_MAX_TOKENS = { default: 32_000, min: 20_000, max: 64_000 } as const;
/** Default output caps (thinking included) per call purpose: one call each, no retry after truncation; defaults of Settings → Limits. */
export const LLM_MAX_TOKENS = {
  chat: 16000,
  emailDraft: 16000,
  autoQuote: 16000,
  classification: 16000,
  extraction: 64000,
} as const;
/**
 * Overall cap of one Claude call, the streamed answer included (the SDK timeout only covers until the response headers,
 * so a stalled stream would never end); default of Settings → Limits.
 */
export const CLAUDE_RESPONSE_TIMEOUT_MS = 15 * 60_000;
/** Timeout of the Claude connection probe (status header / Settings test of the saved key). */
export const CLAUDE_PING_TIMEOUT_MS = 8000;
/** SDK-level retries of a Claude request (429, 5xx, connection errors), set explicitly on the client. */
export const ANTHROPIC_MAX_RETRIES = 2;
/** Backstop re-read of the Anthropic settings, for a NOTIFY missed while LISTEN was down. */
export const ANTHROPIC_SETTINGS_RESYNC_MS = 5 * 60_000;
/** Backstop re-read of Settings → Limits & timeouts, for a NOTIFY missed while LISTEN was down. */
export const LIMITS_SETTINGS_RESYNC_MS = 5 * 60_000;
/** Backstop re-read of the IMS 2 intake queue URL and token (Settings → IMS 2 intake), for a missed NOTIFY. */
export const IMS2_QUEUE_SETTINGS_RESYNC_MS = 5 * 60_000;
/** How long a classification verdict is reused for an identical prompt. */
export const CLASSIFICATION_REUSE_MS = 30 * 60_000;
/** Maximum classification verdicts held for reuse. */
export const CLASSIFICATION_REUSE_MAX = 500;
/**
 * USD price per million tokens (input, output) and the cache-read multiplier of the input price, from the claude-api
 * skill's pricing table (first-party API rates, cached 2026-10-06). Used for Monitoring's cost and savings estimates and
 * llm_calls.cost_usd (never billing). Matched by prefix so dated snapshots count (first match wins, so longer prefixes
 * come first); an unknown model gets no estimate.
 */
export const MODEL_PRICES: [prefix: string, inputPerMTok: number, cacheRead: number, outputPerMTok: number][] = [
  ['claude-fable-5-1', 10, 0.025, 50],
  ['claude-mythos-5-1', 10, 0.025, 50],
  ['claude-fable-5', 10, 0.1, 50],
  ['claude-opus-5-5', 4, 0.05, 20],
  ['claude-opus-5', 5, 0.1, 25],
  ['claude-opus-4', 5, 0.1, 25],
  ['claude-sonnet-5', 2, 0.1, 10],
  ['claude-sonnet-4', 3, 0.1, 15],
  ['claude-haiku-5-5', 0.1, 0.1, 0.5],
  ['claude-haiku-4', 1, 0.1, 5],
];
/** Share of LLM_DAILY_TOKEN_BUDGET at which a system error (scope llm-budget-80) warns admins, at most once a day. */
export const LLM_BUDGET_ALERT_SHARE = 0.8;
/** System error scope of the budget alert. */
export const LLM_BUDGET_ALERT_SCOPE = 'llm-budget-80';
/** Submissions listed in Monitoring's top spenders. */
export const TOP_SUBMISSIONS_BY_COST = 10;
/** Cache-write price multiplier, 5-minute lifetime. */
export const CACHE_WRITE_5M = 1.25;
/** Cache-write price multiplier, 1-hour lifetime. */
export const CACHE_WRITE_1H = 2;

// ---- Gmail & ingest queue ----

/** Per-request timeout of the Gmail API and the Gmail MCP server (the MCP SDK's own default); default of Settings → Limits. */
export const GMAIL_REQUEST_TIMEOUT_MS = 60_000;
/** Upper bound for the history-gap fallback: two days of a busy intake mailbox, without an unbounded walk. */
export const GMAIL_RECENT_IDS_MAX = 5000;
/** While polling is off, the setting is re-read this often so turning it back on (on any instance) takes effect. */
export const GMAIL_OFF_RECHECK_MS = 60_000;
/** Gmail MCP child stderr lines logged per minute at most, so a chatty or crash-looping server cannot flood the logs. */
export const GMAIL_MCP_STDERR_LINES_PER_MINUTE = 20;
/** A claimed ingest row is leased for this long (SQL); if the process dies mid-ingest, it becomes due again afterwards. */
export const INGEST_LEASE_INTERVAL = "interval '15 minutes'";
/** Ingest queue rows claimed per batch. */
export const INGEST_BATCH_SIZE = 10;
/** Maximum messages ingested in one drain. */
export const INGEST_MAX_PER_DRAIN = 200;
/** Unit of the exponential ingest retry backoff (SQL interval, multiplied by 2^attempts). */
export const INGEST_BACKOFF_UNIT = '1 minute';
/** Cap of the ingest retry backoff (SQL interval). */
export const INGEST_BACKOFF_MAX = '6 hours';
/** Maximum Drive/Docs links in an email body recorded as linked-file gaps. */
export const MAX_LINKED_GAPS = 20;
/** A new email without a verdict is hidden from the tabs for this long while it is classified (SQL interval). */
export const CLASSIFYING_WINDOW = '5 minutes';

// ---- Google Drive ----

/** Above this, upload in resumable chunks so a dropped connection resumes instead of restarting. */
export const DRIVE_RESUMABLE_ABOVE_BYTES = 5 * 1024 * 1024;
/** Resumable upload chunk size; must be a multiple of 256 KiB. */
export const DRIVE_CHUNK_BYTES = 8 * 1024 * 1024;
/**
 * Downloads and previews of files up to this size are read whole and cached (quick re-opens in the viewer); larger
 * ones stream from Drive to the browser without being held in memory.
 */
export const DOWNLOAD_BUFFER_MAX_BYTES = 10 * 1024 * 1024;
/** Without a timeout a hung request would stall the Gmail queue drain or a manual upload indefinitely; default of Settings → Limits. */
export const DRIVE_REQUEST_TIMEOUT_MS = 120_000;
/** Base of the exponential retry delay of a failed resumable chunk (base * 2^failures). */
export const DRIVE_RETRY_BASE_MS = 500;
/** Only Drive files older than this are considered orphans by the sweep. */
export const ORPHAN_AGE_MS = 24 * 3600_000;
/** Drive files looked up against the documents table per query during the orphan sweep. */
export const DRIVE_ORPHAN_LOOKUP_BATCH = 200;

// ---- Job queue ----

/** Base of the job retry backoff, in seconds. */
export const JOB_BACKOFF_BASE_S = 30;
/** Cap of the job retry backoff, in seconds. */
export const JOB_BACKOFF_MAX_S = 3600;
/** How often finished jobs are pruned. */
export const JOB_PRUNE_EVERY_MS = 3600_000;

// ---- Serverless runtime (RUNTIME=netlify) ----

/** A Netlify background function is killed at 15 min: the worker stops claiming new jobs after this long... */
export const WORKER_CLAIM_DEADLINE_MS = 12 * 60_000;
/** ...and at this point hands its unfinished jobs back to the queue (attempt not counted) and returns. */
export const WORKER_HARD_DEADLINE_MS = 14 * 60_000;
/** Before a drain ends for want of work it looks once more after this long (a job enqueued in an uncommitted transaction). */
export const WORKER_IDLE_GRACE_MS = 2000;
/** While jobs run, the drain looks for newly claimable work at least this often. */
export const WORKER_DRAIN_TICK_MS = 1000;
/** A worker trigger (a POST the background function answers with 202 at once) gives up after this long. */
export const WORKER_TRIGGER_TIMEOUT_MS = 10_000;
/** Without LISTEN/NOTIFY, a synced setting older than this is re-read at the start of a request (services/syncedSetting.ts). */
export const SYNCED_SETTING_MAX_AGE_MS = 30_000;
/**
 * Automatic retries of a processing run after a short-lived failure (Claude overloaded or rate limited, a 5xx, a
 * timeout, a dropped connection). Each one resumes from the failed step; after the last the submission goes to ERROR.
 */
export const PROCESSING_AUTO_RETRIES = 2;
/** Delay before the first automatic processing retry, in seconds; doubled for each further one (30 s, 60 s). */
export const PROCESSING_RETRY_BACKOFF_S = 30;

// ---- Background schedules ----

/** Period of the Gmail ↔ DB reconciliation check. */
export const GMAIL_RECONCILE_EVERY_MS = 24 * 3600_000;
/** Delay before the first Gmail reconciliation, so startup and the first Gmail poll are not slowed down. */
export const GMAIL_RECONCILE_FIRST_AFTER_MS = 10 * 60_000;
/** Period of the Drive orphan sweep (weekly). */
export const DRIVE_ORPHAN_SWEEP_EVERY_MS = 7 * 24 * 3600_000;
/** Delay before the first Drive orphan sweep. */
export const DRIVE_ORPHAN_SWEEP_FIRST_AFTER_MS = 30 * 60_000;
/** Period of the retention purge (services/retention.ts): daily. */
export const RETENTION_EVERY_MS = 24 * 3600_000;
/** Delay before the first retention purge after startup. */
export const RETENTION_FIRST_AFTER_MS = 10 * 60_000;
/** Rows one retention DELETE removes before the next batch, so no single statement holds locks for long. */
export const RETENTION_BATCH = 1000;
/** Shortest and longest retention period an admin can set, in days (Settings → Retention). */
export const RETENTION_DAYS = { min: 30, max: 3650 } as const;
/** Backstop re-read of skill overrides, for a NOTIFY missed while this instance's LISTEN connection was down. */
export const SKILL_OVERRIDES_RESYNC_MS = 5 * 60_000;

// ---- NPI registry ----

/** NPPES registry API version sent with every request. */
export const NPI_API_VERSION = '2.1';
/** Maximum records requested from a registry name search. */
export const NPI_SEARCH_LIMIT = 50;
/** Timeout of a registry lookup or search, and of the reachability ping; default of Settings → Limits. */
export const NPI_TIMEOUT_MS = 15000;
/** A known-valid NPI looked up by the reachability ping. */
export const NPI_PROBE_NUMBER = '1234567893';
/** How long a registry record found by NPI number is reused before CMS is asked again. */
export const NPI_CACHE_TTL_MS = 24 * 60 * 60_000;
/** A "not found" answer is reused for less time: a newly issued NPI should show up soon. */
export const NPI_NOT_FOUND_CACHE_TTL_MS = 60 * 60_000;
/** Attempts per registry request: transient failures (network, timeout, 408/429/5xx) are retried. */
export const NPI_RETRY_ATTEMPTS = 3;
/** First retry delay; doubles per attempt, with jitter. A Retry-After header overrides it, up to the cap. */
export const NPI_RETRY_BASE_MS = 500;
export const NPI_RETRY_MAX_DELAY_MS = 10_000;

// ---- IMS 2 queue ----

/** A SENDING row older than this was a send whose process died: it no longer blocks a new one. */
export const IMS2_SENDING_STALE_MS = 2 * 60_000;
/** Under IMS 2's 512 KB inbox cap, with room for headers and escaping; must stay below that cap. */
export const IMS2_REVIEW_BUDGET_BYTES = 480 * 1024;

// ---- Text extraction & OCR ----

/** Maximum characters of text kept from one document. */
export const EXTRACTED_TEXT_MAX_CHARS = 400_000;
/**
 * A zip is one document downstream, so its text must fit what a single document gets read for:
 * EXTRACTION_PER_SOURCE_CHARS (reports read more, see REPORT_PER_DOC_CHARS).
 */
export const ZIP_TEXT_BUDGET = 60_000;
/** Inner files are read one by one and may need OCR, which is slow. */
export const ZIP_MAX_ENTRIES = 50;
/** Maximum total uncompressed bytes read from one zip. */
export const ZIP_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** DOCX/XLSX entry limit (embedded images make real files run to hundreds). */
export const OOXML_MAX_ENTRIES = 1000;
/** Maximum expansion ratio of a zip/OOXML entry. */
export const ZIP_MAX_RATIO = 100;
/** Small files may compress well beyond the ratio harmlessly. */
export const ZIP_RATIO_FLOOR_BYTES = 10 * 1024 * 1024;
/** Scanned PDFs: pages rasterised for OCR (each also capped at OCR_MAX_PIXELS); default of Settings → Limits. */
export const PDF_OCR_PAGES = 10;
/** Scanned PDFs: rasterisation scale for OCR. */
export const PDF_OCR_SCALE = 2;

// ---- Prompt/report size budgets ----

/** Characters of each source sent to field extraction; default of Settings → Limits. */
export const EXTRACTION_PER_SOURCE_CHARS = 60_000;
/** Characters of the email body sent to classification (attachments are not read there); default of Settings → Limits. */
export const CLASSIFICATION_BODY_CHARS = 8000;
/** Characters of each document sent to a synthesis/analysis report. */
export const REPORT_PER_DOC_CHARS = 80_000;
/** Email drafts need the broker's wording and sign-off, not the whole thread. */
export const EMAIL_DRAFT_BODY_MAX_CHARS = 4000;

// ---- Outbound email ----

/** Gmail accepts 25 MB per message; base64 adds about a third, so raw attachments must stay under 18 MB. */
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
/** Linear retry step of outbound DB writes (step * attempt number). */
export const OUTBOUND_DB_RETRY_MS = 200;
/** Attempts of an outbound DB write before giving up. */
export const OUTBOUND_DB_RETRY_ATTEMPTS = 3;

// ---- Notifications ----

/** NOTIFY payloads are capped at 8000 bytes; a longer event sends only its id and each instance reads it back. */
export const NOTIFY_MAX_PAYLOAD_BYTES = 7000;
/** Maximum new-email events replayed to a reconnecting stream. */
export const NOTIFICATION_REPLAY_LIMIT = 20;

// ---- Geo/ZIP data ----

/** Census 2020 ZCTA↔county relationship (public domain): every county a ZIP overlaps, with land area. */
export const CENSUS_URL =
  'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt';
/** GeoNames US postal codes (CC BY 4.0, https://www.geonames.org): ZIP → city, state, county. */
export const GEONAMES_URL = 'https://download.geonames.org/export/zip/US.zip';
/** Timeout of a geo data file download. */
export const GEO_DOWNLOAD_TIMEOUT_MS = 120_000;
/** Maximum uncompressed size of the GeoNames archive entry. */
export const GEO_MAX_UNZIPPED_BYTES = 128 * 1024 * 1024;
/** Confidence of a looked-up county from a ZIP in one county: below any clearly stated value. */
export const SINGLE_COUNTY_CONFIDENCE = 0.85;
/** Confidence of a looked-up county when the ZIP spans several counties. */
export const MULTI_COUNTY_CONFIDENCE = 0.6;
/**
 * A specialty factor an underwriter enters for a specialty no rate class matches (quote dialog): bounded so a slip
 * like 135 for 1.35 is caught. A specialty that matches a class exactly always takes the rate table's factor.
 */
export const MANUAL_FACTOR = { min: 0.1, max: 10 } as const;
/** Confidence of a contact detail taken from a matched NPI registry record: below any value a document states. */
export const NPI_REGISTRY_CONFIDENCE = 0.85;

// ---- Settings bounds ----

/** Fewest days a manual Gmail import may cover. */
export const IMPORT_DAYS_MIN = 1;
/** Most days a manual Gmail import may cover. */
export const IMPORT_DAYS_MAX = 365;
/** Where "today" starts for the manual "Import today's emails": midnight US Eastern. */
export const IMPORT_TODAY_TIME_ZONE = 'America/New_York';
/** Seconds between automatic Gmail checks when not set. */
export const POLL_INTERVAL_DEFAULT = 60;
/** Shortest Gmail poll interval allowed (seconds; 0 = off is also allowed). */
export const POLL_INTERVAL_MIN = 10;
/** Longest Gmail poll interval allowed (seconds). */
export const POLL_INTERVAL_MAX = 3600;
/** Maximum characters of one skill file edited in Settings. */
export const MAX_SKILL_FILE_CHARS = 200_000;
/** Connection-status probes hit external APIs, so results are shared across callers for this long. */
export const SYSTEM_STATUS_TTL_MS = 30_000;
/** Some clients (Gmail) set no request timeout of their own; a Settings connection test never waits longer. */
export const CONNECTION_TEST_TIMEOUT_MS = 25_000;

// ---- Failure messages ----
// Every failure shown to a person says what happened, then what to do (services/friendlyError.ts picks one). The
// wording mirrors FAILURE_MESSAGES in frontend/src/constants.ts; change both together.

/** Ending for a short-lived failure. */
export const RETRY_LATER = 'Wait a few minutes, then retry.';
/** Ending for a failure an admin may have to look into. */
export const ASK_ADMIN = 'Retry; if it keeps failing, an admin can see the technical details in Monitoring.';

export const FAILURE_MESSAGES = {
  // Raw failure text, by category.
  credit: 'The Claude account is out of credit. An admin needs to add credit to the Anthropic account, then retry.',
  tooLong:
    'The documents in this email are too long for Claude to read in one go. An admin can lower "Text kept per document" in Settings → Limits, then retry.',
  auth: 'The Claude API key is missing or no longer valid. An admin can update it in Settings → Claude.',
  permission: 'The Claude account does not allow this request. Ask an admin to check Settings → Claude.',
  model: 'The Claude model chosen in Settings is not available. An admin can pick another model in Settings → Claude.',
  rateLimit: `Claude is receiving too many requests right now. ${RETRY_LATER}`,
  overloaded: `Claude is overloaded right now. ${RETRY_LATER}`,
  serverError: `Claude had a temporary problem. ${RETRY_LATER}`,
  truncated:
    "Claude's answer was too long and was cut off. An admin can raise the output limit in Settings → Claude → Output limits, then retry.",
  budget: "Today's AI usage limit has been reached. Processing can continue tomorrow, or an admin can raise the limit.",
  submissionBudget:
    'This submission has reached its daily AI usage limit. Try again later or ask an admin to raise LLM_SUBMISSION_DAILY_TOKEN_BUDGET.',
  timeout:
    'A service took too long to answer. Retry; if it keeps happening, an admin can raise the timeout in Settings → Connections.',
  drive:
    'Files could not be read or saved in Google Drive. Retry; if it keeps failing, an admin should test Google Drive in Settings → Connections.',
  network: `A required service could not be reached. ${RETRY_LATER}`,
  badRequest: `Claude could not accept this request. ${ASK_ADMIN}`,
  // Nothing more specific to say.
  processingFailed: 'Processing failed.',
  unknown: `Something went wrong while processing this email. ${ASK_ADMIN}`,
  /** The same outside email processing (reports, comparisons, API requests). */
  unknownGeneral: `Something went wrong. ${ASK_ADMIN}`,
  // API responses (errorHandler.ts, http.ts).
  internal: `Something went wrong on the server. ${ASK_ADMIN}`,
  conflict: 'Someone else changed this at the same time. Reload and try again.',
  fileMissing:
    'The stored file could not be found. Upload it again, or ask an admin to test Google Drive in Settings → Connections.',
  storageDown: `Files could not be read or saved in Google Drive right now. ${RETRY_LATER}`,
  forbidden: 'Your role does not allow this. Ask an admin if you need access.',
  invalidBody: 'Some of the values sent are not valid. Check them and try again.',
} as const;

/** Page size of a submission's audit trail (GET /submissions/:id/audit): the default and the largest a client may ask for. */
export const AUDIT_PAGE_DEFAULT = 100;
export const AUDIT_PAGE_MAX = 500;

/** Error reports a browser may send per minute (POST /api/client-errors, open before sign-in). */
export const CLIENT_ERROR_RATE_LIMIT_PER_MIN = 20;
