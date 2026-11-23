import type { z } from 'zod';

import { env } from '../config/env';
import { FAILURE_MESSAGES, QUERY_DEFAULTS, REVOKE_OBJECT_URL_DELAY_MS } from '../constants';
import { friendlyMessage } from '../lib/friendlyError';
import { usDates, usDatesDeep } from '../lib/status';
import type {
  AnthropicSettings,
  AnthropicTestResult,
  Assessment,
  AuditEvent,
  AuthResponse,
  AutomationSettings,
  BootstrapResponse,
  ChatMessage,
  Classification,
  Comparison,
  ComparisonSummary,
  ConnectionInfo,
  ConnectionKey,
  ConnectionTest,
  Decision,
  DuplicateStrength,
  EmailAudience,
  EmailDrafts,
  EmailDraftState,
  FailedGmailMessage,
  GeoImportResult,
  GmailImportResult,
  GmailImportScope,
  GmailImportSettings,
  GmailStatus,
  Ims2LookupQuery,
  Ims2QueueForm,
  Ims2QueueInfo,
  Ims2QueueLookup,
  Ims2QueueRow,
  Ims2QueueSettings,
  Ims2QueueSyncInfo,
  Ims2QueueSyncResult,
  Ims2QueueTestResult,
  InboxView,
  LimitsKey,
  LimitsSettings,
  LlmTranscript,
  LlmUsage,
  LlmUsageRange,
  LlmUsageSort,
  MonitoringStats,
  NpiLookupResponse,
  NpiVerification,
  OutboundEmail,
  OutboundMode,
  Paged,
  Quote,
  QuoteEditInputs,
  QuotePreview,
  RateGroups,
  RateOptions,
  RateWorkbookImportResult,
  RateWorkbookKey,
  RatingInputs,
  RatingInputsResponse,
  Report,
  ReportKind,
  ReportSummary,
  RetentionKey,
  RetentionSettings,
  RiskRating,
  SkillFile,
  SkillInfo,
  SkillRevision,
  SkippedEmail,
  SpecialityOptions,
  SubmissionDetail,
  SubmissionPage,
  SubmissionStatus,
  SystemStatus,
  User,
  VersionsResponse,
} from '../types';
import { responseSchemas } from './schemas';

// Claude-written text (reports, comparisons, email drafts, chat) shows dates US style; metadata such as createdAt stays ISO.
const withUsDates = <T extends { content: unknown; markdown: string | null }>(r: T): T => ({
  ...r,
  content: usDatesDeep(r.content),
  markdown: r.markdown && usDates(r.markdown),
});
const draftUsDates = (d: EmailDrafts): EmailDrafts => ({ ...d, draft: usDatesDeep(d.draft) });
const draftStateUsDates = (s: EmailDraftState): EmailDraftState => ({ ...s, draft: s.draft && draftUsDates(s.draft) });
const chatUsDates = (m: ChatMessage): ChatMessage =>
  m.role === 'assistant' ? { ...m, content: usDates(m.content) } : m;

/** The browser's time zone, so "Today" on Monitoring starts at the viewer's midnight. */
const viewerTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

export const API_BASE: string = env.apiBase;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Turn a non-2xx response body into an ApiError. Accepts the contract shape
 * `{ error: { code, message, details? } }` and falls back gracefully for anything else
 * (proxy HTML error pages, empty bodies, plain strings).
 */
export function parseApiError(status: number, body: unknown, statusText = ''): ApiError {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error;
    if (err && typeof err === 'object') {
      const e = err as { code?: unknown; message?: unknown; details?: unknown };
      return new ApiError(
        status,
        typeof e.code === 'string' ? e.code : `HTTP_${status}`,
        typeof e.message === 'string' && e.message ? e.message : defaultMessage(status, statusText),
        e.details,
      );
    }
    if (typeof err === 'string') return new ApiError(status, `HTTP_${status}`, err);
  }
  if (typeof body === 'string' && body.trim() && body.length < 300 && !body.trim().startsWith('<')) {
    return new ApiError(status, `HTTP_${status}`, body.trim());
  }
  return new ApiError(status, `HTTP_${status}`, defaultMessage(status, statusText));
}

// Same style as the Errors tab: what happened, then what to do (lib/friendlyError.ts).
function defaultMessage(status: number, statusText: string): string {
  const code = `${status}${statusText ? ` ${statusText}` : ''}`;
  if (status === 0) return FAILURE_MESSAGES.unreachable;
  if (status === 401) return FAILURE_MESSAGES.sessionExpired;
  if (status === 403) return FAILURE_MESSAGES.forbidden;
  if (status === 404) return FAILURE_MESSAGES.notFound;
  if (status >= 500) return FAILURE_MESSAGES.serverProblem(code);
  return FAILURE_MESSAGES.requestFailed(code);
}

