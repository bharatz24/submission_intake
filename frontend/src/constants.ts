// Frontend tuning constants: polling, caching, debounce, limits, pagination, external URLs and display thresholds.
// Plain literals only: this module imports nothing from the project, so anything can import it without a cycle.

// ---- Polling / refetch intervals ----

/** React Query `refetchInterval` and other polling periods, in milliseconds. */
export const POLL_MS = {
  /** Synthesis / Analysis reports (and Compare) while a version is RUNNING. */
  reportRunning: 2000,
  /** Claude chat while an answer is PENDING (written by a background job). */
  chatAnswerPending: 1500,
  /** Draft email dialog while a draft is being generated (a background job). */
  emailDraftRunning: 2000,
  /** Sidebar system status (Layout). */
  systemStatus: 60_000,
  /** Sidebar unread-count badge (Layout). */
  unreadCount: 45_000,
  /** Inbox list when idle. */
  inbox: 45_000,
  /** Inbox list while emails are still being classified. */
  inboxClassifying: 3_000,
  /** Gmail connection status on the Settings / Monitoring pages. */
  gmailStatusSettings: 30_000,
  /** Gmail connection status in the Inbox. */
  gmailStatusInbox: 60_000,
  /** System status on the Settings / Monitoring pages. */
  systemStatusSettings: 60_000,
  /** Failed Gmail imports panel in the Inbox. */
  failedGmail: 60_000,
  /** Skipped-emails count (Inbox) and list (SkippedEmailsPanel). */
  skippedEmails: 60_000,
  /** Inbox Gmail sync info while a sync is running. */
  inboxSyncRunning: 3_000,
  /** IMS 2 intake-queue sync info while a sync is running (Settings). */
  ims2SyncRunning: 3_000,
  /** IMS 2 intake-queue row status while QUEUED (Ims2IntakeQueueCard). */
  ims2Queued: 3 * 60_000,
  /** Monitoring stats (Settings). */
  monitoringStats: 15_000,
  /** LLM token usage (TokenUsageTab). */
  tokenUsage: 15_000,
  /** Submission detail while NEW / PROCESSING or a document extraction is PENDING (SubmissionWorkspace). */
  submissionProcessing: 3000,
  /** Inbox refresh after a failed Gmail message is retried (the retry runs in the background). */
  failedGmailRetryRefresh: 3_000,
} as const;

// ---- Query cache (staleTime) ----

/** React Query defaults (main.tsx). */
export const QUERY_DEFAULTS = {
  /** Default `staleTime` for every query, in ms. */
  staleTime: 10_000,
  /** Transient (non-4xx) failures are retried this many times. */
  retryCount: 1,
  /** A read (GET) that gets no answer in this long is abandoned, so a page never loads forever. */
  readTimeoutMs: 30_000,
} as const;

/** Per-query `staleTime`, in milliseconds. */
export const STALE_MS = {
  /** Gmail status in the compose dialog. */
  gmailStatusCompose: 30_000,
  /** IMS 2 intake-queue lookups (Ims2IntakeQueueCard). */
  ims2Lookup: 5 * 60_000,
  /** NPI registry lookup (NpiEntryBar). */
  npiLookup: 5 * 60_000,
  /** Admin-editable limits: upload sizes, token caps, timeouts (Settings and upload screens). */
  limits: 5 * 60_000,
  /** Rate options, base and per state (QuoteDialog). */
  rateOptions: 5 * 60_000,
  /** Skills list (Settings). */
  skills: 60_000,
  /** Users list for assignment (SubmissionWorkspace). */
  users: 60_000,
  /** Automation modes (Settings → Automation and the "Manual" hints on a submission). */
  automation: 60_000,
} as const;

// ---- Debounce & autosave ----

/** Delays before acting on typing, in milliseconds. */
export const DEBOUNCE_MS = {
  /** Audit trail action / submission filters. */
  auditFilter: 400,
  /** Inbox search box. */
  inboxSearch: 350,
  /** Email draft autosave. */
  draftAutosave: 800,
  /** "Choose original" search when merging a duplicate (SubmissionWorkspace). */
  mergeSearch: 300,
} as const;

