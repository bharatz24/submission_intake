---
name: environment-config
description: Use when adding, reading or changing configuration in either app — backend .env and the Zod-validated config module, secrets (JWT_SECRET, ENCRYPTION_KEY, Google OAuth credentials, DATABASE_URL), admin-entered credentials such as the Anthropic API key stored encrypted in Settings, env.example, frontend VITE_ variables and import.meta.env typing, build modes, feature flags, admin-tunable runtime settings stored in the database, or docker-compose/CI variables. Use it whenever a value differs between environments.
---

# Environment & Configuration

Configuration has four homes, and putting a value in the wrong one is a common source of outages and
leaks:

| Kind | Examples | Home |
|---|---|---|
| Secrets and infrastructure | `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, Google OAuth client secret | backend env only (secret manager in prod) |
| Credentials an admin connects at runtime | Anthropic API key, Gmail/Drive refresh tokens | settings table, AES-256-GCM encrypted, write-only from the UI |
| Deploy-time behaviour | ports, `TRUST_PROXY`, CORS origins, log level, model ids, feature flags | backend env; public bits as `VITE_*` |
| Runtime, admin-tunable | Gmail polling interval, LLM token limits, automation toggles | database settings table + Settings UI, audited |

Related: `security` (secrets), `node-api`, `llm-integration` (model config), `logging-monitoring`.

## Backend rules

- **Read `process.env` only in `src/config/env.ts`.** It parses with Zod at startup, fails fast with a
  readable message listing every bad key, and exports a frozen, typed, camelCase `config` object. A typo'd
  env var should stop the server, not surface as `undefined` at 2 a.m.
- **Production is stricter than development:** dev may default `DATABASE_URL` to the docker-compose DB;
  production requires every secret and refuses weak values (min length for `JWT_SECRET`, exact length for
  a 32-byte `ENCRYPTION_KEY`).
- **Booleans** via `z.enum(['true','false']).transform(v => v === 'true')` (never `z.coerce.boolean()`,
  which turns `"false"` into `true`). **Numbers** via `z.coerce.number()` with min/max bounds.
- **`env.example` lists every key** with a comment and a safe placeholder; real `.env` files are
  git-ignored. Adding a key means updating `env.ts`, `env.example`, the test env, and deployment config
  in the same PR.
- **Secrets never appear in logs, errors, API responses, or the frontend.** Log the config at startup with
  secrets redacted (`JWT_SECRET: '***'`).
- **Rotate-able by design:** document what rotating each secret does (e.g. rotating `ENCRYPTION_KEY`
  makes stored credentials unreadable, so Gmail and the Anthropic key must be re-entered); support two
  keys during rotation where feasible.
- **Changing a key's format is a rotation too.** New deployments should use a random 32-byte base64
  `ENCRYPTION_KEY`, but an existing deployment whose key is a passphrase hashed to 32 bytes must keep
  decrypting old values: add the new derivation as a new ciphertext version (`v2:`), re-encrypt on read,
  and only then tighten validation.
- **Runtime-connected credentials** (the Anthropic API key entered in Settings, OAuth refresh tokens) are
  encrypted with `ENCRYPTION_KEY`, never returned to the browser (the UI shows only "set" and the last 4
  characters), audited on change, and picked up without a restart. An env value may serve as a fallback
  for local development.
- **Runtime settings** (admin-tunable) are read through a settings service with defaults and Zod
  validation, cached briefly, applied without restart, and every change is audited with who/when/old/new.

## Frontend rules

- **Every `VITE_*` variable is public**: it is inlined into the bundle. No secrets, ever; call a backend
  endpoint instead.
- **Read `import.meta.env` only in `src/config/env.ts`**, Zod-parsed, exported as a frozen `env` object;
  declare keys in `vite-env.d.ts` so typos fail `tsc`.
- **Prefer a relative API base (`/api`)** served through the dev proxy and the production reverse proxy,
  so the same build works in every environment; use an absolute `VITE_API_BASE` only when the API truly
  lives on another origin. The build's CSP plugin (`frontend/vite.config.ts`) then adds that origin to
  `connect-src` in `index.html` for you; the backend's `FRONTEND_ORIGIN` must allow the SPA's origin.
- **Feature flags** are `VITE_FEATURE_*` booleans exposed as `env.features.x` for build-time flags; flags
  that admins toggle at runtime come from the backend settings endpoint instead.
- **Don't branch on hostnames** (`if (location.hostname === …)`); use build mode and config.

## Patterns

```ts
// backend/src/config/env.ts
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  DATABASE_URL: z.url().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Target format. Today's key is a passphrase hashed to 32 bytes: migrate first (rotation rule above)
  ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'ENCRYPTION_KEY must be 32 bytes, base64'),
  ANTHROPIC_MODEL_ANALYSIS: z.string().optional(), // per-task override; otherwise the default model from Settings
  TRUST_PROXY: z.string().default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'), // tests use 'silent'
  GMAIL_ENABLE_VIA_MCP: bool.default(false), // Zod 4: .default() takes the OUTPUT type (.prefault('false') for input)
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && !env.DATABASE_URL) ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'Required in production' });
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`); // eslint-disable-line no-console -- logger not ready yet
  process.exit(1);
}
export const config = Object.freeze({
  env: parsed.data.NODE_ENV,
  port: parsed.data.PORT,
  databaseUrl: parsed.data.DATABASE_URL ?? DEV_DATABASE_URL,
  llm: Object.freeze({ models: Object.freeze({ analysis: parsed.data.ANTHROPIC_MODEL_ANALYSIS }) }),
  // …
});
```

```ts
// frontend/src/config/env.ts
const schema = z.object({
  VITE_API_BASE: z.string().default('/api'),
  VITE_API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  VITE_APP_VERSION: z.string().default('dev'),
});
const raw = schema.parse(import.meta.env);
export const env = Object.freeze({ apiBaseUrl: raw.VITE_API_BASE, apiTimeoutMs: raw.VITE_API_TIMEOUT_MS, appVersion: raw.VITE_APP_VERSION });
```

## Review checklist

- [ ] New key added to `env.ts`, `env.example`, test env, and deployment config
- [ ] No `process.env` / `import.meta.env` outside the config modules
- [ ] No secret in any `VITE_*` variable, log line, or response
- [ ] Booleans and numbers parsed correctly with bounds
- [ ] Admin-tunable values live in settings (validated, audited), not env