/** Plain words for any error shown to a person. API messages are already written for people; browser errors are not. */
export function errorMessage(err: unknown): string {
  // A 4xx message is our server's own sentence; a 5xx may carry an upstream's raw text.
  if (err instanceof ApiError) return err.status >= 500 ? friendlyMessage(err.message) : err.message;
  if (err instanceof Error)
    return friendlyMessage(err.message, { technical: err instanceof TypeError || err instanceof SyntaxError });
  return friendlyMessage(null);
}

// ---- session + unauthorized handling ----
//
// The session lives in an httpOnly cookie set by the API; the app never sees or stores the token. Every request
// sends `X-Requested-With: fetch`, which the API requires on cookie-authenticated unsafe requests (CSRF check).

/** Header the API requires (with this value) on cookie-authenticated POST/PUT/PATCH/DELETE. */
export const CSRF_HEADERS = { 'X-Requested-With': 'fetch' } as const;

// Older builds kept the token in localStorage; drop it so it does not linger.
const LEGACY_TOKEN_KEY = 'smp.token';
try {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
} catch {
  /* storage unavailable */
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

// ---- core request ----

type Query = Record<string, string | number | boolean | null | undefined>;

export function buildQuery(q?: Query): string {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Per-call options: the query's AbortSignal (cancelled on unmount or a newer key) and a schema for the response. */
export interface RequestOptions<T = unknown> {
  signal?: AbortSignal;
  schema?: z.ZodType<T>;
}

async function rawFetch(method: string, path: string, body?: unknown, callerSignal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...CSRF_HEADERS };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body instanceof Blob) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    // Reads give up after a while; uploads and Claude actions can legitimately run long, so they wait. A query's own
    // signal (TanStack Query cancels it on unmount or when the key changes) stops the request too.
    const timeout = method === 'GET' ? AbortSignal.timeout(QUERY_DEFAULTS.readTimeoutMs) : undefined;
    const signal = timeout && callerSignal ? AbortSignal.any([timeout, callerSignal]) : (timeout ?? callerSignal);
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload, credentials: 'include', signal });
  } catch (e) {
    // Cancelled by the caller: rethrown as is, so TanStack Query treats it as a cancellation, not an error.
    if (callerSignal?.aborted) throw callerSignal.reason ?? e;
    if (e instanceof DOMException && e.name === 'TimeoutError')
      throw new ApiError(0, 'TIMEOUT', FAILURE_MESSAGES.timedOut);
    throw parseApiError(0, null);
  }
  if (!res.ok) {
    let parsed: unknown = null;
    const text = await res.text().catch(() => '');
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const err = parseApiError(res.status, parsed, res.statusText);
    // A failed sign-in is not an expired session.
    if (res.status === 401 && !path.startsWith('/auth/login')) unauthorizedHandler?.();
    throw err;
  }
  return res;
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions<T> = {},
): Promise<T> {
  const res = await rawFetch(method, path, body, opts.signal);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!opts.schema) return data as T;
  const checked = opts.schema.safeParse(data);
  if (!checked.success)
    throw new ApiError(0, 'INVALID_RESPONSE', FAILURE_MESSAGES.invalidResponse, checked.error.issues);
  return checked.data;
}

/** POST /uploads: where a chunked upload goes and how to cut it. */
interface UploadSlot {
  uploadId: string;
  chunkBytes: number;
  chunkCount: number;
}

/**
 * Chunked upload mode (VITE_UPLOAD_MODE=chunked): declare the file, then send it in the server's chunk size, one chunk
 * at a time, each retried once. Resolves with the upload id a submission or document upload then names.
 */
export async function uploadFileInChunks(
  file: File,
  signal?: AbortSignal,
  onProgress?: (sentBytes: number) => void,
): Promise<string> {
  const slot = await request<UploadSlot>(
    'POST',
    '/uploads',
    { filename: file.name, mimeType: file.type || 'application/octet-stream', size: file.size },
    { signal },
  );
  let sent = 0;
  for (let i = 0; i < slot.chunkCount; i++) {
    const chunk = file.slice(i * slot.chunkBytes, Math.min(file.size, (i + 1) * slot.chunkBytes));
    const put = () =>
      request<void>('PUT', `/uploads/${encodeURIComponent(slot.uploadId)}/chunks/${i}`, chunk, { signal });
    try {
      await put();
    } catch (err) {
      if (signal?.aborted) throw err;
      await put();
    }
    sent += chunk.size;
    onProgress?.(sent);
  }
  return slot.uploadId;
}