/** Object URLs of downloaded files are revoked this long after the download starts, in ms (services/api.ts). */
export const REVOKE_OBJECT_URL_DELAY_MS = 10_000;

// ---- Live events (SSE) ----

/** While connected, the cursor's timestamp is refreshed at most this often (on heartbeats), so a reload resumes it. */
export const CURSOR_REFRESH_MS = 20_000;
/** The server sends a heartbeat every 25 s; this long without any data means the connection is dead. */
export const SILENCE_TIMEOUT_MS = 60_000;
/** How often the silence watchdog checks for a dead connection, in ms. */
export const SSE_WATCHDOG_MS = 5_000;
/** Poll transport (VITE_EVENTS_TRANSPORT=poll, serverless deployments): how often the leader tab asks for new emails. */
export const EVENTS_POLL_INTERVAL_MS = 15_000;
/** Reconnect backoff in seconds per attempt (0-based): 1, 2, 5, 10, then 30 seconds. */
export const BACKOFF_SECONDS = [1, 2, 5, 10, 30];
/** The longest reconnect delay, used once the attempts run past BACKOFF_SECONDS. */
export const BACKOFF_SECONDS_MAX = 30;
/** The stored cursor is resumed on page load only when younger than this, in ms; older mail is already in the Inbox. */
export const CURSOR_MAX_AGE_MS = 10 * 60_000;

// ---- Notifications & toasts ----

/** Most notifications kept in the bell list. */
export const MAX_NOTIFICATIONS = 50;
/** Most in-app toasts shown at once. */
export const TOAST_LIMIT = 3;
/** Each toast closes itself after this long, in ms. */
export const AUTO_HIDE_MS = 6000;

// ---- Limits ----

/** Minimum password length (user management and sign-in). */
export const MIN_PASSWORD = 10;
/** bcrypt hashes only the first 72 bytes, so the server refuses longer passwords (backend passwordPolicy.ts). */
export const MAX_PASSWORD_BYTES = 72;
/** Most validation lines shown from an ApiError's details; the rest collapse into "… and N more". */
export const MAX_ERROR_LINES = 8;
/**
 * Appended by the server when an answer hit the length limit.
 * Must match backend services/promptSafety.ts CHAT_TRUNCATION_NOTICE.
 */
export const TRUNCATION_MARKER = '_Answer truncated: it reached the maximum length.';
/** Plain-text mail is hard-wrapped near 76 columns: a line at least this long may have been wrapped. */
export const WRAP_MIN = 60;
/** A line was probably wrapped when the next line's first word would have overflowed this column. */
export const WRAP_COL = 72;
/** An email body longer than this many characters is shown collapsed (EmailCard). */
export const LONG_EMAIL_CHARS = 900;
/** An email body with more than this many blocks is shown collapsed (EmailCard). */
export const LONG_EMAIL_BLOCKS = 10;

// ---- Pagination ----

/** Rows-per-page choices for the Inbox and the skipped-emails panel. */
export const INBOX_ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
/** Rows-per-page choices for the audit trail and LLM token usage tables. */
export const TABLE_ROWS_PER_PAGE_OPTIONS = [25, 50, 100];
/** Default page sizes. */
export const PAGE_SIZE = {
  inbox: 25,
  skippedEmails: 25,
  tokenUsage: 25,
  audit: 50,
  /** "Choose original" search results when merging a duplicate. */
  mergeSearch: 10,
} as const;

// ---- External URLs ----

/** NPPES registry provider page; the NPI is appended. */
export const NPI_REGISTRY_URL = 'https://npiregistry.cms.hhs.gov/provider-view/';
/** Gmail message in the reviewer's first signed-in account; the Gmail message id is appended. */
export const GMAIL_MESSAGE_URL = 'https://mail.google.com/mail/u/0/#all/';

