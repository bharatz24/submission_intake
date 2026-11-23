---
name: authentication
description: Use when working on login, logout, first-user/sign-up, session restore, the httpOnly session cookie, JWT issuing and verification, token versioning/revocation, CSRF protection for cookie auth, password hashing, roles (ADMIN, UNDERWRITER, VIEWER) and permission checks on the frontend or backend, the 401/403 flow, or multi-tab logout. Use it for any change that touches who the user is or what they may do.
---

# Authentication & Authorization

The app uses a **server-issued session in an httpOnly cookie**, which is the standard for a first-party SPA.
JavaScript never sees the token, so XSS can't steal it. Bearer tokens exist only for scripts/CLI. The
server decides every permission; the UI only hides what the user can't do.

Related: `security` (CSRF, rate limits), `routing-guards` (route protection), `node-api` (middleware).

## Backend rules

- **Cookie:** `httpOnly; Secure (in prod); SameSite=Strict; Path=/`, short-lived (≤ 8–12 h for an
  internal tool) with sliding renewal if needed. Never return the token in a JSON body for browsers.
- **JWT claims are minimal:** `sub`, `role`, `tv` (token version), `iat`, `exp`, plus fixed `iss`/`aud`
  that are verified on every request. Pin the algorithm (`algorithms: ['HS256']`) so `alg` can't be
  swapped.
- **Revocation via token version:** a user's `token_version` column increments on logout-everywhere,
  password change, role change, or deactivation; `requireAuth` rejects tokens with a stale `tv`. Cache the
  lookup briefly (seconds), not for the token lifetime.
- **CSRF for cookie auth:** `SameSite=Strict` plus a required custom header on unsafe methods
  (`X-Requested-With: fetch`) that a cross-site form can't send, and CORS limited to known origins.
  Bearer-authenticated requests skip the header check because browsers never attach them automatically.
- **Passwords:** bcrypt (here `bcryptjs`, cost 12) or argon2id; length over composition rules, per NIST
  SP 800-63B (rev. 4 asks for at least 15 characters when the password is the only factor; the current
  minimum is 10), plus a check against common/breached passwords; compare in constant time (the library
  does). bcrypt ignores bytes past 72, so cap input at 72 bytes (the schema allows 200 characters) or use argon2id.
- **Login** is rate-limited per IP and per account, returns one generic message for any failure
  ("Email or password is incorrect"), and audits success and failure without logging the password.
- **Authorization lives in middleware and services**, never only in the route list: `requireAuth`, then
  `requirePermission(PERMISSIONS.X)`, and services check ownership/state where the rule depends on data.
- **Roles map to permissions in one shared table.** Code checks permissions (`decisions:write`), not role
  names, so adding a role doesn't mean hunting for string comparisons.
- **The first account becomes ADMIN only while the users table is empty**, inside a transaction with a
  lock, so two concurrent sign-ups can't both become admin.
- **Long-lived connections (SSE) end at token expiry** and re-check authorization when they reconnect.

## Frontend rules

- **Session state comes from the server:** on boot, `GET /api/auth/me` (a query). `200` → authenticated,
  `401` → anonymous, network/5xx → "can't reach server" with retry. Don't sign the user out because the API
  was briefly down.
- **Auth status is `'loading' | 'authenticated' | 'anonymous' | 'unreachable'`**, exposed via
  `AuthProvider` + `useAuth()`. Guards render a full-page loader while `'loading'` and an error state with
  Retry while `'unreachable'`.
- **A 401 from any request** clears the session query and lets the guard redirect to login with a validated
  `returnTo`. Don't `window.location` from inside the API client.
- **Logout:** `POST /api/auth/logout` → `queryClient.clear()` → broadcast on `BroadcastChannel('auth')` so
  other tabs drop their session too → navigate to login.
- **Permission checks use `useHasPermission(PERMISSIONS.X)`**, which reads the `me` payload. Hide or disable
  controls the user can't use, and explain disabled ones with a tooltip.
- **No tokens, passwords, or the `me` payload in localStorage/sessionStorage.**

## Patterns

```ts
// shared permission table (backend/src/config/permissions.ts; mirrored in frontend/src/config/permissions.ts)
export const PERMISSIONS = {
  SUBMISSIONS_READ: 'submissions:read',
  SUBMISSIONS_WRITE: 'submissions:write',
  DECISIONS_WRITE: 'decisions:write',
  EMAIL_SEND: 'email:send',
  SKILLS_EDIT: 'skills:edit',
  SETTINGS_ADMIN: 'settings:admin',
  USERS_ADMIN: 'users:admin',
} as const;
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL = Object.values(PERMISSIONS);
export const ROLE_PERMISSIONS = {
  ADMIN: ALL,
  UNDERWRITER: [PERMISSIONS.SUBMISSIONS_READ, PERMISSIONS.SUBMISSIONS_WRITE, PERMISSIONS.DECISIONS_WRITE, PERMISSIONS.EMAIL_SEND],
  VIEWER: [PERMISSIONS.SUBMISSIONS_READ],
} as const satisfies Record<Role, readonly Permission[]>;
```

```ts
// backend/src/http/auth.ts
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new AppError('UNAUTHENTICATED', 401, 'Sign in to continue'));
    if (!hasPermission(req.user.role, permission)) return next(new AppError('FORBIDDEN', 403, "You don't have permission to do that"));
    next();
  };
}
// router.post('/:id/assessments', requireAuth, requirePermission(PERMISSIONS.DECISIONS_WRITE), validate(...), handler)
```

```tsx
// frontend/src/features/auth/AuthProvider.tsx
export function AuthProvider({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: authKeys.me(), queryFn: ({ signal }) => getMe(signal), retry: false, staleTime: Infinity });
  const status: AuthStatus = me.isPending ? 'loading'
    : me.data ? 'authenticated'
    : isUnauthenticated(me.error) ? 'anonymous' : 'unreachable';
  const value = useMemo(() => ({ status, user: me.data ?? null, retry: me.refetch }), [status, me.data, me.refetch]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
```

## Review checklist

- [ ] Session cookie is httpOnly + SameSite=Strict (+ Secure in prod); no token in JS-readable storage
- [ ] JWT verifies `iss`, `aud`, algorithm, expiry and token version
- [ ] Unsafe cookie-auth requests require the CSRF header; CORS is an allow-list
- [ ] Every new route has `requireAuth` + the right `requirePermission`, enforced server-side
- [ ] Login is rate-limited, generic in its errors, and audited
- [ ] Frontend distinguishes 401 (anonymous) from network failure (retry)
