---
name: testing
description: Use when writing, fixing or reviewing tests in either app — frontend Vitest + React Testing Library + user-event + MSW, renderHook, test utilities and factories, jsdom vs node environments; backend Vitest + supertest API tests against a real PostgreSQL test database, mocking Claude/NPI/Gmail/Drive at the integration boundary, fixtures for emails and documents, testing jobs and migrations; plus coverage expectations, LLM evals for prompt changes, and deciding what to test. Use it whenever code changes behaviour.
---

# Testing

Tests should prove **behaviour a user or caller can observe**, run fast, and fail for one reason. The two
apps test differently because their boundaries differ: the frontend's boundary is the network (mock it with
MSW); the backend's boundary is external services (mock those) while the database stays real, because SQL
behaviour is the thing most likely to be wrong.

Related: `accessibility` (axe), `llm-integration` (evals), `database-postgres`, `custom-hooks`.

## What to test where

| Unit | Test type |
|---|---|
| Pure logic: rating calc, classification rules, duplicate fingerprints, status transitions, formatters, validators, Zod schemas | unit, table-driven (`it.each`); colocated (frontend) or in `backend/tests/` |
| React hooks with logic | `renderHook` |
| Components, forms, pages | RTL + MSW integration |
| API routes (auth, validation, permissions, happy path, error envelope) | supertest + real Postgres |
| Jobs / pipeline stages | call the worker function with fakes for externals; assert DB state and audit events |
| Migrations | migrate an empty DB to head; check critical constraints/triggers |
| Prompts / LLM output quality | an eval set run on demand, not in the unit suite |

## Frontend rules

- **Query by role first** (`getByRole('button', { name: 'Send reply' })`), then label, then text; `getByTestId`
  is a last resort with a comment. Role queries double as accessibility checks.
- **`findBy*` for things that appear asynchronously**, `queryBy*` only to assert absence. No fixed sleeps.
- **Interact with `user-event`** (`const user = userEvent.setup()` before render), not `fireEvent`.
- **Mock the network with MSW only** (add `msw` as a dev dependency the first time it's needed): default handlers per feature, per-test overrides with `server.use`,
  `onUnhandledRequest: 'error'`. Don't mock `apiClient`, TanStack Query, or your own hooks.
- **Fresh `QueryClient` per test** with retries off, via `renderWithProviders` (also router + theme + auth).
- **Factories, not big literals:** `buildSubmission({ status: 'READY_FOR_REVIEW' })`.
- **Cover the four states** of every async view, form validation, server-error mapping, and permission
  variants (VIEWER sees no write actions).
- **Environment:** the Vitest default is `node`; a component test opts in to the DOM with a
  `// @vitest-environment jsdom` comment as its first line (see `frontend/vite.config.ts`).

## Backend rules

- **API tests use supertest against `createApp()`** (no `listen`), a dedicated test database
  (`TEST_DATABASE_URL`, default the docker-compose `ims_test` database) created and migrated once per run, and isolation per test (truncate the tables a test touches, or a transaction rolled
  back after each test when the code under test doesn't manage its own transactions).
- **External systems are faked at the adapter boundary:** today that means `vi.mock` of the adapter
  module (`services/claude.js`, `services/driveStorage.js` with `tests/helpers/fakeDrive.ts`); once
  `createApp(deps)` takes dependencies, inject fakes instead. The test env lives in `vitest.config.ts`. Never call real
  services in CI, and fail the test if one is attempted.
- **LLM fakes return realistic, schema-valid fixtures**, plus cases for refusal, truncation
  (`max_tokens`), invalid JSON, and timeouts, so the error paths are proven.
- **Every new route gets tests for:** unauthenticated (401), wrong role (403), invalid input (400 with
  `fieldErrors`), happy path, and the not-found/conflict case if it has one.
- **Fixtures** (sample emails, PDFs, XLSX) live in `backend/tests/fixtures/`, are synthetic or fully
  anonymised (never real applicant data), and are small.
- **Time and ids are controlled:** inject a clock or use `vi.useFakeTimers()`; don't assert on generated
  UUIDs or `now()` values.

## General

- **Name tests in behaviour terms:** `it('holds the email for review when classification confidence is low')`.
- **No `.only`/`.skip` committed;** no shared mutable state between tests; tests run in any order.
- **Coverage is a signal, not a target:** aim for ~80 % lines on `lib/`, services and features; new code
  shouldn't lower it. A bug fix starts with a failing test.

## Patterns

```tsx
// frontend/src/test/test-utils.tsx
export function renderWithProviders(ui: ReactElement, { route = '/', user: authUser = buildUser() } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  server.use(http.get(apiUrl('/auth/me'), () => HttpResponse.json(authUser)));
  const user = userEvent.setup();
  // A data router (not <MemoryRouter>) so useBlocker, lazy routes and errorElement behave as in the app
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [route] });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}><AuthProvider><RouterProvider router={router} /></AuthProvider></ThemeProvider>
    </QueryClientProvider>,
  );
  return { user, queryClient, router, ...result };
}
```

```ts
// backend/tests/assessments.test.ts (externals mocked with vi.mock at the top of the file)
describe('POST /api/submissions/:id/assessments', () => {
  const app = createApp();

  it('rejects viewers', async () => {
    const res = await request(app).post(`/api/submissions/${id}/assessments`).set(authAs('VIEWER')).set(CSRF).send({ decision: 'ACCEPT', riskRating: 'LOW' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('records the decision and an audit event', async () => {
    const res = await request(app).post(`/api/submissions/${id}/assessments`).set(authAs('UNDERWRITER')).set(CSRF).send({ decision: 'ACCEPT', riskRating: 'LOW', notes: 'Clean loss history' });
    expect(res.status).toBe(201);
    expect(await auditEventsFor(id)).toContainEqual(expect.objectContaining({ action: 'decision.updated' }));
  });
});
```

## Review checklist

- [ ] Tests assert behaviour, use role queries (frontend), and cover error/empty/permission paths
- [ ] Frontend network mocked with MSW only; unhandled requests fail
- [ ] Backend API tests hit a real test DB; externals faked at the adapter boundary
- [ ] New routes test 401/403/400/happy path
- [ ] Fixtures are synthetic; no real applicant data in the repo
- [ ] Prompt changes come with an eval run (see `llm-integration`)
- [ ] No `.only`/`.skip`; suite passes in both apps