// ---- Gmail OAuth popup ----

/** Google consent pop-up width, in px. */
export const GMAIL_OAUTH_POPUP_WIDTH = 500;
/** Google consent pop-up height, in px. */
export const GMAIL_OAUTH_POPUP_HEIGHT = 650;
/** How often to check whether the pop-up was closed, in ms. */
export const GMAIL_OAUTH_POPUP_CLOSED_POLL_MS = 500;

// ---- Display thresholds ----

/** Monitoring: a queue depth above this is shown as a warning. */
export const QUEUE_DEPTH_WARNING = 10;
/** Monitoring: a Gmail poll older than this is flagged (the longest allowed poll interval is one hour). */
export const LAST_POLL_STALE_MS = 2 * 60 * 60 * 1000;
/** Token usage: a cache-read share at or above this (0..1) is shown as good. */
export const CACHE_SHARE_GOOD = 0.5;
/** Ignored emails: a "chance it was a submission" above this (0..1) is worth a look. */
export const SUBMISSION_CHANCE_WARNING = 0.15;
/** Confidence (0..1) colouring: at or above `success` is green, at or above `warning` is amber, else red. */
export const CONFIDENCE_THRESHOLDS = { success: 0.85, warning: 0.6 } as const;
/** Tooltip of the "Unverified" chip: the AI's evidence quote was not found in the document text. */
export const UNVERIFIED_EVIDENCE_HINT =
  'This quote was not found in the source text, so the value may not be grounded. Check the document before relying on it.';
/** Application completeness score (0..100) colouring: at or above `success` is green, at or above `warning` is amber. */
export const COMPLETENESS_THRESHOLDS = { success: 80, warning: 50 } as const;

// ---- Failure messages ----
// Every failure shown to a person says what happened, then what to do (lib/friendlyError.ts picks one). The wording
// mirrors FAILURE_MESSAGES in backend/src/constants.ts; change both together.

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
  unknown: `Something went wrong. ${ASK_ADMIN}`,
  processingFailed: 'Processing failed.',
  processingUnknown: `Something went wrong while processing this email. ${ASK_ADMIN}`,
  noReason: 'No reason was recorded.',
  reportNoReason: 'No reason was recorded. Generate it again to retry.',
  // An API response without a message of its own, by HTTP status.
  unreachable: 'The server could not be reached. Check your internet connection, then retry.',
  timedOut: 'The server took too long to answer. It may be restarting or busy. Wait a moment, then retry.',
  invalidResponse: `The server answered in a format this page does not understand. Reload the page; if it persists, ${'ask an admin to check that the app and server versions match.'}`,
  sessionExpired: 'Your session has expired. Please sign in again.',
  forbidden: 'You do not have permission to do this. Ask an admin if you need access.',
  notFound: 'This item could not be found. It may have been deleted; refresh the page and try again.',
  /** `code` is the status and its text, e.g. "502 Bad Gateway". */
  serverProblem: (code: string) => `The server had a problem (${code}). ${RETRY_LATER}`,
  requestFailed: (code: string) => `The request could not be completed (${code}). ${ASK_ADMIN}`,
} as const;

// ---- Toast messages ----
// What a toast (components/feedback/FeedbackProvider.tsx) says after an action: what happened, plus what follows from
// it when that is not obvious. Failures use FAILURE_MESSAGES / errorMessage instead.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Shown by the shared loader. */
export const LOADING_MESSAGES = {
  slow: 'This is taking longer than usual. Still working on it.',
} as const;

