---
name: api-integration
description: Use when the frontend calls the backend — the fetch-based apiClient, feature service functions, TanStack Query useQuery/useMutation/useInfiniteQuery hooks, QueryClient defaults, retries, AbortSignal cancellation, pagination, file uploads/downloads, polling long-running jobs, or Server-Sent Events (SSE) streams. Use it for any new endpoint call, even a one-off GET.
---

# API Integration (frontend)

All HTTP goes through one small `fetch` wrapper (`@/lib/api-client`), wrapped by typed per-feature
services, wrapped by TanStack Query hooks. There is deliberately no Axios: `fetch` + `AbortSignal` covers
everything this app needs, and one wrapper keeps credentials, CSRF, and error parsing consistent.

Related: `state-management` (keys, invalidation), `error-handling` (`AppError`), `authentication`
(session cookie, 401 handling), `node-api` (the backend contract).

## Backend contract this skill assumes

- Base path `/api` (from `env.apiBaseUrl`), JSON in and out, cookie session (`credentials: 'include'`).
- Unsafe methods (POST/PUT/PATCH/DELETE) send the CSRF header the backend requires (`X-Requested-With: fetch`).
- Errors are `{ error: { code, message, details?, requestId? } }` with a meaningful HTTP status.
- Lists are paginated `{ items, page, pageSize, total }` or cursor `{ items, nextCursor }`.

## Rules

- **Only `apiClient` calls `fetch`.** Components, hooks and effects never do: one choke point means one
  place for timeouts, auth, CSRF, and error normalisation.
- **One service function per endpoint** in `features/<f>/api/<f>.service.ts`. It is typed, returns parsed
  data (not a `Response`), and accepts `signal?: AbortSignal` for reads.
- **Validate responses at the boundary with Zod** for data the UI depends on structurally (reports,
  assessments, LLM-generated content). A schema mismatch should fail loudly at the service, not as
  `undefined` three components later.
- **Every read is a `useQuery`/`useInfiniteQuery`** with a key from the feature's key factory, and it
  forwards the query's `signal` so navigation cancels in-flight requests.