/** Every file through uploadFileInChunks, in order; their upload ids. */
async function uploadAllInChunks(files: File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files) ids.push(await uploadFileInChunks(f));
  return ids;
}

/** `{ items }` list responses, unwrapped for screens that show the whole list. */
const items = <T>(r: { items: T[] }): T[] => r.items;

/** How often, and for how long, a background action (202 from the API) is checked until it finishes. */
export const BACKGROUND_POLL = { intervalMs: 1500, timeoutMs: 10 * 60_000 } as const;

/**
 * Long admin actions answer 202 and run in the background on the server; their status endpoint says when they end.
 * Polls `check` until it returns a value (done) or throws (failed). On timeout the work is still running there.
 */
export async function waitForBackground<T>(
  check: () => Promise<T | undefined>,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const { intervalMs = BACKGROUND_POLL.intervalMs, timeoutMs = BACKGROUND_POLL.timeoutMs } = opts;
  const end = Date.now() + timeoutMs;
  for (;;) {
    const done = await check();
    if (done !== undefined) return done;
    if (Date.now() > end)
      throw new ApiError(0, 'STILL_RUNNING', 'Still running on the server; check again in a few minutes.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** GET /skipped-emails/:id/process. */
type SkippedProcessStatus =
  | { state: 'running' | 'idle' }
  | { state: 'done'; submissionId: string }
  | { state: 'failed'; error: { code: string; status: number; message: string } };
/** GET /geo/import. */
interface GeoImportStatus {
  running: boolean;
  last: { at: string; by: string | null; result: GeoImportResult | null; error: string | null } | null;
}

/** Authenticated download through fetch, so errors surface as ApiError instead of a broken page. */
export async function downloadDocument(id: string, filename: string): Promise<void> {
  const res = await rawFetch('GET', `/documents/${encodeURIComponent(id)}/download`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_OBJECT_URL_DELAY_MS);
}

/** Exports one rate workbook of the active rate group as .xlsx, named the way the server names it. */
export async function downloadRateWorkbook(workbook: RateWorkbookKey): Promise<void> {
  const res = await rawFetch('GET', `/rates/export/${encodeURIComponent(workbook)}`);
  const named = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1];
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = named ? decodeURIComponent(named) : `${workbook}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_OBJECT_URL_DELAY_MS);
}

/** Authenticated inline fetch for the document viewer. Rejects with code PREVIEW_UNSUPPORTED for non-renderable types. */
export async function fetchDocumentForView(id: string): Promise<Blob> {
  const res = await rawFetch('GET', `/documents/${encodeURIComponent(id)}/view`);
  return res.blob();
}

// ---- typed endpoints ----

/** A user as admins see it on the Users screen. */
export interface ManagedUser extends User {
  disabledAt: string | null;
  passwordChangedAt: string | null;
  isDefaultAdmin: boolean;
}

export interface SubmissionListParams {
  view?: InboxView;
  status?: SubmissionStatus | '';
  classification?: Classification | '';
  strength?: DuplicateStrength | '';
  q?: string;
  page?: number;
  pageSize?: number;
}

/** The typed endpoints. `signal` (from a query function) cancels the reads; mutations ignore it. */
function makeApi(signal?: AbortSignal) {
  const get = <T>(path: string, schema?: z.ZodType<T>) => request<T>('GET', path, undefined, { signal, schema });
  return {
    // auth
    bootstrap: () => get<BootstrapResponse>('/auth/bootstrap'),
    login: (email: string, password: string) => request<AuthResponse>('POST', '/auth/login', { email, password }),
    register: (body: { email: string; password: string; name: string; role?: User['role']; setupToken?: string }) =>
      request<AuthResponse>('POST', '/auth/register', body),
    me: () => get<User>('/auth/me', responseSchemas.user),
    logout: () => request<void>('POST', '/auth/logout'),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<AuthResponse>('POST', '/auth/password', { currentPassword, newPassword }),
    /** Admins get every account (ManagedUser); everyone else only id, name and role (email is absent). */
    users: () => get<User[]>('/users', responseSchemas.users),
    managedUsers: () => get<ManagedUser[]>('/users', responseSchemas.managedUsers),
    updateUser: (id: string, body: { role?: User['role']; disabled?: boolean }) =>
      request<ManagedUser>('PATCH', `/users/${encodeURIComponent(id)}`, body),
    resetUserPassword: (id: string, password: string) =>
      request<ManagedUser>('POST', `/users/${encodeURIComponent(id)}/password`, { password }),

    // submissions
    listSubmissions: (p: SubmissionListParams) =>
      get<SubmissionPage>(`/submissions${buildQuery({ ...p })}`, responseSchemas.submissionPage),
    getSubmission: (id: string) =>
      get<SubmissionDetail>(`/submissions/${encodeURIComponent(id)}`, responseSchemas.submissionDetail),
    unreadCount: () => get<{ unread: number }>('/submissions/unread-count'),
    markRead: (id: string) => request<{ unread: number }>('POST', `/submissions/${encodeURIComponent(id)}/read`),
    markUnread: (id: string) => request<{ unread: number }>('DELETE', `/submissions/${encodeURIComponent(id)}/read`),
    markAllRead: (
      view: InboxView,
      filters: { q?: string; status?: string; classification?: string; strength?: string },
    ) =>
      request<{ marked: number; unread: number }>('POST', `/submissions/${encodeURIComponent(view)}/read-all`, filters),
    updateSubmission: (id: string, body: { status?: SubmissionStatus; assignedToId?: string | null }) =>
      request<SubmissionDetail>('PATCH', `/submissions/${encodeURIComponent(id)}`, body),
    uploadSubmission: async (fields: { subject: string; fromAddress: string; bodyText: string; files: File[] }) => {
      if (env.uploadMode === 'chunked') {
        const { files, ...rest } = fields;
        return request<SubmissionDetail>('POST', '/submissions/upload', {
          ...rest,
          uploadIds: await uploadAllInChunks(files),
        });
      }
      const fd = new FormData();
      fd.append('subject', fields.subject);
      fd.append('fromAddress', fields.fromAddress);
      fd.append('bodyText', fields.bodyText);
      fields.files.forEach((f) => fd.append('files', f, f.name));
      return request<SubmissionDetail>('POST', '/submissions/upload', fd);
    },
    overrideClassification: (id: string, classification: Classification, reason: string) =>
      request<SubmissionDetail>('POST', `/submissions/${encodeURIComponent(id)}/classification`, {
        classification,
        reason,
      }),
    reprocess: (id: string) => request<{ ok: true }>('POST', `/submissions/${encodeURIComponent(id)}/reprocess`),
    /** Continue a failed run from its failed step (finished steps are skipped, only unread / failed documents are read). */
    retrySubmission: (id: string) => request<{ ok: true }>('POST', `/submissions/${encodeURIComponent(id)}/retry`),
    /** Errors tab: retry every failed submission from its failed step; list and retry Gmail messages that failed to import. */
    retryAllErrors: () => request<{ queued: number }>('POST', '/submissions/errors/retry-all'),
    processImported: (id: string) => request<{ ok: true }>('POST', `/submissions/${encodeURIComponent(id)}/process`),
    processAllImported: () => request<{ queued: number }>('POST', '/submissions/imported/process-all'),
    failedGmailMessages: () => get<{ items: FailedGmailMessage[] }>('/ingest-queue/failed'),
    skippedEmails: (p: { q?: string; page?: number; pageSize?: number }) => {
      const qs = new URLSearchParams();
      if (p.q) qs.set('q', p.q);
      if (p.page) qs.set('page', String(p.page));
      if (p.pageSize) qs.set('pageSize', String(p.pageSize));
      return get<{ items: SkippedEmail[]; total: number }>(`/skipped-emails?${qs}`);
    },
    /** Starts "Process as submission" (202) and resolves with the new submission once the server has stored it. */
    processSkippedEmail: async (gmailMessageId: string): Promise<{ submissionId: string }> => {
      const path = `/skipped-emails/${encodeURIComponent(gmailMessageId)}/process`;
      await request<{ started: boolean }>('POST', path);
      return waitForBackground(async () => {
        const s = await request<SkippedProcessStatus>('GET', path);
        if (s.state === 'done') return { submissionId: s.submissionId };
        if (s.state === 'failed') throw new ApiError(s.error.status, s.error.code, s.error.message);
        return undefined;
      });
    },
    deleteSkippedEmail: (gmailMessageId: string) =>
      request<{ deleted: number }>('DELETE', `/skipped-emails/${encodeURIComponent(gmailMessageId)}`),
    /** The selected `ids`, otherwise every skipped email matching `q`. */
    deleteSkippedEmails: (sel: { ids?: string[]; q?: string }) =>
      request<{ deleted: number }>('POST', '/skipped-emails/delete', sel),
    retryGmailMessage: (id: string) => request<{ ok: true }>('POST', `/ingest-queue/${encodeURIComponent(id)}/retry`),
    /** Admin: delete (hide) one inbox row; the selected rows of a tab; or every row of a tab matching its search and filters. */
    deleteSubmission: (id: string) => request<{ deleted: number }>('DELETE', `/submissions/${encodeURIComponent(id)}`),
    deleteSelected: (view: InboxView, ids: string[]) =>
      request<{ deleted: number }>('POST', `/submissions/${encodeURIComponent(view)}/delete`, { ids }),
    deleteMatching: (
      view: InboxView,
      filters: { q?: string; status?: string; classification?: string; strength?: string },
    ) => request<{ deleted: number }>('POST', `/submissions/${encodeURIComponent(view)}/delete`, filters),
    /** Mark as a duplicate of another submission, or pass null to release it for processing ("not a duplicate"). */
    setDuplicate: (id: string, duplicateOfId: string | null, reason: string) =>
      request<SubmissionDetail>('POST', `/submissions/${encodeURIComponent(id)}/duplicate`, { duplicateOfId, reason }),

    // NPI
    verifyNpi: (id: string, body: { npi?: string; claimedName?: string; claimedState?: string }) =>
      request<NpiVerification[]>('POST', `/submissions/${encodeURIComponent(id)}/npi/verify`, body),
    npiLookup: (npi: string) => get<NpiLookupResponse>(`/npi/lookup/${encodeURIComponent(npi)}`),
    addManualNpi: (
      id: string,
      body: { npi: string; claimedName?: string; claimedState?: string; claimedSpecialty?: string; note?: string },
    ) => request<NpiVerification[]>('POST', `/submissions/${encodeURIComponent(id)}/npi/manual`, body),
    removeNpi: (id: string, verificationId: string) =>
      request<NpiVerification[]>(
        'DELETE',
        `/submissions/${encodeURIComponent(id)}/npi/${encodeURIComponent(verificationId)}`,
      ),
    overrideNpi: (id: string, verificationId: string, body: { status: 'MATCH' | 'MISMATCH'; note: string }) =>
      request<NpiVerification[]>(
        'PUT',
        `/submissions/${encodeURIComponent(id)}/npi/${encodeURIComponent(verificationId)}/override`,
        body,
      ),
    undoNpiOverride: (id: string, verificationId: string) =>
      request<NpiVerification[]>(
        'DELETE',
        `/submissions/${encodeURIComponent(id)}/npi/${encodeURIComponent(verificationId)}/override`,
      ),

    // manual fields (each returns the updated submission)
    addFields: (
      id: string,
      fields: { fieldName: string; value: string; note?: string | null; documentId?: string | null }[],
    ) => request<SubmissionDetail>('POST', `/submissions/${encodeURIComponent(id)}/fields`, { fields }),
    updateField: (
      id: string,
      fieldId: string,
      body: { value?: string; note?: string | null; documentId?: string | null },
    ) =>
      request<SubmissionDetail>(
        'PATCH',
        `/submissions/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}`,
        body,
      ),
    deleteField: (id: string, fieldId: string) =>
      request<SubmissionDetail>(
        'DELETE',
        `/submissions/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}`,
      ),

    /** Add documents to an existing submission; text extraction runs in the background (status PENDING). */
    uploadDocuments: async (id: string, files: File[]) => {
      if (env.uploadMode === 'chunked') {
        return request<{ documentIds: string[]; submission: SubmissionDetail }>(
          'POST',
          `/submissions/${encodeURIComponent(id)}/documents`,
          { uploadIds: await uploadAllInChunks(files) },
        );
      }
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f, f.name));
      return request<{ documentIds: string[]; submission: SubmissionDetail }>(
        'POST',
        `/submissions/${encodeURIComponent(id)}/documents`,
        fd,
      );
    },

    // reply, reply all, forward
    outboundEmails: (id: string) =>
      get<{ items: OutboundEmail[] }>(`/submissions/${encodeURIComponent(id)}/outbound-emails`).then(items),
    sendEmail: (
      id: string,
      body: {
        mode: OutboundMode;
        to: string[];
        cc: string[];
        bcc: string[];
        subject: string;
        body: string;
        documentIds: string[];
        idempotencyKey?: string;
      },
    ) => request<OutboundEmail>('POST', `/submissions/${encodeURIComponent(id)}/outbound-emails`, body),

    // rating & quotes: quotes are created only from the quote dialog
    ratingInputs: (id: string) => get<RatingInputsResponse>(`/submissions/${encodeURIComponent(id)}/rating-inputs`),
    quotes: (id: string) => get<Quote[]>(`/submissions/${encodeURIComponent(id)}/quotes`),
    quoteEditInputs: (id: string, quoteId: string) =>
      get<QuoteEditInputs>(`/submissions/${encodeURIComponent(id)}/quotes/${encodeURIComponent(quoteId)}/inputs`),
    previewQuote: (id: string, inputs: RatingInputs) =>
      request<QuotePreview>('POST', `/submissions/${encodeURIComponent(id)}/quotes/preview`, { inputs }),
    /** `basedOn`: the saved quote being edited; the edit is saved as the next version and that quote is kept unchanged. */
    createQuote: (id: string, inputs: RatingInputs, basedOn?: string) =>
      request<Quote>('POST', `/submissions/${encodeURIComponent(id)}/quotes`, {
        inputs,
        ...(basedOn ? { basedOn } : {}),
      }),
    /** Saves the edit over that quote itself: same version, re-priced. */
    updateQuote: (id: string, quoteId: string, inputs: RatingInputs) =>
      request<Quote>('PUT', `/submissions/${encodeURIComponent(id)}/quotes/${encodeURIComponent(quoteId)}`, {
        inputs,
      }),
    setPrimaryRating: (id: string, ratingId: string) =>
      request<Quote[]>('PUT', `/submissions/${encodeURIComponent(id)}/primary-rating`, { ratingId }),
    /** Acknowledge a quote generated automatically; idempotent (the first reviewer is kept). */
    reviewQuote: (id: string, quoteId: string) =>
      request<Quote>('POST', `/submissions/${encodeURIComponent(id)}/quotes/${encodeURIComponent(quoteId)}/review`),
    specialityOptions: (id: string, inputs: RatingInputs, index: number, title?: string) =>
      request<SpecialityOptions>('POST', `/submissions/${encodeURIComponent(id)}/speciality-options`, {
        inputs,
        index,
        ...(title ? { title } : {}),
      }),
    rateOptions: (state?: string) => get<RateOptions>(`/rates/options${buildQuery({ state })}`),
    rateGroups: () => get<RateGroups>('/rates/groups'),
    /**
     * Always one multipart request, also in chunked upload mode: workbooks are small (RATE_WORKBOOK_MAX_BYTES on the
     * server, 20 MB), but on a host capping request bodies (Netlify: 6 MB) a larger one is refused there.
     */
    importRateWorkbook: ({ workbook, file }: { workbook: RateWorkbookKey; file: File }) => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      return request<RateWorkbookImportResult>('POST', `/rates/import/${workbook}`, fd);
    },
    /** Starts the ZIP data reload (202) and resolves with its result once the server finishes it. */
    importGeo: async (): Promise<GeoImportResult> => {
      const { since } = await request<{ started: boolean; since: string }>('POST', '/geo/import');
      return waitForBackground(async () => {
        const { last } = await request<GeoImportStatus>('GET', '/geo/import');
        if (!last || last.at < since) return undefined;
        if (last.error || !last.result)
          throw new ApiError(502, 'GEO_IMPORT_FAILED', last.error ?? 'ZIP data import failed');
        return last.result;
      });
    },

    // reports
    generateSynthesis: (id: string) =>
      request<ReportSummary>('POST', `/submissions/${encodeURIComponent(id)}/synthesis`),
    generateAnalysis: (id: string, synthesisReportId?: string) =>
      request<ReportSummary>(
        'POST',
        `/submissions/${encodeURIComponent(id)}/analysis`,
        synthesisReportId ? { synthesisReportId } : {},
      ),
    listReports: (id: string, kind?: ReportKind) =>
      get<{ items: ReportSummary[] }>(`/submissions/${encodeURIComponent(id)}/reports${buildQuery({ kind })}`).then(
        items,
      ),
    getReport: (reportId: string) =>
      get<Report>(`/reports/${encodeURIComponent(reportId)}`, responseSchemas.report).then(withUsDates),

    /** Acknowledge a report generated automatically; idempotent (the first reviewer is kept). */
    reviewReport: (id: string, reportId: string) =>
      request<Report>(
        'POST',
        `/submissions/${encodeURIComponent(id)}/reports/${encodeURIComponent(reportId)}/review`,
        undefined,
        { signal, schema: responseSchemas.report },
      ).then(withUsDates),

    // comparisons: two versions of the same report kind
    compareReports: (id: string, body: { kind: ReportKind; baseReportId: string; targetReportId: string }) =>
      request<ComparisonSummary>('POST', `/submissions/${encodeURIComponent(id)}/comparisons`, body),
    listComparisons: (id: string, kind?: ReportKind) =>
      get<{ items: ComparisonSummary[] }>(
        `/submissions/${encodeURIComponent(id)}/comparisons${buildQuery({ kind })}`,
      ).then(items),
    getComparison: (comparisonId: string) =>
      get<Comparison>(`/comparisons/${encodeURIComponent(comparisonId)}`, responseSchemas.comparison).then(withUsDates),

    // assessments
    listAssessments: (id: string) =>
      get<{ items: Assessment[] }>(`/submissions/${encodeURIComponent(id)}/assessments`).then(items),
    createAssessment: (
      id: string,
      body: { decision: Decision; riskRating: RiskRating; notes: string; analysisReportId?: string },
    ) => request<Assessment>('POST', `/submissions/${encodeURIComponent(id)}/assessments`, body),

    // IMS 2 intake queue: the reviewer sends the accepted submission; an IMS 2 user creates and links it
    ims2Queue: (id: string) => get<Ims2QueueInfo>(`/submissions/${encodeURIComponent(id)}/ims2-queue`),
    ims2QueueLookup: (id: string, q?: Ims2LookupQuery) =>
      get<Ims2QueueLookup>(
        `/submissions/${encodeURIComponent(id)}/ims2-queue/lookup${buildQuery(q as Record<string, string | null | undefined>)}`,
      ),
    ims2QueueSend: (id: string, form: Ims2QueueForm) =>
      request<Ims2QueueRow>('POST', `/submissions/${encodeURIComponent(id)}/ims2-queue/send`, form),
    /** The intake's last known state (read-only; any signed-in user). */
    ims2QueueStatus: (id: string) => get<Ims2QueueRow>(`/submissions/${encodeURIComponent(id)}/ims2-queue/status`),
    /** Asks IMS 2 for the intake's state now and stores it (submission:write). */
    ims2QueueRefreshStatus: (id: string) =>
      request<Ims2QueueRow>('POST', `/submissions/${encodeURIComponent(id)}/ims2-queue/status/refresh`),
    ims2QueueSyncInfo: () => get<Ims2QueueSyncInfo>('/ims2-queue/sync'),
    /** Starts a status sync (202) and resolves with its result once the server has stored it. */
    ims2QueueSync: async (): Promise<Ims2QueueSyncResult> => {
      const { since } = await request<{ started: true; since: string }>('POST', '/ims2-queue/sync');
      return waitForBackground(async () => {
        const { lastSync } = await request<Ims2QueueSyncInfo>('GET', '/ims2-queue/sync');
        return lastSync && lastSync.at >= since ? lastSync : undefined;
      });
    },

    // versions + audit
    versions: (id: string) => get<VersionsResponse>(`/submissions/${encodeURIComponent(id)}/versions`),
    submissionAudit: (id: string, p: { page?: number; pageSize?: number } = {}) =>
      get<Paged<AuditEvent>>(`/submissions/${encodeURIComponent(id)}/audit${buildQuery({ ...p })}`),
    audit: (p: { action?: string; submissionId?: string; page?: number; pageSize?: number }) =>
      get<Paged<AuditEvent>>(`/audit${buildQuery({ ...p })}`),

    // chat
    chat: (id: string) =>
      get<{ items: ChatMessage[] }>(`/submissions/${encodeURIComponent(id)}/chat`).then((r) =>
        r.items.map(chatUsDates),
      ),
    // 202: the question and its PENDING answer; poll chat() until the answer is no longer PENDING.
    sendChat: (id: string, message: string) =>
      request<ChatMessage[]>('POST', `/submissions/${encodeURIComponent(id)}/chat`, { message }).then((ms) =>
        ms.map(chatUsDates),
      ),
    // Generating costs a Claude call: only the Generate button calls draftEmail. It answers 202 with the run PENDING;
    // poll latestEmailDraft until the run is no longer PENDING.
    latestEmailDraft: (id: string, audience: EmailAudience) =>
      get<EmailDraftState>(
        `/submissions/${encodeURIComponent(id)}/email-drafts?audience=${audience}`,
        responseSchemas.emailDraftState,
      ).then(draftStateUsDates),
    saveEmailDraft: (id: string, draftId: string, edit: { subject: string; body: string }) =>
      request<EmailDrafts>(
        'PUT',
        `/submissions/${encodeURIComponent(id)}/email-drafts/${encodeURIComponent(draftId)}`,
        edit,
        { schema: responseSchemas.emailDrafts },
      ).then(draftUsDates),
    draftEmail: (id: string, audience: EmailAudience) =>
      request<EmailDraftState>(
        'POST',
        `/submissions/${encodeURIComponent(id)}/email-drafts`,
        { audience },
        { schema: responseSchemas.emailDraftState },
      ).then(draftStateUsDates),

    // gmail + monitoring
    gmailStatus: () => get<GmailStatus>('/gmail/status'),
    gmailAuthUrl: () => get<{ url: string }>('/gmail/auth-url'),
    /** Starts a poll in the background (202); new emails arrive through the notification stream. */
    gmailPoll: () => request<{ started: boolean }>('POST', '/gmail/poll'),
    gmailDisconnect: () => request<{ ok: true }>('POST', '/gmail/disconnect'),
    gmailImportSettings: () => get<GmailImportSettings>('/gmail/import-settings'),
    gmailImport: (scope: GmailImportScope) => request<GmailImportResult>('POST', '/gmail/import', scope),
    anthropicSettings: () => get<AnthropicSettings>('/settings/anthropic'),
    saveAnthropicSettings: (body: { model: string; apiKey?: string | null }) =>
      request<AnthropicSettings>('PUT', '/settings/anthropic', body),
    testAnthropicSettings: (body: { model?: string; apiKey?: string }) =>
      request<AnthropicTestResult>('POST', '/settings/anthropic/test', body),
    ims2QueueSettings: () => get<Ims2QueueSettings>('/settings/ims2-queue'),
    saveIms2QueueSettings: (body: { baseUrl: string | null; token?: string | null; imsUrl?: string | null }) =>
      request<Ims2QueueSettings>('PUT', '/settings/ims2-queue', body),
    testIms2QueueSettings: (body: { baseUrl?: string; token?: string }) =>
      request<Ims2QueueTestResult>('POST', '/settings/ims2-queue/test', body),
    gmailSetPollInterval: (seconds: number) =>
      request<{ pollIntervalSeconds: number }>('PUT', '/gmail/poll-interval', { seconds }),
    monitoringStats: (range: LlmUsageRange) =>
      get<MonitoringStats>(`/monitoring/stats${buildQuery({ range, tz: viewerTimeZone() })}`),
    retryIngestQueue: () => request<{ queued: number }>('POST', '/ingest-queue/retry-now'),
    clearMonitoringErrors: () => request<{ cleared: number }>('POST', '/monitoring/errors/clear'),
    llmUsage: (p: {
      range: LlmUsageRange;
      page: number;
      pageSize: number;
      sort: LlmUsageSort;
      order: 'asc' | 'desc';
    }) => get<LlmUsage>(`/monitoring/llm-usage${buildQuery({ ...p, tz: viewerTimeZone() })}`),
    /** Admins (monitoring:manage); every view is audited. */
    llmTranscript: (callId: string) =>
      get<LlmTranscript>(
        `/monitoring/llm-calls/${encodeURIComponent(callId)}/transcript`,
        responseSchemas.llmTranscript,
      ),
    skills: () => get<SkillInfo[]>('/skills'),
    skillFile: (name: string, path: string) =>
      get<SkillFile>(`/skills/${encodeURIComponent(name)}/files${buildQuery({ path })}`),
    skillRevisions: (name: string, path: string) =>
      get<SkillRevision[]>(`/skills/${encodeURIComponent(name)}/files/revisions${buildQuery({ path })}`),
    saveSkillFile: (name: string, body: { path: string; content: string; baseHash: string; note: string }) =>
      request<SkillFile>('PUT', `/skills/${encodeURIComponent(name)}/files`, body),
    resetSkillFile: (name: string, path: string, note = '') =>
      request<SkillFile>('POST', `/skills/${encodeURIComponent(name)}/files/reset`, { path, note }),
    health: () => get<{ ok: true }>('/health'),
    systemStatus: () => get<SystemStatus>('/system/status'),
    automationSettings: () => get<AutomationSettings>('/settings/automation'),
    saveAutomationSettings: (body: Partial<AutomationSettings>) =>
      request<AutomationSettings>('PUT', '/settings/automation', body),
    limitsSettings: () => get<LimitsSettings>('/settings/limits'),
    /** Only the changed keys; null resets a key to its default. */
    saveLimitsSettings: (patch: Partial<Record<LimitsKey, number | null>>) =>
      request<LimitsSettings>('PUT', '/settings/limits', patch),
    retentionSettings: () => get<RetentionSettings>('/settings/retention'),
    /** A number sets a period in days, null keeps that data forever. */
    saveRetentionSettings: (body: Partial<Record<RetentionKey, number | null>>) =>
      request<RetentionSettings>('PUT', '/settings/retention', body),
    connections: () => get<ConnectionInfo[]>('/settings/connections'),
    testConnection: (key: ConnectionKey) =>
      request<ConnectionTest>('POST', `/settings/connections/${encodeURIComponent(key)}/test`),
  };
}

export const api = makeApi();

/** The endpoints with a query's AbortSignal: `queryFn: ({ signal }) => apiWith(signal).getReport(id)`. */
export const apiWith = (signal?: AbortSignal) => makeApi(signal);
