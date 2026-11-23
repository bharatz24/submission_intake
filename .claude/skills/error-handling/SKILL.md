---
name: error-handling
description: Use when handling or displaying errors on the frontend or backend — the normalized AppError type and error codes, the API error envelope, mapping HTTP/network errors, Express error middleware, React error boundaries (app, route, widget), user-facing messages vs logs, toast rules, retry/fallback UIs, partial pipeline failures, or 404/500 pages. Use it whenever you write a catch block.
---

# Error Handling

Errors cross three boundaries: backend → HTTP → frontend → user. Each boundary has one job: **normalise**
what it received into a known shape, **log** it once with context, and **present** a message that tells
the user what to do next. Raw stack traces, SQL errors and LLM provider messages never reach the user.

Related: `logging-monitoring`, `node-api` (envelope), `api-integration`, `ui-ux-standards` (`ErrorState`).

## The contract (shared by both apps)

```jsonc
// Any non-2xx response body
{ "error": { "code": "VALIDATION_FAILED", "message": "Effective date must be in the future", "details": { "fieldErrors": { "effectiveDate": "Must be in the future" } }, "requestId": "a1b2…" } }
```

`code` is a stable UPPER_SNAKE identifier the UI can branch on; `message` is safe to show; `details` is
optional structured data; `requestId` links the report to server logs.

## Backend rules

- **Throw `AppError(code, status, safeMessage, details?)` for expected failures** (validation, not found,
  conflict, forbidden, invalid state transition, upstream unavailable). Anything else is a bug and becomes
  a generic 500.
- **Request validation throws a 400 `AppError`, not a raw `ZodError`.** Routes parse input with
  `parseInput(schema, value)`, which converts a failed parse to `VALIDATION_FAILED` with `fieldErrors`. A
  bare `ZodError` reaching the error middleware came from internal data (an upstream response, a DB row,
  LLM output) and is a 500, because the user can't fix it by editing the form.
- **One error middleware** converts everything to the envelope: `AppError` → its status; multer limit
  errors → 413 `PAYLOAD_TOO_LARGE` (an unexpected field name is a 400); Postgres unique violation (`23505`) → 409 `CONFLICT`; unknown → 500
  `INTERNAL` with message "Something went wrong" and the real error logged with the request id. If the
  response has already started (a stream or SSE), hand the error to Express with `next(err)` so it closes
  the connection; writing a JSON body then would throw.
- **Express 5 forwards rejected async handlers** to the error middleware, so don't wrap every handler in
  try/catch just to call `next(err)`.
- **Upstream failures are classified**: timeouts and 5xx from Gmail/Drive/NPI/Anthropic become `502`/`503`
  with a code like `UPSTREAM_UNAVAILABLE`, so the UI can say "try again" rather than "you did something wrong".
- **Pipelines record failures per stage** (status `failed`, stage name, error code, safe message, attempt
  count) so a run can be retried from the failed step and the UI can show which step failed. A failed
  NPI lookup must not erase successful extraction.
- **Never leak internals:** no stack, SQL, file paths, prompt text, or provider error bodies in responses.

## Frontend rules

- **Everything the UI handles is an `AppError`** with a `kind` (`network`, `timeout`, `cancelled`,
  `unauthorized`, `forbidden`, `not_found`, `conflict`, `validation`, `rate_limited`, `server`, `unknown`),
  the server `code`, a user `message`, optional `fieldErrors`, and the `requestId`.
- **Error boundaries in layers:** app-level (full-page fallback around providers + router), route-level
  (`errorElement`), and widget-level around risky independent panels (markdown/report renderers, document
  viewer, diff/code editor) so one crash doesn't blank the workspace.
- **Query errors render inline** with `<ErrorState error={error} onRetry={refetch} />`. **Mutation errors**
  toast via the global handler, except forms, which show them inline (`meta.silentError`).
- **Toasts:** one per user action, ≤ 1 sentence, success auto-hides (~4 s), errors stay longer (~8 s)
  and can be dismissed. No toasts for load failures, validation errors, or cancelled requests.
- **`unauthorized` is handled by the auth flow** (redirect to login), and `forbidden` renders an
  access-denied state, never a toast.
- **Show the request id in small print** ("Reference: a1b2…") on error states so support can find logs.

## Patterns

```ts
// backend/src/lib/errors.ts
export class AppError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'AppError';
  }
}
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Some fields need attention', { fieldErrors: z.flattenError(result.error).fieldErrors });
  }
  return result.data;
}
export const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} not found`);
export const invalidTransition = (from: string, to: string) =>
  new AppError('INVALID_STATE', 409, `Can't move a submission from ${from} to ${to}`);
```

```ts
// backend/src/http/error-handler.ts
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);                    // mid-stream: let Express abort the response
  const requestId = req.id;
  if (err instanceof AppError) {
    if (err.status >= 500) req.log.error({ err }, 'request failed');
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId } });
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Unexpected upload field', requestId } });
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The upload is too large or has too many files', requestId } });
  }
  if (isPgUniqueViolation(err)) return res.status(409).json({ error: { code: 'CONFLICT', message: 'This already exists', requestId } });
  req.log.error({ err }, 'unhandled error');               // includes stray ZodErrors from internal data
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId } });
};
```

```ts
// frontend/src/lib/errors.ts (excerpt)
const STATUS_KIND: Partial<Record<number, AppErrorKind>> = {
  400: 'validation', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 408: 'timeout',
  409: 'conflict', 422: 'validation', 429: 'rate_limited',
};
export function fromHttpResponse(status: number, body: unknown): AppError {
  const parsed = apiErrorBodySchema.safeParse(body);
  const kind = STATUS_KIND[status] ?? (status >= 500 ? 'server' : 'unknown');
  return new AppError(kind, {
    status,
    code: parsed.success ? parsed.data.error.code : `HTTP_${status}`,
    message: parsed.success && kind !== 'server' ? parsed.data.error.message : USER_MESSAGES[kind],
    fieldErrors: parsed.success ? parsed.data.error.details?.fieldErrors : undefined,
    requestId: parsed.success ? parsed.data.error.requestId : undefined,
  });
}
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError') return new AppError('timeout');
  if (error instanceof DOMException && error.name === 'AbortError') return new AppError('cancelled');
  if (error instanceof TypeError) return new AppError('network', { cause: error }); // fetch failed
  return new AppError('unknown', { cause: error });
}
```

## Review checklist

- [ ] Backend: expected failures throw `AppError`; unknown errors become a generic 500 and are logged with the request id
- [ ] No stack traces, SQL, prompts, or provider bodies in responses or UI
- [ ] Pipeline/job failures record the failed stage and are retryable from it
- [ ] Frontend: caught errors are normalised with `toAppError` and logged once
- [ ] App, route and risky-widget boundaries exist
- [ ] Toast rules followed; no toasts for load, validation, or cancelled errors
- [ ] Empty `catch {}` blocks don't exist (or carry a comment saying why ignoring is correct)
