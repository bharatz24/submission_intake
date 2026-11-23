---
name: logging-monitoring
description: Use when adding logs or observability in either app — the backend pino logger and pino-http request logging, request ids and correlation across jobs, log levels, redacting PII/PHI/secrets (applicant names, NPI, email bodies, document text, prompts, tokens), the frontend logger wrapper, error reporting, health/readiness endpoints, metrics for the pipeline and LLM usage (tokens, cost, latency), or replacing console.log. Use it whenever you write a log line.
---

# Logging & Monitoring

Logs exist to answer "what happened to submission X, and why" without exposing the submission itself.
This app processes physician applications, loss runs, and email, which is sensitive personal and
business data, so the default is **IDs and metadata in logs, content never**.

Related: `error-handling`, `security` (data handling), `background-jobs`, `llm-integration` (usage).

## Backend rules

- **One `pino` logger** (`src/lib/logger.ts`), structured JSON in production, pretty in dev only. No
  `console.*` anywhere else.
- **Request logging via `pino-http`**, with a request id from `X-Request-Id` (if trusted) or a new UUID,
  returned in the response header and included in error bodies. Handlers use `req.log`, so every line
  carries the id.
- **Jobs carry correlation too:** a job logger is a child with `{ jobId, submissionId, stage, attempt }`,
  and the originating request id when there is one.
- **Levels:** `error` = needs a human (unexpected failure, data inconsistency); `warn` = handled but
  unusual (upstream retry exhausted, held for classification); `info` = business lifecycle events
  (submission received, report generated, email sent); `debug` = diagnostics, off in production.
- **Redact by configuration, not by discipline:** pino `redact` paths for `req.headers.authorization`,
  `req.headers.cookie`, and each secret key both top-level and nested (`password` and `*.password`; a `*.`
  path matches exactly one level down, not the top level). Mask secret query values in logged URLs
  (`redactUrl`: OAuth `code`/`state`, the push `token`). And don't log bodies of
  requests, emails, documents, extracted fields, prompts or LLM responses at any level.
- **Log errors as `{ err }`** so pino serialises the stack; log each error once, where it's handled.
- **Health endpoints:** `GET /api/health` (process up; no auth, no dependencies) and `GET /api/ready`
  (DB reachable, migrations applied), without leaking versions or config. Point the load balancer's
  liveness check at the first and its readiness check at the second.
- **Measure what matters** and expose it on the monitoring page or a metrics endpoint: pipeline stage
  durations and failure counts, queue depth/age, Gmail sync lag, upstream error rates, and LLM tokens,
  cache hits, cost, and latency per purpose and model (see `llm-integration`).
- **Audit is not logging.** Business events that must be provable (who sent what email, who changed a
  decision or skill) go to the append-only audit table (see `database-postgres`); logs can be rotated away.

## Frontend rules

- **One `logger`** (`src/lib/logger.ts`) with `debug/info/warn/error`; `no-console` everywhere else.
- **Production keeps `warn`+ only**, and sends `error`s to the backend (a rate-limited
  `POST /api/client-errors`, to be added with the first use) or an error tracker if one is adopted. Include route, app version, request id, and error
  kind, but no form values, document content, or query strings with personal data.
- **Expected errors aren't errors:** `validation`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
  `cancelled` log at `warn` or not at all, so real failures stand out.
- **Don't log in render bodies or loops**; log in handlers, effects, and error paths.

## Patterns

```ts
// backend/src/lib/logger.ts
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
      ...['password', 'newPassword', 'token', 'apiKey', 'refreshToken'].flatMap((k) => [k, `*.${k}`])],
    censor: '[redacted]',
  },
  transport: config.env === 'development' ? { target: 'pino-pretty' } : undefined, // pino-pretty as a devDependency
});

// app.ts
app.use(pinoHttp({
  logger,
  genReqId: (req, res) => {
    const id = randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url?.split('?')[0] }) }, // no query strings
}));
```

```ts
// Good vs bad log lines
log.info({ submissionId, attachmentCount: files.length }, 'submission received');                 // ✅
log.warn({ submissionId, npi: maskNpi(npi), status: res.status }, 'npi lookup failed, will retry'); // ✅ masked
log.info({ email }, 'got email');                                                                 // ❌ whole email object
log.debug({ prompt }, 'calling claude');                                                          // ❌ prompt contains applicant data
```

## Review checklist

- [ ] No `console.*` outside logger modules
- [ ] Logs carry request/job/submission ids, not content
- [ ] Secrets and cookies are redacted by config; no bodies, prompts or document text logged
- [ ] Each error logged once, as `{ err }`, at the right level
- [ ] Business events that must be provable go to the audit trail
- [ ] New pipeline/LLM paths emit duration, failure and usage metrics
