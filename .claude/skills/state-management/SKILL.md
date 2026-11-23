---
name: state-management
description: Use when deciding where frontend state lives (server cache, URL, form, component, context), writing TanStack Query key factories, cache invalidation, optimistic updates, setQueryData from SSE events, useSearchParams filter/sort/tab state, React Context providers, localStorage preferences, or when tempted to copy server data into useState. Use it before adding any new piece of state that more than one component reads.
---

# State Management

Most "state bugs" are duplicated state: the same fact stored in two places that drift apart. The fix is to
give every kind of state exactly one home. In this app the server is the source of truth for almost
everything (submissions, reports, quotes, users), so TanStack Query carries most of the load and there is
no global client store.

Related: `api-integration` (services + hooks), `forms-validation` (form state), `authentication` (session).

## Where state lives (first matching row wins)

| State | Home | Tool |
|---|---|---|
| Data from the server | Query cache | TanStack Query |
| Shareable view state: filters, sort, page, active tab, search | URL | `useSearchParams` + Zod parse |
| Form input and validation | Form | React Hook Form |
| Used by one component (or its direct children) | Component | `useState` / `useReducer` |
| Implicit state of a compound widget or subtree | Subtree | Context |
| App-wide client state that rarely changes (session, theme mode, toasts) | App | Context provider |
| Per-browser preferences (column widths, collapsed panels) | localStorage | versioned, validated helper |

Reach for a global store library (e.g. Zustand) only if you have frequently-changing, app-wide,
client-only state that Context would re-render badly. Today nothing qualifies, so adding one needs a reason
in the PR.

## Rules

- **Never copy query data into `useState`, Context, or storage**, and never "sync" them with an effect.
  Read from the query; derive during render; use `select` for slices.
- **Query keys come only from a per-feature factory**, ordered general → specific, and include every input
  of the `queryFn`. Inline arrays drift and break invalidation.
- **Invalidate the narrowest keys** that a mutation affects. If the response contains the updated entity,
  `setQueryData` the detail and invalidate the lists.
- **Server pushes (SSE) update the cache**, not component state: patch with `setQueryData` when the event
  carries the data, otherwise `invalidateQueries` for the affected keys.
- **Optimistic updates only for low-risk, reversible actions** (mark read, toggle a flag): `cancelQueries`,
  snapshot, `setQueryData`, roll back in `onError`, invalidate in `onSettled`. Never for things with
  business consequences (sending email, decisions, quotes).
- **URL state is parsed with a Zod schema with `.catch()` defaults**, so a hand-edited URL can't crash the
  page, and written back with `{ replace: true }` while typing so history isn't spammed.
- **Context values are memoised** and split by update frequency; a provider whose value changes every
  keystroke re-renders every consumer.
- **localStorage** holds non-sensitive preferences only, behind a helper with a version number and a Zod
  schema; invalid or old data falls back to defaults instead of throwing. Never tokens, PII, or submission
  data.
- **Reset per-entity local state with a `key`**, not an effect (`<QuoteEditor key={quote.id} />`).

## Patterns

```ts
// src/features/submissions/api/submissions.keys.ts
export const submissionKeys = {
  all: ['submissions'] as const,
  lists: () => [...submissionKeys.all, 'list'] as const,
  list: (filters: SubmissionFilters) => [...submissionKeys.lists(), filters] as const,
  details: () => [...submissionKeys.all, 'detail'] as const,
  detail: (id: string) => [...submissionKeys.details(), id] as const,
  versions: (id: string) => [...submissionKeys.detail(id), 'versions'] as const,
};
```

```ts
// SSE → cache: one subscriber near the root (see api-integration for the sse helper)
// lib/sse turns each named SSE event (`event: new-email`) into { type: 'new-email', data }
useEventStream<ServerEvent>('/events/stream', (event) => {
  if (event.type === 'new-email') void queryClient.invalidateQueries({ queryKey: submissionKeys.lists() });
  // an event that carries the full entity can patch it instead: setQueryData(submissionKeys.detail(id), entity)
});
```

```ts
// src/features/submissions/hooks/useInboxFilters.ts: URL as state
const filtersSchema = z.object({
  status: z.enum(SUBMISSION_STATUSES).optional().catch(undefined),
  q: z.string().trim().max(200).optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1),
});
export type InboxFilters = z.infer<typeof filtersSchema>;

export function useInboxFilters() {
  const [params, setParams] = useSearchParams();
  const filters = filtersSchema.parse(Object.fromEntries(params));
  const setFilters = (next: Partial<InboxFilters>) => {
    const merged = { ...filters, ...next, page: next.page ?? 1 }; // a filter change resets paging
    const entries = Object.entries(merged).filter(([, v]) => v !== undefined && v !== '');
    setParams(new URLSearchParams(entries.map(([k, v]) => [k, String(v)])), { replace: true });
  };
  return [filters, setFilters] as const;
}
```

```ts
// src/lib/preferences.ts: versioned, validated, never throws
const PREFS_KEY = 'submission-review:prefs';
const PREFS_VERSION = 1;
const prefsSchema = z.object({ v: z.literal(PREFS_VERSION), inboxDensity: z.enum(['compact', 'comfortable']) });
const DEFAULT_PREFS = { v: PREFS_VERSION, inboxDensity: 'comfortable' } as const;

export function readPrefs(): z.infer<typeof prefsSchema> {
  try {
    const parsed = prefsSchema.safeParse(JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null'));
    return parsed.success ? parsed.data : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS; // storage blocked or corrupt
  }
}
```

## Review checklist

- [ ] Each piece of state lives where the table puts it, and nothing is stored twice
- [ ] Keys come from the factory and include every `queryFn` input
- [ ] Mutations and SSE events update or invalidate the right keys
- [ ] URL params are Zod-parsed with safe defaults
- [ ] No server data, tokens, or PII in localStorage; prefs are versioned and validated
