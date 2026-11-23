---
name: custom-hooks
description: Use when writing or extracting a custom React hook (useX), using useEffect or useLayoutEffect, dependency arrays and the exhaustive-deps rule, effect cleanup (listeners, timers, EventSource, AbortController), useSyncExternalStore, rules of hooks, hook return shapes, or shared hooks like useDebounce, useMediaQuery, useEventStream, useDocumentTitle. Use it any time you reach for useEffect.
---

# Custom Hooks & Effects

Effects are for **synchronising with something outside React** (the DOM, a browser API, an
`EventSource`, a timer, a third-party widget). Most bugs in React apps come from effects used for
anything else: fetching, deriving state, or reacting to clicks. Hooks are how you name and reuse
stateful behaviour.

Related: `state-management`, `api-integration` (query hooks), `component-patterns`, `testing` (`renderHook`).

## Rules

- **Extract a hook** when stateful logic repeats in 2+ components, when a component has more than ~15 lines
  of hook logic, or when a name makes intent clearer (`useInboxFilters`, `useUnsavedChangesGuard`).
- **Rules of hooks:** call hooks only at the top level of components/hooks, never in conditions, loops, or
  callbacks.
- **Return shape by count:** one value → return it; a `useState`-like pair → tuple `as const`; three or
  more → a named object.
- **Complete dependency arrays.** `react-hooks/exhaustive-deps` is an error. Fix dependency problems by
  design (move the function inside the effect, use functional `setState`, keep the latest callback in a
  ref), never by deleting a dependency or disabling the rule.
- **Clean up everything** an effect starts: listeners, intervals, observers, `EventSource`s,
  `AbortController`s. In dev, StrictMode mounts twice on purpose to expose missing cleanup.
- **Subscribe to external stores with `useSyncExternalStore`** (matchMedia, online status, storage events)
  rather than `useEffect` + `useState`.
- **Accept an options object** once a hook has 2+ optional inputs.
- **Not effects:**
  - Fetching data → TanStack Query.
  - Derived values → compute during render (or `useMemo` if measured as expensive).
  - Responding to a user action → do it in the event handler.
  - Resetting state when an id changes → `key` on the component.
  - Chains of effects that set state that triggers another effect → restructure.
- **A function with no hooks inside isn't a hook.** Put it in `utils/` or `lib/` and don't prefix `use`.

## Patterns

```ts
// src/hooks/useDebounce.ts
export function useDebounce<TValue>(value: TValue, delayMs = DEFAULT_DEBOUNCE_MS): TValue {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
```

```ts
// src/hooks/useEventStream.ts: an external system, with cleanup and a stable latest-callback ref
export function useEventStream<TEvent>(path: string, onEvent: (event: TEvent) => void, { enabled = true } = {}) {
  const onEventRef = useRef(onEvent);
  useLayoutEffect(() => { onEventRef.current = onEvent; });
  useEffect(() => {
    if (!enabled) return;
    const stream = openEventStream<TEvent>(path, (event) => onEventRef.current(event)); // reconnects with backoff (see lib/sse)
    return () => stream.close();
  }, [path, enabled]);
}
```

```ts
// src/hooks/useMediaQuery.ts
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
// (MUI's own useMediaQuery(theme.breakpoints.down('md')) is fine too; prefer it for breakpoints.)
```

```tsx
// Effect misuse → correct alternative
// ❌ const [total, setTotal] = useState(0); useEffect(() => setTotal(sum(items)), [items]);
const total = sum(items);                                  // ✅ derive during render
// ❌ useEffect(() => form.reset(toFormValues(quote)), [quote]);
<QuoteInputsForm key={quote.id} quote={quote} />           // ✅ remount with a key
```

## Files & naming

- Shared hooks: `src/hooks/useX.ts`. Feature UI hooks: `features/<f>/hooks/useX.ts`. Query/mutation
  hooks: `features/<f>/api/useX.ts`. One hook per file, file named after the hook.
- Test with `renderHook` in `useX.test.ts` next to the hook.

## Review checklist

- [ ] Every effect syncs with an external system and cleans up
- [ ] Dependency arrays complete, no rule disables
- [ ] No fetching, derived state, or event handling inside effects
- [ ] Return shape follows the one / tuple / object rule