export const TOAST_MESSAGES = {
  retentionSaved: 'Saved. The next daily purge uses these periods.',
  undo: 'Undo',
  retry: 'Retry',
  // Email
  emailSent: (to: string[]) => `Email sent to ${to.length === 1 ? to[0] : plural(to.length, 'recipient')}.`,
  // Inbox
  markedRead: 'Marked as read.',
  markedUnread: 'Marked as unread.',
  allMarkedRead: 'Marked as read.',
  retryQueued: 'Retry queued. Processing continues from the failed step.',
  duplicateReleased: 'Released. It will be processed as a submission.',
  ignoredReleased: 'Processing it as a submission.',
  retryAllQueued: (n: number) => `${plural(n, 'submission')} queued for another attempt.`,
  deleted: (n: number) => `${plural(n, 'submission')} deleted.`,
  gmailRetryQueued: 'Retry queued. The message leaves this list once it imports.',
  skippedProcessing: 'Processing the skipped email as a submission.',
  skippedDeleted: (n: number) => `${plural(n, 'skipped email')} deleted.`,
  ims2Synced: (r: { linked: number; rejected: number; updated: number }) =>
    `IMS 2 synced: ${r.linked} linked · ${r.rejected} rejected · ${r.updated} refreshed.`,
  // Submission page
  statusChanged: (label: string) => `Status changed to ${label}.`,
  assigned: (name: string | null) => (name ? `Assigned to ${name}.` : 'Unassigned.'),
  classificationSaved: 'Classification updated.',
  documentsUploaded: (n: number) => `${n === 1 ? 'Document' : `${n} documents`} uploaded. Text extraction is running.`,
  reprocessQueued: 'Extraction and NPI verification queued.',
  importProcessQueued: 'Processing queued: documents, extraction, NPI and reports.',
  importProcessAllQueued: (n: number) => `${plural(n, 'imported email')} queued for processing.`,
  fieldSaved: (label: string) => `${label} saved.`,
  fieldRemoved: (label: string) => `Manual entry for ${label} removed.`,
  npiVerified: 'NPI verification complete.',
  npiAdded: (npi: string) => `NPI ${npi} added and checked against the registry.`,
  npiRemoved: 'NPI verification removed.',
  npiDecisionSaved: 'NPI decision saved.',
  npiDecisionUndone: 'NPI decision undone. The registry result applies again.',
  quoteSaved: (version: number) => `Quote v${version} saved.`,
  quoteUpdated: (version: number) => `Changes saved to quote v${version}.`,
  /** The confirm shown before a weak rate-class match is used. */
  weakClassMatch: (rateClass: string, requested: string) => ({
    title: 'Use a weak match?',
    message: `${rateClass} is only a weak match for "${requested}". Check that it is the right rate class before using it.`,
    confirmLabel: 'Use it anyway',
  }),
  // Users
  userCreated: (name: string) => `User ${name} created.`,
  passwordReset: (name: string) => `Password reset for ${name}. They are signed out everywhere.`,
  roleChanged: (name: string, role: string) => `${name} is now ${role}.`,
  userDisabled: (name: string) => `${name} disabled and signed out everywhere.`,
  userEnabled: (name: string) => `${name} enabled. They can sign in again.`,
  // Settings
  skillSaved: (path: string) => `${path} saved. New runs use it right away.`,
  skillReset: (path: string) => `${path} reset to the built-in version.`,
  claudeSaved: 'Saved. New Claude calls use these settings right away.',
  ims2QueueSaved: 'Saved. New calls to the IMS 2 intake queue use these settings right away.',
  automationSaved: 'Saved. New emails follow these settings; submissions already processed are not re-run.',
  limitsSaved: 'Saved. New work uses these limits right away.',
  pollIntervalSaved: (seconds: number) =>
    seconds
      ? `Saved. Gmail is checked every ${seconds} seconds.`
      : 'Saved. Polling is off; only push notifications bring in mail.',
  pollStarted: (started: boolean) =>
    started
      ? 'Checking Gmail in the background; new emails appear in the inbox as they arrive.'
      : 'Gmail is already being checked; new emails appear in the inbox as they arrive.',
  gmailDisconnected: 'Gmail disconnected.',
  ingestRetryQueued: (n: number) => `${plural(n, 'Gmail message')} queued to be stored again.`,
  errorsCleared: (n: number) => `${plural(n, 'error')} cleared.`,
} as const;
