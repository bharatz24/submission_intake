---
name: performance
description: Use when making the app faster or reviewing performance on the frontend or backend — route/code splitting and lazy-loaded heavy widgets (markdown, CodeMirror, document viewers), React.memo/useMemo/useCallback decisions, re-render problems, large tables and virtualization, MUI/Emotion styling cost, bundle size and manualChunks, prefetching, Core Web Vitals, slow API endpoints, N+1 queries, Postgres indexes, payload size, caching, or LLM latency and token cost. Use it before adding any memoization or a heavy dependency.
---

# Performance

Measure first, then fix the biggest cost. In this app the usual suspects are: heavy editors/renderers loaded
up front, big workspace components re-rendering on every keystroke, long tables rendered in full, chatty or
N+1 API calls, missing indexes, and LLM calls that are slower or costlier than they need to be.

Related: `routing-guards` (lazy routes), `state-management` (narrow subscriptions), `database-postgres`,
`llm-integration` (caching and cost).

## Frontend rules

- **Split every route, and lazy-load heavy widgets** (CodeMirror skill editor and merge view, markdown
  renderer, document/PDF viewer, charts) behind `lazy` + `<Suspense fallback={<Skeleton …/>}>`.
- **Memoise only with a reason**, and write the reason in a comment:
  1. The React Profiler shows a costly re-render that `memo` removes;
  2. the value/callback is a prop of a `memo` child or a hook dependency;
  3. the computation is measured as expensive (e.g. diffing two report versions).
  If the React Compiler is enabled, don't add manual memoisation.
- **Keep fast-changing state low** (inputs, hover, timers) next to where it's used, so the whole workspace
  doesn't re-render while someone types an email.
- **Subscribe narrowly:** TanStack Query `select` for slices of large payloads; split Contexts by update
  frequency; memoise provider values.
- **Large lists:** paginate on the server first; client-side lists over ~100 rows use
  `@tanstack/react-virtual` (not installed yet; add it with the first such list) or a virtualised grid.
- **Typing-driven work** (filtering a big list) uses `useDeferredValue`/`useTransition`; network-bound
  search inputs are debounced.
- **MUI/Emotion:** hoist static `sx` objects and `styled()` components out of render paths that repeat
  thousands of times (table cells); prefer theme `styleOverrides` for repeated styling.
- **Bundle:** keep vendor `manualChunks` (react, mui, markdown, editor) stable for caching; check the
  bundle report when adding a dependency; prefer the platform (`Intl`) over heavy date/format libraries.
  Budget: initial JS ≤ ~250 KB gzip.
- **Prefetch** the likely next view on hover/focus (`queryClient.prefetchQuery` for a submission row).
- **Web Vitals targets:** LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1.

## Backend rules

- **No N+1 queries:** load related rows with a join or one `WHERE id = ANY($1)` query, not a query per row.
- **Every query on a hot path has an index** that matches its `WHERE` + `ORDER BY`; check with
  `EXPLAIN (ANALYZE, BUFFERS)` on realistic data (see `database-postgres`).
- **Paginate every list endpoint** with a max page size; use keyset (cursor) pagination for large,
  append-mostly tables (emails, audit events).
- **Select only needed columns** for list views. Don't ship extracted document text or report JSON in a
  list payload; fetch it on the detail endpoint.
- **Heavy or slow work leaves the request path:** OCR, extraction, LLM calls and Drive uploads run as jobs
  (see `background-jobs`), with bounded concurrency so one large submission can't starve the queue.
- **Cache deliberately:** idempotent upstream lookups (NPI, ZIP→county) with a TTL; reuse LLM results
  keyed by input hash/context version instead of regenerating; use prompt caching for stable prompt
  prefixes (see `llm-integration`).
- **Stream large downloads** (attachments) instead of buffering whole files in memory.
- **Set timeouts on every outbound call**, so a slow dependency degrades one feature instead of
  exhausting the pool.

## Patterns

```tsx
// Lazy heavy widget with a sized skeleton
const SkillEditor = lazy(() => import('./SkillEditor').then((m) => ({ default: m.SkillEditor })));
<Suspense fallback={<Skeleton variant="rounded" height={480} />}><SkillEditor skillId={id} /></Suspense>
```

```ts
// N+1 → one query
// ❌ for (const s of submissions) s.documents = await repo.documentsFor(s.id);
const rows = await db.query<DocumentRow>(          // no extracted_text: it's large and the list doesn't show it
  `SELECT id, submission_id, filename, mime_type, size_bytes, created_at FROM documents
   WHERE submission_id = ANY($1::uuid[]) ORDER BY created_at`, [submissions.map((s) => s.id)]);
```

## Review checklist

- [ ] New routes and heavy widgets are lazy with a sized fallback
- [ ] Every `memo`/`useMemo`/`useCallback` has a reason comment
- [ ] Long lists paginated or virtualised; list payloads exclude heavy fields
- [ ] No N+1 queries; new hot queries have a matching index
- [ ] Slow work is a job; outbound calls have timeouts
- [ ] Bundle impact checked when a dependency was added
