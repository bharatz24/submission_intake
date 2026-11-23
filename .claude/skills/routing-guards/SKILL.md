---
name: routing-guards
description: Use when adding or changing frontend routes with React Router v7 (createBrowserRouter, RouteObject, lazy routes, layouts and Outlet), auth guards (RequireAuth), permission guards (RequirePermission), the public-only login route, returnTo redirects, route params validation, unsaved-changes blocking, document titles, or the 404/route error pages.
---

# Routing & Guards

One data router (`createBrowserRouter`) built from per-feature `RouteObject[]` arrays. Guards are
**layout routes** that either render `<Outlet />` or redirect, so protection is declared once in the tree
instead of repeated inside pages. Import from `react-router` (v7), not `react-router-dom`.

Related: `authentication` (session status), `security` (`safeReturnTo`), `error-handling`, `performance`.

## Rules

- **One router in `src/app/router.tsx`**, rendered with `<RouterProvider>`. Don't mix in a `<Routes>` JSX
  tree: the data router features (lazy, errorElement, blockers) only work in one model. Today `App.tsx`
  still renders `<Routes>`, so move the whole tree to the data router in one PR, not route by route.
- **Every page is lazy** (`lazy: async () => ({ Component: … })`) so each screen is its own chunk; the
  inbox shouldn't download the rating workbook editor.
- **Nesting order: guard → layout → pages.** The layout (nav, notification bell) renders only for users
  who passed the guard.
  - `RequireAuth`: `loading` → full-page loader; `unreachable` → error state with Retry;
    `anonymous` → `<Navigate to={login?returnTo=…} replace />`.
  - `RequirePermission`: missing permission → in-place "access denied" state (the URL is valid, so don't
    redirect).
  - `PublicOnly` (login): already authenticated → `<Navigate to={safeReturnTo(returnTo)} replace />`.
- **`returnTo` is `pathname + search`**, URL-encoded, and always validated with `safeReturnTo` before use,
  otherwise the login page becomes an open redirect.
- **Paths come from `@/routes/paths`**; links use builders (`paths.submission.to(id)`), never literals.
- **Validate route params** (`z.uuid()` or the app's id format). An invalid id renders the
  not-found state instead of firing a doomed request.
- **The root route has `errorElement: <RouteErrorPage />`**, and the last child of the app layout is
  `{ path: '*' }` → `NotFoundPage`.
- **Unsaved edits are protected** with `useBlocker` (in-app navigation) plus `beforeunload` (tab close) in
  editors: skill editor, quote inputs, email compose.
- **Set a document title per page** (`useDocumentTitle('Submission · ' + name)`), which helps both screen
  readers and users with many tabs.
- **Loaders only prefetch** (`queryClient.ensureQueryData`); components still read through `useQuery`, so
  there's one cache.
- **Auth checks belong in guards, not pages**, and navigation uses `navigate()`/`<Link>`, never
  `window.location` (which reloads the app and drops the cache).

## Patterns

```tsx
// src/app/router.tsx
export const router = createBrowserRouter([
  {
    errorElement: <RouteErrorPage />,
    children: [
      { element: <PublicOnly />, children: authRoutes }, // features/auth/routes.tsx lazy-loads LoginPage
      {
        element: <RequireAuth />,
        children: [{
          element: <AppLayout />,
          children: [
            ...submissionsRoutes,
            ...auditRoutes,
            { element: <RequirePermission permission={PERMISSIONS.SETTINGS_ADMIN} />, children: settingsRoutes },
            { path: '*', element: <NotFoundPage /> },
          ],
        }],
      },
    ],
  },
]);
```

```tsx
// src/routes/guards/RequireAuth.tsx
export function RequireAuth() {
  const { status, retry } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageLoader label="Restoring session…" />;
  if (status === 'unreachable') return <ErrorState title="Can't reach the server" onRetry={() => void retry()} />;
  if (status === 'anonymous') {
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`${paths.login}?returnTo=${returnTo}`} replace />;
  }
  return <Outlet />;
}
```

```tsx
// Unsaved-changes guard in an editor
const blocker = useBlocker(({ currentLocation, nextLocation }) => isDirty && currentLocation.pathname !== nextLocation.pathname);
useEffect(() => {
  if (!isDirty) return;
  const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
  window.addEventListener('beforeunload', onBeforeUnload);
  return () => window.removeEventListener('beforeunload', onBeforeUnload);
}, [isDirty]);
// render <ConfirmDialog open={blocker.state === 'blocked'} onConfirm={blocker.proceed} onCancel={blocker.reset} … />
```

## Files & naming

- `src/app/router.tsx`, `src/routes/paths.ts`, `src/routes/guards/{RequireAuth,RequirePermission,PublicOnly}.tsx`,
  `src/routes/pages/{NotFoundPage,RouteErrorPage}.tsx`.
- Feature routes: `features/<f>/routes.tsx` exporting `<feature>Routes`. Page components end in `Page`.

## Review checklist

- [ ] New pages are lazy and registered through their feature's `routes.tsx`
- [ ] The route sits under the correct guard + layout; permission-gated screens use `RequirePermission`
- [ ] Links use `paths`; `returnTo` goes through `safeReturnTo`
- [ ] Params are validated; invalid ones show not-found
- [ ] Editors block navigation with unsaved changes
- [ ] `errorElement` and the `*` catch-all are intact
