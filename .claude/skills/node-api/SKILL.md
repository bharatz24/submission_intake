---
name: node-api
description: Use when building or changing the backend HTTP API with Express 5 and TypeScript — adding a route or router, request validation with Zod, the routes → service → repository layering, response shapes and the error envelope, status codes, pagination/filtering/sorting, idempotency keys, file upload endpoints, 202 + job endpoints for long-running work, Server-Sent Events, middleware (auth, CSRF, rate limit, request id), graceful shutdown, or the createApp/server split. Use it for every backend endpoint change.
---

# Node API (Express 5 + TypeScript)

The backend is a modular monolith: one Express app, one Postgres database, domain modules with thin routes.
**Routes speak HTTP, services hold business rules, repositories hold SQL, integrations talk to the outside
world.** Keeping those apart is what makes rules testable without HTTP and SQL reviewable in one place.

Related: `database-postgres`, `error-handling` (envelope), `authentication`, `security`,
`background-jobs`, `testing`.

## Layers

| Layer | File | Does | Must not |
|---|---|---|---|
| Route | `<domain>.routes.ts` | Middleware chain, parse input with Zod, call service, map to status + JSON | Contain business rules or SQL |
| Service | `<domain>.service.ts` | Rules, state transitions, transactions, audit events, calling integrations | Touch `req`/`res` |
| Repository | `<domain>.repository.ts` | Parameterised SQL, row → domain mapping | Contain business decisions |
| Integration | `integrations/<system>/` | One adapter per external system, with timeouts/retries | Know about HTTP routes |

## Rules

- **`app.ts` exports `createApp(deps)`; `server.ts` listens.** Dependencies (db pool, clock, integration
  clients) are injected so tests can swap them, and nothing connects at import time.
- **Validate every input** with a Zod schema per route (`body`, `params`, `query`) via a `validate()`
  middleware or `parseInput(schema, value)` at the top of the handler; both throw a 400 `AppError` (see
  `error-handling`). Use the parsed value, never raw
  `req.body`. Strip unknown keys (`z.object` default) so mass-assignment can't sneak fields in.
- **Every route declares auth explicitly:** `requireAuth` + `requirePermission(...)`, or a comment saying
  why it is public (health, OAuth callback, push webhook with token check).
  Handlers read the caller with `currentUser(req)`, which throws 401 if absent, instead of `req.user!`.
- **Resource-oriented URLs, plural nouns, kebab-case:** `/api/submissions/:id/documents`. Actions that
  aren't CRUD are sub-resources (`POST /submissions/:id/synthesis` to generate a report,
  `POST /submissions/:id/retry`).
- **Status codes mean something:** 200 read/update, 201 created (+ `Location`), 202 accepted (async job),
  204 no body, 400 validation, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict/invalid state,
  413 too large, 422 unprocessable content (well-formed but unusable, e.g. corrupt PDF), 429 rate limited,
  502/503 upstream failure.
- **Responses are JSON objects, not bare arrays** (room to add fields), camelCase keys, ISO 8601 dates.
  Lists return `{ items, page, pageSize, total }` or `{ items, nextCursor }`, with an enforced max page size.
- **Sorting/filtering params map through allow-lists** (`SORT_COLUMNS[sort]`); never interpolate user
  input into SQL.
- **Long work returns 202** with the job/resource id and a URL to poll (or an SSE event to wait for).
  Requests shouldn't run LLM generation or OCR inline.
- **Idempotency for side-effecting creates** (send email, submit to IMS, create quote): accept an
  `Idempotency-Key`, store key → response for ≥ 24 h scoped to the user and route, replay the stored
  response on repeats, and return 409 if the same key arrives with a different body.
- **State changes go through one transition table** (`services/statusTransitions.ts`: `canTransition`,
  wrapped by an `assertTransition(from, to)` that throws 409) so a submission can't jump from `NEW` to
  `COMPLETED` by accident.
