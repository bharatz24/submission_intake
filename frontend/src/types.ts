// Shared API types used by the frontend (mirror backend response shapes).

export type Role = 'ADMIN' | 'UNDERWRITER' | 'VIEWER';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export type Classification = 'SUBMISSION' | 'NOT_SUBMISSION' | 'REVIEW_REQUIRED';
export type SubmissionStatus =
  | 'NEW'
  | 'PROCESSING'
  | 'READY_FOR_REVIEW'
  | 'IN_REVIEW'
  | 'COMPLETED'
  | 'NOT_SUBMISSION'
  | 'DUPLICATE'
  | 'ERROR';

/** Inbox tabs: NOT_SUBMISSION rows are "Ignored", DUPLICATE rows "Duplicates", ERROR rows "Errors", everything else "Submissions". */
export type InboxView = 'submissions' | 'ignored' | 'duplicates' | 'errors';
/** A Gmail message that failed to import; nothing of it is stored until a retry succeeds. */
export interface FailedGmailMessage {
  gmailMessageId: string;
  source: 'OAUTH' | 'MCP';
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  firstSeenAt: string;
  /** Parked after too many failed attempts: not retried automatically until someone retries it. */
  parked?: boolean;
}
/** A Gmail email skipped at intake as not a submission; only these details are stored (Ignored tab). */
export interface SkippedEmail {
  gmailMessageId: string;
  threadId: string | null;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  attachmentCount: number;
  confidence: number;
  reasons: string[];
  method: string;
  skippedAt: string;
}
export type DuplicateStrength = 'CERTAIN' | 'HIGH' | 'POSSIBLE';
export interface DuplicateBasis {
  rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R7' | 'R8' | 'MANUAL';
  strength: DuplicateStrength;
  similarity: number | null; // body similarity 0..1
  sharedAttachments: string[];
  daysSinceOriginal: number;
  originalId: string;
  method: 'AUTO' | 'MANUAL';
  explanation?: string; // the evidence in plain language
  differentSender?: boolean; // same content from another address
  addedWords?: string[];
  removedWords?: string[];
  by?: string;
  reason?: string;
}

export interface EmailMessage {
  id: string;
  gmailMessageId: string | null;
  threadId: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string;
  /** Original Cc recipients, comma-separated. */
  ccAddress?: string | null;
  snippet: string;
  bodyText: string;
  receivedAt: string;
}

export type NameType = 'INDIVIDUAL' | 'ORGANIZATION';

/** The processing steps a run goes through; a retry skips the finished ones and continues from the failed one. */
export type PipelineStep = 'classification' | 'documents' | 'fields' | 'npi';
export interface PipelineState {
  completedSteps: PipelineStep[];
  failedStep: PipelineStep | null; // the step that failed in the last run (null when it succeeded or none ran)
  error: string | null; // that step's error message
  autoRetrying: boolean; // a short-lived failure (overload, rate limit, timeout) waiting for an automatic retry; status stays PROCESSING
}

export interface SubmissionSummary {
  id: string;
  subject: string;
  fromAddress: string;
  receivedAt: string;
  status: SubmissionStatus;
  classification: Classification | null;
  classificationConfidence: number | null;
  classificationReasons: string[];
  applicantName: string | null;
  // applicantName split by type: individuals have first/last names, organizations an entity name.
  applicantType: NameType | null;
  applicantFirstName: string | null;
  applicantLastName: string | null;
  applicantEntityName: string | null;
  documentCount: number;
  npiStatus: NpiStatus | null; // npiStatus is the best check: one matching NPI verifies the submission
  npiVerifiedCount: number;
  npiFailedCount: number; // checks that are / are not MATCH or PARTIAL_MATCH
  latestSynthesisVersion: number | null;
  latestAnalysisVersion: number | null;
  assignedTo: { id: string; name: string } | null;
  contextVersion: number;
  updatedAt: string;
  isRead: boolean; // opened by the current user
  duplicateOf: { id: string; subject: string } | null; // the original this email repeats (status DUPLICATE)
  duplicateBasis: DuplicateBasis | null; // why it was held back (or ignored as a repeat of an ignored email)
  processingError: string | null; // why processing failed (status ERROR; Errors tab)
  heldForClassification: boolean; // classification is MANUAL: waiting for an underwriter to confirm it
  heldForImport: boolean; // imported from Settings: only classified; extraction, NPI and reports wait for Process
  pipeline: PipelineState; // which steps the last run finished / failed at (retry continues from failedStep)
  /** An automatic report or quote is waiting for a person to acknowledge it. */
  needsReview?: boolean;
}

export type ExtractionStatus = 'PENDING' | 'EXTRACTED' | 'OCR_EXTRACTED' | 'UNREADABLE' | 'UNSUPPORTED' | 'ERROR';
export interface DocumentInfo {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  source: 'EMAIL' | 'UPLOAD';
  extractionStatus: ExtractionStatus;
  ocrUsed: boolean;
  pageCount: number | null;
  textPreview: string;
  createdAt: string;
}