- **Every write is a `useMutation`** that invalidates or updates the affected keys on success.
- **Retries:** queries retry at most twice and only for `network`, `timeout`, or `server` errors (a 403
  won't fix itself). Mutations never auto-retry: the server may already have applied them.
- **Long-running server work (pipeline runs, report generation) is a job:** the POST returns `202` + a job
  or resource id; the UI then polls with `refetchInterval` (stop when terminal) or listens on SSE. Don't hold
  a request open for minutes.
- **SSE goes through one helper** (`@/lib/sse`) with reconnect + backoff, and events update the query
  cache (`setQueryData`/`invalidateQueries`) rather than component state.
- **Create requests that must not duplicate** (sending an email, creating a quote, submitting to IMS) send
  an `Idempotency-Key` that stays the same across retries of the same user intent and rotates after a
  definitive answer. The backend must honour it (see `node-api`).
- **Uploads** use `FormData`, check size/type client-side first for UX, and never set `Content-Type`
  manually (the browser adds the boundary). **Downloads** go through a service that returns a `Blob`;
  revoke object URLs after use.
- **No absolute URLs in services.** Paths are relative to the base URL so environments switch by config.

## Patterns

```ts
// src/lib/api-client.ts
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface RequestOptions extends Omit<RequestInit, 'body'> { body?: unknown; timeoutMs?: number; parseAs?: 'json' | 'blob' }

export async function apiRequest<T>(path: string, { body, timeoutMs = env.apiTimeoutMs, parseAs = 'json', signal, headers, ...init }: RequestOptions = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const isForm = body instanceof FormData;
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${env.apiBaseUrl}${path}`, {
    ...init,
    method,
    credentials: 'include',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(UNSAFE.has(method) ? { 'X-Requested-With': 'fetch' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  }).catch((cause: unknown) => { throw toAppError(cause); });         // network / abort / timeout

  if (response.status === 204) return undefined as T;
  if (!response.ok) throw fromHttpResponse(response.status, await response.json().catch(() => null)); // → AppError (see error-handling)
  if (parseAs === 'blob') return (await response.blob()) as T;          // downloads stay inside the client too
  return (await response.json().catch(() => null)) as T;
}

export const apiClient = {
  get: <T>(path: string, opts?: RequestOptions) => apiRequest<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>(path, { ...opts, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>(path, { ...opts, method: 'PATCH', body }),
  delete: <T>(path: string, opts?: RequestOptions) => apiRequest<T>(path, { ...opts, method: 'DELETE' }),
  download: (path: string, opts?: RequestOptions) => apiRequest<Blob>(path, { ...opts, method: 'GET', parseAs: 'blob' }),
};
```

```ts
// src/features/submissions/api/submissions.service.ts
export async function listSubmissions(filters: SubmissionFilters, signal?: AbortSignal): Promise<Page<SubmissionSummary>> {
  return apiClient.get(`/submissions?${toSearchParams(filters)}`, { signal });
}
export async function listAssessments(submissionId: string, signal?: AbortSignal): Promise<Assessment[]> {
  const data = await apiClient.get<unknown>(`/submissions/${encodeURIComponent(submissionId)}/assessments`, { signal });
  return assessmentListSchema.parse(data); // versioned decisions the UI relies on: validate
}

// src/features/submissions/api/useSubmissions.ts
export function useSubmissions(filters: SubmissionFilters) {
  return useQuery({
    queryKey: submissionKeys.list(filters),
    queryFn: ({ signal }) => listSubmissions(filters, signal),
    placeholderData: keepPreviousData,
  });
}
```

```ts
// Polling a report (POST /submissions/:id/synthesis returned 202 + a RUNNING report) until it finishes
const REPORT_TERMINAL = new Set(['COMPLETED', 'FAILED']);
export function useReport(reportId: string | undefined) {
  return useQuery({
    queryKey: reportKeys.detail(reportId ?? ''),
    queryFn: reportId ? ({ signal }) => getReport(reportId, signal) : skipToken, // GET /reports/:id; skipToken, no `!`
    // stop on a terminal state, and on error (otherwise a failing endpoint is polled forever)
    refetchInterval: (query) =>
      query.state.status === 'error' || REPORT_TERMINAL.has(query.state.data?.status ?? '') ? false : REPORT_POLL_MS,
  });
}
```

```ts
// src/lib/query-client.ts (toast comes from @/lib/toast, a tiny store the ToastProvider renders, so it works outside React)
const RETRYABLE = new Set<AppErrorKind>(['network', 'timeout', 'server']);
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error, query) => logger.error(error, { queryKey: String(query.queryKey[0]) }) }),
  mutationCache: new MutationCache({
    onError: (error, _v, _c, mutation) => {
      logger.error(error, { mutationKey: String(mutation.options.mutationKey?.[0] ?? 'unknown') });
      if (!mutation.meta?.silentError) toast.error(toAppError(error).message); // forms opt out and show inline
    },
  }),
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (count, error) => count < 2 && RETRYABLE.has(toAppError(error).kind) },
    mutations: { retry: false },
  },
});
```

## Files & naming

- `src/lib/api-client.ts`, `src/lib/query-client.ts`, `src/lib/sse.ts`.
- Services: verb-first (`listSubmissions`, `getSubmission`, `createQuote`, `sendEmail`).
- Hooks: `useSubmissions`, `useSubmission`, `useCreateQuote`, one per file in `features/<f>/api/`.

## Review checklist

- [ ] No `fetch` outside `api-client.ts`; services are typed and accept `signal`
- [ ] Reads use `useQuery` with factory keys; writes invalidate what they change
- [ ] LLM/report payloads are Zod-validated at the service boundary
- [ ] Long work uses 202 + polling/SSE, with polling that stops at a terminal state
- [ ] Duplicate-sensitive creates send a stable `Idempotency-Key`
- [ ] Loading, error and empty states exist for the new query (see `ui-ux-standards`)