- **Side effects inside a request are transactional** where they touch the DB (decision + audit event in
  one transaction). External calls happen outside DB transactions; use an outbox/job if both must happen.
- **SSE endpoints** set `Content-Type: text/event-stream`, send named events with an `id:` (`event:
  new-email`) and a `retry:` hint, send comment heartbeats (`: ping`), support `Last-Event-ID` replay
  where cheap, close at session expiry, and clean up listeners and timers on `close`.
- **Graceful shutdown:** on SIGTERM stop accepting connections, close SSE streams, let in-flight requests
  and the current job step finish (with a timeout), then close the pool.
- **Versioning:** additive changes only on existing endpoints; breaking changes need a new route or a
  coordinated frontend release in the same PR.

## Patterns

```ts
// modules/submissions/submissions.routes.ts
const listQuery = z.object({
  status: z.enum(SUBMISSION_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['receivedAt', 'applicantName', 'status']).default('receivedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});
const idParams = z.object({ id: z.uuid() });
// DECISIONS = ['ACCEPT', 'ACCEPT_WITH_CONDITIONS', 'DECLINE', 'REFER', 'REQUEST_INFORMATION'] as const
// RISK_RATINGS = ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'] as const
const decisionBody = z.object({
  decision: z.enum(DECISIONS),
  riskRating: z.enum(RISK_RATINGS),
  notes: z.string().trim().max(4000).default(''),
});

export function submissionsRouter(deps: Deps): Router {
  const router = Router();
  const service = createSubmissionsService(deps);

  router.get('/', requireAuth, requirePermission(PERMISSIONS.SUBMISSIONS_READ), async (req, res) => {
    res.json(await service.list(parseInput(listQuery, req.query)));
  });

  router.post('/:id/assessments', requireAuth, requirePermission(PERMISSIONS.DECISIONS_WRITE), async (req, res) => {
    const { id } = parseInput(idParams, req.params);
    const created = await service.recordDecision(id, parseInput(decisionBody, req.body), currentUser(req)); // throws 401 if absent, so no `!`
    res.status(201).location(`/api/submissions/${id}/assessments/${created.id}`).json(created); // new version
  });

  router.post('/:id/synthesis', requireAuth, requirePermission(PERMISSIONS.SUBMISSIONS_WRITE), async (req, res) => {
    const { id } = parseInput(idParams, req.params);
    const report = await service.requestSynthesis(id, currentUser(req)); // inserts a RUNNING report, enqueues the job
    res.status(202).location(`/api/reports/${report.id}`).json(report);   // poll until COMPLETED or FAILED
  });

  return router;
}
```

```ts
// modules/submissions/submissions.service.ts
export function createSubmissionsService({ db, clock }: Deps) {
  return {
    async recordDecision(id: string, input: DecisionInput, actor: AuthUser): Promise<Assessment> {
      return withTransaction(db, async (tx) => {
        const submission = await repo.findForUpdate(tx, id); // row lock serialises concurrent decisions
        if (!submission) throw notFound('Submission');
        const previous = await assessments.latest(tx, id);
        // Decisions are append-only versions: insert the next one, never update the old row
        const created = await assessments.insert(tx, { submissionId: id, version: (previous?.version ?? 0) + 1,
          ...input, createdBy: actor.id, createdAt: clock.now() });
        await audit.record(tx, { actorId: actor.id, action: 'decision.updated', targetType: 'submission', targetId: id,
          details: { from: previous?.decision ?? null, to: input.decision } });
        return created;
      });
    },
  };
}
```

## Review checklist

- [ ] Route → service → repository layering; no SQL or rules in routes
- [ ] Every input Zod-validated; parsed values used
- [ ] Auth + permission declared on the route
- [ ] Correct status codes; list endpoints paginated with a max page size
- [ ] Long work returns 202; side-effecting creates honour `Idempotency-Key`
- [ ] DB writes + audit events share a transaction; external calls stay outside it
- [ ] API tests added (see `testing`)