/** An attachment that could not be stored: over the size limit, shared as a Drive link, or listed without content. */
export type AttachmentGapReason = 'TOO_LARGE' | 'NO_CONTENT' | 'LINKED_FILE';
export interface AttachmentGap {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  reason: AttachmentGapReason;
  detail: string | null;
  createdAt: string;
}

export interface ExtractedField {
  id: string;
  fieldName: string;
  value: string;
  confidence: number; // 0..1
  evidenceQuote: string | null;
  sourceLabel: string; // e.g. "application.pdf p.2" or "email body"
  documentId: string | null;
  /** Whether the quote was found in the source text: false = unverified (confidence capped); null/absent = not checked. */
  evidenceVerified?: boolean | null;
}

/** A value a person entered; supersedes every extracted value with the same fieldName and survives reprocessing. */
export interface ManualField {
  id: string;
  fieldName: string;
  value: string;
  note: string | null;
  documentId: string | null; // the supporting document the value was taken from
  createdBy: { id: string; name: string } | null;
  updatedBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export type NpiStatus = 'MATCH' | 'PARTIAL_MATCH' | 'MISMATCH' | 'NOT_FOUND' | 'NOT_VERIFIED' | 'ERROR';
export interface NpiVerification {
  id: string;
  npi: string;
  claimedName: string | null;
  claimedState: string | null;
  claimedSpecialty: string | null;
  status: NpiStatus;
  registryName: string | null;
  registryTaxonomy: string | null;
  registryState: string | null;
  registryStatus: string | null; // 'A' active / 'D' deactivated
  mismatches: string[];
  registryData: unknown;
  verifiedAt: string;
  claimedType: NameType | null;
  claimedFirstName: string | null;
  claimedLastName: string | null;
  claimedEntityName: string | null;
  // From the registry record: NPI-1 individual, NPI-2 organization.
  registryType: NameType | null;
  registryFirstName: string | null;
  registryLastName: string | null;
  registryEntityName: string | null;
  // EXTRACTED: found on the submission. MANUAL: entered by a person; only these can be removed.
  source: 'EXTRACTED' | 'MANUAL';
  addedBy: { id: string; name: string } | null;
  note: string | null;
  // Set while an underwriter's decision stands: `status` is the decision, autoStatus what the registry check said.
  autoStatus: NpiStatus | null;
  overrideNote: string | null;
  overrideBy: { id: string; name: string } | null;
  overrideAt: string | null;
}

export type OutboundMode = 'REPLY' | 'REPLY_ALL' | 'FORWARD';
/** A reply or forward sent from a submission. */
export interface OutboundEmail {
  id: string;
  mode: OutboundMode;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  documentIds: string[];
  transport: 'OAUTH' | 'MCP';
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  /** PENDING: handed to Gmail, outcome not recorded yet; FAILED: Gmail refused it (error says why). */
  status: 'PENDING' | 'SENT' | 'FAILED';
  error: string | null;
  sentBy: { id: string; name: string };
  sentAt: string;
}

/** An automatic step after processing; `off` when it will not run by itself (Manual, no API key, skipped). */
export type AutoRunState = 'off' | 'waiting' | 'running' | 'done' | 'failed';
export interface AutoRun {
  synthesis: AutoRunState;
  analysis: AutoRunState;
  quote: AutoRunState;
}

export type ReportKind = 'SYNTHESIS' | 'ANALYSIS';
export type ReportStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export interface ReportSummary {
  id: string;
  kind: ReportKind;
  version: number;
  status: ReportStatus;
  contextVersion: number;
  basedOnReportId: string | null;
  skillName: string;
  skillVersion: string;
  model: string;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  /** Generated automatically (createdBy null) and not yet acknowledged by a person. */
  needsReview: boolean;
  reviewedAt: string | null;
  /** The reviewer's name. */
  reviewedBy: string | null;
}
export interface Report extends ReportSummary {
  content: SynthesisContent | AnalysisContent | null; // structured JSON
  markdown: string | null; // rendered report
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Evidence checked against the submission's sources; null when not graded (older versions). */
  grounding: Grounding | null;
}

/** One generated claim whose source or values were not found in the submission. `path` locates it in the content
 *  (e.g. "extractedFacts[0]", "riskIndicators[1].evidence[0]", "answer[2]"); `missing` lists what was not found
 *  ("source: loss_runs.pdf", "175000", "2021-01-05"). */
export interface GroundingItem {
  path: string;
  text: string;
  verdict: 'verified' | 'unverified' | 'unchecked';
  missing: string[];
}
/** Grounding check of a report or chat answer: counts of checked claims, and the unverified ones. */
export interface Grounding {
  checked: number;
  verified: number;
  unverified: number;
  items: GroundingItem[];
}

export type InjectionCategory = 'override' | 'role' | 'ai_address' | 'steering' | 'exfiltration' | 'hidden_text';
/** Instruction-like text found in the email (source 'email body') or an attachment (its filename). */
export interface InjectionFlag {
  id: string;
  documentId: string | null;
  source: string;
  category: InjectionCategory;
  excerpt: string;
}

export type Level = 'HIGH' | 'MEDIUM' | 'LOW';
export interface Sourced {
  text: string;
  source: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}
export interface SynthesisContent {
  submissionOverview: string;
  applicantProfile: {
    name: string | null;
    npi: string | null;
    specialty: string | null;
    state: string | null;
    practiceName: string | null;
    yearsInPractice: string | null;
    other: Sourced[];
  };
  emailAndAttachmentInventory: { item: string; type: string; status: string; notes: string }[];
  extractedFacts: Sourced[];
  npiVerificationSummary: string;
  conflicts: { description: string; sources: string[]; resolution: string }[];
  missingInformation: { item: string; importance: 'CRITICAL' | 'IMPORTANT' | 'NICE_TO_HAVE'; reason: string }[];
  dataConfidence: { overall: 'HIGH' | 'MEDIUM' | 'LOW'; notes: string };
  consolidatedContextForLlm: string;
}
export interface Finding {
  title: string;
  detail: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  evidence: string[];
}
export type RiskRating = 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH';
export type Recommendation = 'PROCEED' | 'PROCEED_WITH_CONDITIONS' | 'REFER' | 'DECLINE' | 'REQUEST_INFORMATION';
export interface AnalysisContent {
  executiveSummary: string;
  overallRisk: 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH';
  recommendation: 'PROCEED' | 'PROCEED_WITH_CONDITIONS' | 'REFER' | 'DECLINE' | 'REQUEST_INFORMATION';
  riskIndicators: Finding[];
  applicationCompleteness: { score: number; summary: string; gaps: string[] }; // score 0..100
  inconsistencies: Finding[];
  potentialConcerns: Finding[];
  missingInformation: string[];
  followUpQuestions: { question: string; rationale: string; addressedTo: string }[];
  recommendedNextSteps: string[];
  limitationsAndUncertainties: string[];
}

/** Two versions of one report kind compared (never Synthesis vs Analysis). */
export type ComparisonStatus = ReportStatus;
export type ChangeType = 'ADDED' | 'REMOVED' | 'MODIFIED';
export interface FieldChange {
  section: string;
  path: string;
  changeType: ChangeType;
  before: unknown;
  after: unknown;
}
export interface ComparisonChange {
  section: string;
  fieldPath: string;
  changeType: ChangeType;
  before: string;
  after: string;
  significance: Level;
  explanation: string;
  likelyCause: 'NEW_EVIDENCE' | 'SKILL_CHANGE' | 'MODEL_CHANGE' | 'MODEL_VARIANCE';
}
export interface ComparisonContent {
  summary: string;
  overallChange: 'NONE' | 'MINOR' | 'MATERIAL';
  changes: ComparisonChange[];
  unchangedSections: string[];
  reviewerNote: string;
}
export interface ComparisonSummary {
  id: string;
  kind: ReportKind;
  status: ComparisonStatus;
  baseReportId: string;
  baseVersion: number;
  targetReportId: string;
  targetVersion: number;
  skillName: string;
  skillVersion: string;
  model: string;
  changeCount: number;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}
export interface Comparison extends ComparisonSummary {
  fieldDiff: FieldChange[];
  content: ComparisonContent | null;
  markdown: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export type Decision = 'ACCEPT' | 'ACCEPT_WITH_CONDITIONS' | 'DECLINE' | 'REFER' | 'REQUEST_INFORMATION';
export interface Assessment {
  id: string;
  version: number;
  decision: Decision;
  riskRating: 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH';
  notes: string;
  analysisReportId: string | null;
  contextVersion: number;
  createdBy: { id: string; name: string };
  createdAt: string;
}

export interface ContextVersion {
  version: number;
  reason: string;
  snapshotHash: string;
  createdBy: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  submissionId: string | null;
  actorType: 'USER' | 'SYSTEM';
  actor: { id: string; name: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

// An answer is written by a background job: PENDING until Claude has answered, FAILED (with `error`) if it could not.
export type ChatStatus = 'PENDING' | 'COMPLETED' | 'FAILED';
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  userName: string | null;
  status: ChatStatus;
  error: string | null;
  /** Answers only: values not found in the submission; null when not graded. */
  grounding?: Grounding | null;
}

// Draft Email dialog (/submissions/:id/email-drafts): one draft for the picked audience, generated only by POST
// (the Generate button). Never sent.
export type EmailAudience = 'broker' | 'insured' | 'quote';
export interface EmailDraft {
  to: string | null;
  subject: string;
  body: string;
  keyPoints: string[];
}
export interface EmailDrafts {
  id: string;
  audience: EmailAudience;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  purpose: AnalysisContent['recommendation'];
  draft: EmailDraft;
  analysisReportId: string;
  analysisVersion: number;
  synthesisVersion: number;
  newerAnalysisVersion: number | null; // a completed analysis newer than the one the drafts were written from
  stale: boolean; // the evidence changed after the analysis ran
  model: string;
}
// GET/POST /email-drafts: the last completed draft, and a newer generation still running (a background job) or failed.
export interface EmailDraftRun {
  id: string;
  status: 'PENDING' | 'FAILED';
  error: string | null;
  createdAt: string;
}
export interface EmailDraftState {
  draft: EmailDrafts | null;
  run: EmailDraftRun | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SubmissionDetail extends SubmissionSummary {
  email: EmailMessage;
  documents: DocumentInfo[];
  attachmentGaps: AttachmentGap[];
  extractedFields: ExtractedField[];
  manualFields: ManualField[];
  coverage: CoverageSummary;
  npiVerifications: NpiVerification[];
  latestSynthesis: ReportSummary | null;
  latestAnalysis: ReportSummary | null;
  autoRun?: AutoRun; // the automatic Synthesis → Analysis → quote after processing
  processingQueued?: boolean; // a processing run is queued or running (status turns PROCESSING only when a worker takes it)
  latestAssessment: Assessment | null;
  processingError: string | null;
  processingErrorDetail?: string | null; // raw failure text for admins (plain message stays in processingError)
  duplicates: { id: string; subject: string; receivedAt: string }[]; // later copies of this email held as duplicates
  /** Instruction-like text found in the email or attachments; flagged, never blocked. */
  injectionFlags?: InjectionFlag[];
}

/** Inbox list: one tab's page plus every tab's total and unread count (both follow the search). */
export interface SubmissionPage extends Paged<SubmissionSummary> {
  /** Emails waiting for a verdict: on no tab yet. */
  classifying: number;
  counts: Record<InboxView, number>;
  unread: Record<InboxView, number>;
}

// ---- Endpoint-specific response shapes (from the endpoint tables) ----

/** The session token stays in the httpOnly cookie; the API returns it in the body only to scripts (`X-Client: cli`). */
export interface AuthResponse {
  user: User;
}
export interface BootstrapResponse {
  needsSetup: boolean;
  /** Production: the first account must enter the server's SETUP_TOKEN. */
  setupTokenRequired?: boolean;
}

export interface VersionsResponse {
  contextVersions: ContextVersion[];
  reports: ReportSummary[];
  assessments: Assessment[];
}

export interface GmailStatus {
  source: 'MCP' | 'OAUTH';
  error: string | null;
  configured: boolean;
  connected: boolean;
  email: string | null;
  mode: 'PUSH' | 'POLLING' | 'OFF';
  lastPollAt: string | null;
  lastHistoryId: string | null;
  watchExpiresAt: string | null;
}

export interface GmailImportSettings {
  minDays: number;
  maxDays: number;
  autoImportSince: string | null;
  /** Seconds between automatic Gmail checks; 0 = off. */
  pollIntervalSeconds: number;
  minPollIntervalSeconds: number;
  maxPollIntervalSeconds: number;
  /** Imported emails classified but not processed yet. */
  awaitingProcess: number;
}
/** Settings → Claude API. The key itself never reaches the browser. */
export interface AnthropicSettings {
  keySet: boolean;
  keyHint: string | null;
  keyError: string | null;
  model: string;
  defaultModel: string;
  suggestedModels: string[];
}
/** Settings → IMS 2 intake: the queue URL and token. The token itself never reaches the browser. */
export interface Ims2QueueSettings {
  baseUrl: string | null;
  tokenSet: boolean;
  tokenHint: string | null;
  tokenError: string | null;
  /** Both the URL and the token are set: sending to IMS 2 is on. */
  configured: boolean;
  /** The application or website the top bar's IMS button opens in a new tab; no button when null. */
  imsUrl: string | null;
}
export interface Ims2QueueTestResult {
  ok: boolean;
  detail: string;
}
export interface AnthropicTestResult {
  ok: boolean;
  model: string;
  detail: string;
}

/** What to import: the last `days` days, or today since midnight US Eastern. */
export type GmailImportScope = { days: number } | { today: true };

export type GmailImportResult = { found: number; enqueued: number } & (
  | { days: number }
  | { today: true; since: string }
);

/** Counts cover `range`; queueDepth, ingestQueue and lastPollAt are live. */
export interface MonitoringStats {
  range: LlmUsageRange;
  byStatus: Record<string, number>;
  byClassification: Record<string, number>;
  reports: { SYNTHESIS: number; ANALYSIS: number };
  failedReports: number;
  emails: number;
  duplicates: number;
  queueDepth: number;
  /** Gmail messages seen but not yet stored; `alerted` ones have failed GMAIL_RETRY_ALERT_AFTER times. */
  ingestQueue: { waiting: number; alerted: number; oldest: string | null };
  lastPollAt: string | null;
  recentErrors: { at: string; scope: string; message: string }[];
}

export type LlmCallStatus = 'SUCCESS' | 'REFUSED' | 'TRUNCATED' | 'INVALID_OUTPUT' | 'ERROR';
export interface LlmUsageCounts {
  calls: number;
  failed: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Estimated USD cost; null when no call in the group has a known model price. */
  costUsd: number | null;
}
export interface LlmTaskUsage extends LlmUsageCounts {
  task: string;
}
/** Usage for one task on one model; cacheSavingsUsd is an estimate, null for a model without a known price. */
export interface LlmModelUsage extends LlmUsageCounts {
  task: string;
  model: string;
  cacheSavingsUsd: number | null;
}
export interface LlmCall {
  id: string;
  at: string;
  task: string;
  model: string;
  status: LlmCallStatus;
  skillName: string;
  skillVersion: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Estimated USD cost; null for an unknown model or a call recorded before cost tracking. */
  costUsd: number | null;
  error: string | null;
  submissionId: string | null;
  applicantName: string | null;
}
/** One submission's estimated Claude spend in the chosen range. */
export interface LlmSubmissionSpend {
  submissionId: string;
  applicantName: string | null;
  calls: number;
  costUsd: number;
}
export type LlmUsageRange = 'today' | '24h' | '7d' | '30d' | 'all';
export type LlmUsageSort = 'at' | 'task' | 'submission' | 'model' | 'input' | 'output' | 'duration' | 'status';
export interface LlmUsage {
  range: LlmUsageRange;
  summary: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheSavingsUsd: number;
    /** Estimated USD spend in the range; null when nothing in it has a known price. */
    costUsd: number | null;
    byTask: LlmTaskUsage[];
    byModel: LlmModelUsage[];
  };
  /** Estimated USD spend over fixed rolling periods, whatever the range; null when nothing in it has a known price. */
  spend: { '24h': number | null; '7d': number | null; '30d': number | null };
  /** The submissions that cost the most in the range, most expensive first. */
  topSubmissions: LlmSubmissionSpend[];
  requests: Paged<LlmCall>;
}

export interface EvalScores {
  classificationAccuracy: number;
  fieldRecall: number;
  evidenceRate: number;
}
export interface EvalRecord {
  scores: EvalScores;
  skillVersion: string | null;
  model: string | null;
  ranAt: string | null;
}
/** The recorded eval scores of a skill the eval set covers (backend/evals): never run by the server itself. */
export interface SkillEvalStatus {
  baseline: EvalRecord | null;
  latest: EvalRecord | null;
  baselineCurrent: boolean;
}
export interface SkillInfo {
  name: string;
  version: string;
  files: string[];
  overridden: string[];
  eval?: SkillEvalStatus | null;
}
/** One skill file: the active text (a Settings edit, else disk) and the disk default it overrides. */
export interface SkillFile {
  skill: string;
  path: string;
  content: string;
  defaultContent: string;
  overridden: boolean;
  hash: string;
  skillVersion: string;
}
export interface SkillRevision {
  id: string;
  reset: boolean;
  content: string | null;
  hash: string;
  skillVersion: string;
  note: string;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

export interface NpiLookupResponse {
  found: boolean;
  result: unknown;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ---- Coverage summary (derived server-side from extracted fields) ----
export interface CoverageValue {
  value: string;
  confidence: number;
  sourceLabel: string;
  evidenceQuote: string | null;
  conflicts: string[];
}
export interface WorksheetStep {
  label: string;
  input: string | null;
  factor: number | null;
  amount: number | null;
  note: string | null;
}
export interface CoverageSummary {
  values: Record<string, CoverageValue | null>;
  lists: Record<string, CoverageValue[]>;
  derived: {
    claimsMadeYear: number | null;
    claimsMadeStep: string | null;
    policyTermDays: number | null;
    limits: { perClaim: number | null; aggregate: number | null };
    retroLimits: { perClaim: number | null; aggregate: number | null };
    deductibleAmount: number | null;
  };
  worksheet: {
    steps: WorksheetStep[];
    ratedPremium: number | null;
    fees: { label: string; amount: number }[];
    totalPremium: number | null;
    missing: string[];
  };
}

export interface ServiceStatus {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}
export interface SystemStatus {
  checkedAt: string;
  services: ServiceStatus[];
}

export type AutomationMode = 'AUTO' | 'MANUAL';
export type AutomationStep =
  | 'classification'
  | 'fieldExtraction'
  | 'npiVerification'
  | 'synthesis'
  | 'analysis'
  | 'autoQuote';
export type AutomationSettings = Record<AutomationStep, AutomationMode>;

/** Settings → Limits: admin-editable token caps, upload sizes, timeouts and text limits (all whole numbers). */
export type LimitsKey =
  | 'synthesisMaxTokens'
  | 'analysisMaxTokens'
  | 'comparisonMaxTokens'
  | 'classificationMaxTokens'
  | 'extractionMaxTokens'
  | 'chatMaxTokens'
  | 'emailDraftMaxTokens'
  | 'autoQuoteMaxTokens'
  | 'uploadMaxFileMb'
  | 'uploadMaxFiles'
  | 'rateWorkbookMaxMb'
  | 'claudeResponseTimeoutMinutes'
  | 'npiTimeoutSeconds'
  | 'driveTimeoutSeconds'
  | 'gmailTimeoutSeconds'
  | 'connectionTestTimeoutSeconds'
  | 'ocrMaxPages'
  | 'reportPerDocChars'
  | 'extractionPerDocChars'
  | 'classificationBodyChars';
export interface LimitsSettings {
  values: Record<LimitsKey, number>;
  defaults: Record<LimitsKey, number>;
  bounds: Record<LimitsKey, { min: number; max: number }>;
  /** Limits that are not settings (Gmail's own), sent so the browser checks against the server's value. */
  fixed: { outboundAttachmentMaxBytes: number };
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Settings → Data retention: days each kind of data is kept; null keeps it forever (the default). */
export type RetentionKey =
  | 'llmTranscriptsDays'
  | 'llmCallsDays'
  | 'chatDays'
  | 'deletedSubmissionsDays'
  | 'skippedEmailsDays';
export interface RetentionSettings {
  values: Record<RetentionKey, number | null>;
  bounds: { min: number; max: number };
  updatedAt: string | null;
  updatedBy: string | null;
}

/** What one Claude call sent and received. prompt/output are null when only their hashes were kept. */
export interface LlmTranscript {
  callId: string;
  task: string;
  model: string;
  createdAt: string;
  systemSha256: string;
  promptSha256: string;
  prompt: string | null;
  output: string | null;
}

export type ConnectionKey = 'database' | 'llm' | 'gmail' | 'drive' | 'npi' | 'ims2Queue';
export interface ConnectionInfo {
  key: ConnectionKey;
  label: string;
  configured: boolean;
}
export interface ConnectionTest extends ServiceStatus {
  key: ConnectionKey;
  configured: boolean;
  latencyMs: number;
  testedAt: string;
}

// ---- Rating & quotes (backend services/rating) ----
export type SurgeryType = 'No Surgery' | 'Minor Surgery' | 'Major Surgery';
export const SURGERY_TYPES: SurgeryType[] = ['No Surgery', 'Minor Surgery', 'Major Surgery'];

export interface RatingSpeciality {
  code?: string;
  title?: string;
  practicePercent?: number;
  surgeryType?: SurgeryType;
  /** For a specialty no rate class matches exactly: the underwriter's factor and why (required together). */
  manualFactor?: number;
  manualReason?: string;
}

export interface RatingInputs {
  label?: string;
  state?: string;
  city?: string;
  zip?: string;
  county?: string;
  specialities?: RatingSpeciality[];
  pickHighest?: boolean;
  limit?: { incident: number; aggregate?: number };
  limitKey?: string;
  effectiveDate?: string;
  expirationDate?: string;
  retroDate?: string;
  hoursPerWeek?: number;
  hoursWorkedKey?: string;
  scheduledCreditKeys?: string[];
  uwCreditPercent?: number;
  optionalFeeKeys?: string[];
  feeAmounts?: Record<string, number>;
}

export interface RatingInputsResponse {
  inputs: RatingInputs;
  sources: Record<string, string>;
}
/** GET /quotes/:quoteId/inputs: prefill for editing a saved quote, with the rate group a save prices with. */
export interface QuoteEditInputs extends RatingInputsResponse {
  rateGroup: string;
}

export interface RateLimit {
  key: string;
  incidentLimit: number;
  aggregateLimit: number;
  factor: number;
  isDefault: boolean;
  state: string;
}
export interface RateOptions {
  rateGroup: string;
  states: string[];
  surgeryTypes: SurgeryType[];
  hours: { key: string; title: string; factor: number; isDefault: boolean }[];
  scheduledCredits: { key: string; title: string; percent: number; type: string; deductibleLabel: string }[];
  policyFees: { key: string; title: string; amount: number; required: boolean }[];
  state?: { state: string; baseRate: number; defense: string } | null;
  limits?: RateLimit[];
  territories?: { territory: number; factor: number; counties: string[]; isRemainder: boolean }[];
  ratingFees?: {
    key: string;
    title: string;
    calculate: boolean;
    allowEdit: boolean;
    amountOrPercent: number;
    required: boolean;
  }[];
  specialities?: { code: string; title: string; surgeryTypes: string[] }[];
  /** Allowed range of a manual specialty factor (the server enforces it). */
  manualFactor?: { min: number; max: number };
}

export interface RateGroup {
  name: string;
  isActive: boolean;
  importedAt: string;
}
export type RateWorkbookKey =
  | 'State_Lookup'
  | 'Territory_Lookup'
  | 'ILFDLF_Factor_Datatable_Lookup'
  | 'Speciality_Lookup'
  | 'Hours_Worked_Factor_Lookup'
  | 'Scheduled_Credit_Debit_Lookup'
  | 'Rating_Fees_Lookup'
  | 'Policy_Fees_Lookup'
  | 'Endorsement_Lookup'
  | 'Endorsement_Content_Lookup'
  | 'Policy_Enhancements_Lookup'
  | 'Rating_Deductible_Lookup'
  | 'RequiredItem_Lookup';
/** One rate workbook and the rows it holds in the active rate group; `pricing: false` is a reference lookup quotes don't read. */
export interface RateWorkbookInfo {
  workbook: RateWorkbookKey;
  label: string;
  pricing: boolean;
  rows: Record<string, number>;
}
export interface RateGroups {
  groups: RateGroup[];
  geo: { zips: number; zipCounties: number };
  workbooks: RateWorkbookInfo[];
}
export interface RateWorkbookImportResult {
  rateGroup: string;
  basedOn: string | null;
  workbook: RateWorkbookKey;
  file: string;
  rowCounts: Record<string, number>;
}
export interface GeoImportResult {
  zips: number;
  zipCounties: number;
  multiCountyZips: number;
}

export interface QuoteFactors {
  location?: {
    zip: string | null;
    city: string | null;
    state: string | null;
    county: string | null;
    countySource: string | null;
    zipCounties?: { name: string; share?: number }[];
  };
  state?: { state: string; baseRate: number; domicileTaxRate: number; stateTaxRate: number; defense: string };
  dates?: { effectiveDate: string; expirationDate: string; retroDate: string; retroYears: number; stepUpYear?: number };
  stepUp?: number;
  // code MANUAL (with `manual`) for a specialty rated with an underwriter's factor.
  specialities?: {
    requested: string;
    code: string;
    title: string;
    surgeryType: SurgeryType | 'Not stated';
    specialityClass: number;
    practicePercent: number;
    factorState: string;
    matchedFrom: string;
    manual?: { reason: string };
  }[];
  speciality?: number;
  territory?: { territory: number; factor: number; county: string | null; matched: 'county' | 'remainder' };
  limits?: { key: string; incidentLimit: number; aggregateLimit: number; factor: number };
  fte?: { key: string; title: string; factor: number };
  scheduledCredits?: { key: string; title: string; percent: number; type: string; deductibleLabel: string }[];
  ratingFees?: { key: string; title: string; calculate: boolean; amount: number; required: boolean }[];
  policyFees?: { key: string; title: string; amount: number }[];
}

export interface QuotePricing {
  baseModifierTotal: number;
  scheduledPremium: number;
  scheduled: { title: string; percent: number | null; amount: number }[];
  uwCredit: { percent: number; amount: number };
  premium: number;
  ratingFees: { title: string; amount: number }[];
  taxes: { label: string; rate: number; amount: number }[];
  policyFeesTotal: number;
  total: number;
  combineTotal: number;
}

export type QuoteStatus = 'QUOTED' | 'INCOMPLETE';

/** POST /quotes/preview: priced, not saved. */
export interface QuotePreview {
  status: QuoteStatus;
  rateGroup: string;
  inputs: RatingInputs;
  sources: Record<string, string>;
  factors: QuoteFactors;
  pricing: QuotePricing | null;
  summary: {
    premium: number;
    ratingFees: number;
    taxes: number;
    policyFees: number;
    total: number;
    combineTotal: number;
  } | null;
  flags: string[];
  missing: string[];
}

export interface Quote {
  id: string;
  version: number;
  label: string | null;
  status: QuoteStatus;
  rateGroup: string;
  contextVersion: number;
  /** The submission's primary rating (submissions.primary_rating_id). */
  isPrimary: boolean;
  inputs: RatingInputs;
  factors: QuoteFactors;
  pricing: QuotePricing | null;
  premium: number | null;
  total: number | null;
  flags: string[];
  missing: string[];
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  /** Generated automatically (createdBy null) and not yet acknowledged by a person. */
  needsReview?: boolean;
  reviewedAt?: string | null;
  /** The reviewer's name. */
  reviewedBy?: string | null;
}

export interface SpecialityOption {
  rank: number;
  code: string;
  title: string;
  description: string | null;
  surgeryType: SurgeryType;
  specialityClass: number;
  factorState: string;
  score: number;
  matchedFrom: string;
  recommended: boolean;
  lowestPremium: boolean;
  weak: boolean;
  quote: { status: QuoteStatus; premium: number | null; total: number | null; missing: string[] };
}
export interface SpecialityOptions {
  state: string | null;
  requested: string | null;
  index: number;
  rateGroup: string;
  options: SpecialityOption[];
  note?: string;
}

// ---- IMS 2 Submission Intake queue (backend modules/ims2) ----

export type Ims2FieldSource = 'extracted' | 'edited' | 'manual';
/** State of a submission the removed direct hand-off sent (ims2_handoffs, kept for its history). */
export type Ims2HandoffState = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'FAILED';
export interface Ims2NewInsured {
  insuredType: 'person' | 'entity';
  canonicalName: string;
  firstname: string | null;
  lastname: string | null;
  companyname: string | null;
  npi: string | null;
  email: string | null;
}
export interface Ims2Policy {
  effectiveDate: string | null;
  expiredDate: string | null;
  businessType: 'new' | 'renewal' | null;
  recordType: 'POL' | 'POL-TL' | 'POL-SL' | null;
  premium: number | null;
  state: string | null;
  city: string | null;
  specialty: string | null;
  dateReceived: string | null;
}
export interface Ims2LookupQuery {
  npi?: string | null;
  email?: string | null;
  licenseNumber?: string | null;
  name?: string | null;
  brokerCode?: string | null;
  brokerName?: string | null;
}

export type Ims2QueueState = 'SENDING' | 'QUEUED' | 'LINKED' | 'REJECTED' | 'ERROR' | 'FAILED';
export interface Ims2QueueNewInsured extends Ims2NewInsured {
  licenseNumber: string | null;
}
export type Ims2QueueInsuredChoice =
  | { mode: 'link'; insuredId: string }
  | { mode: 'create'; create: Ims2QueueNewInsured };
export interface Ims2QueueLocation {
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
}
export interface Ims2QueueContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}
export interface Ims2QueuePolicy extends Ims2Policy {
  agent: string | null;
  underwriter: string | null;
}
export interface Ims2QueueForm {
  broker: { brokerId: number | null; brokerName: string };
  insured: Ims2QueueInsuredChoice;
  location: Ims2QueueLocation | null;
  contact: Ims2QueueContact | null;
  policy: Ims2QueuePolicy;
}
export interface Ims2QueueDefaults {
  form: Ims2QueueForm & { insured: Extract<Ims2QueueInsuredChoice, { mode: 'create' }> };
  sources: Partial<Record<keyof Ims2Policy, { source: Ims2FieldSource; from: string }>>;
  lookup: Ims2LookupQuery;
  brokerNames: string[];
  ratingIndication: Record<string, unknown> | null;
  setupProposal: Record<string, unknown> | null;
  receivedAt: string | null;
}
export interface Ims2QueueInsuredHit {
  insuredId: string;
  canonicalName: string;
  insuredType: string | null;
  npi: string | null;
  email: string | null;
  licenseNumber: string | null;
  status: string | null;
  matchedOn: string[];
}
export interface Ims2QueueBrokerHit {
  id: number;
  brokerCode: string | null;
  brokerName: string;
  shortName: string | null;
  active: boolean;
  matchedOn: string[];
}
export interface Ims2QueueLookup {
  query: Ims2LookupQuery;
  insureds: Ims2QueueInsuredHit[];
  brokers: Ims2QueueBrokerHit[];
}
export interface Ims2IntakeStatus {
  intakeId?: string;
  version?: number;
  status?: 'new' | 'linked' | 'rejected';
  statusChangedAt?: string;
  submissionId?: number | null;
  submissionNumber?: string | null;
  url?: string | null;
  workflowStatus?: string | null;
  policyNumber?: string | null;
  insuredId?: string | null;
  rejectedReason?: string | null;
  notFound?: boolean;
  error?: string;
}
export interface Ims2QueueRow {
  intakeId: string;
  version: number;
  state: Ims2QueueState;
  lastHttpStatus: number | null;
  lastError: string | null;
  lastErrorField: string | null;
  imsSubmissionId: number | null;
  imsSubmissionNumber: string | null;
  imsInsuredId: string | null;
  imsUrl: string | null;
  remoteStatus: Ims2IntakeStatus | null;
  remoteStatusChangedAt: string | null;
  remoteCheckedAt: string | null;
  rejectedReason: string | null;
  sent: unknown;
  form: (Ims2QueueForm & { insured: Ims2QueueInsuredChoice }) | null;
  sentBy: { id: string; name: string };
  sentAt: string;
}
export interface Ims2QueueInfo {
  configured: boolean;
  latestDecision: Decision | null;
  canSend: boolean;
  row: Ims2QueueRow | null;
  legacyHandoff: { state: Ims2HandoffState; imsUrl: string | null; imsSubmissionNumber: string | null } | null;
  defaults: Ims2QueueDefaults | null;
}
export interface Ims2QueueSyncResult {
  at: string;
  by: string | null;
  pages: number;
  seen: number;
  updated: number;
  linked: number;
  rejected: number;
  error?: string;
}
export interface Ims2QueueSyncInfo {
  configured: boolean;
  counts: Partial<Record<Ims2QueueState, number>>;
  lastSync: Ims2QueueSyncResult | null;
  lastStatusChangedAt: string | null;
  running: boolean;
}
