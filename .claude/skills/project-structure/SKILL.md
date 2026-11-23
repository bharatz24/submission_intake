---
name: project-structure
description: Use when creating a new file or folder anywhere in frontend/ or backend/, deciding where a file belongs, naming folders, using the @/ import alias, barrel/index.ts files, colocating tests, or moving legacy files into the target layout. Consult it before adding any new module, even a small helper, so the tree stays predictable.
---

# Project Structure

The repo is a two-app monorepo: `frontend/` (React + Vite + MUI) and `backend/` (Node + Express + PostgreSQL).
Both follow a **feature/module-first** layout: code that changes together lives together, and shared code
is the exception that has to earn its place.

The existing code predates this layout (for example a flat `frontend/src/components/`). Don't do a big-bang
move. Put **new** code in the target location, and move a legacy file when you are already making a
substantial change to it, in its own commit (`refactor: move X into features/submissions`).

Related: `react-architecture` (frontend layering), `node-api` (backend layering), `coding-standards` (naming).

## Frontend target tree

```
frontend/src/
├── main.tsx                 # createRoot + <AppProviders><RouterProvider/></AppProviders>
├── app/                     # providers.tsx, router.tsx, AppErrorBoundary.tsx
├── routes/                  # paths.ts, guards/ (RequireAuth, RequirePermission), pages/ (NotFound, RouteError)
├── features/<feature>/      # submissions, assessments, rating, email, settings, users, audit, auth…
│   ├── api/                 # <feature>.service.ts, <feature>.keys.ts, use<Thing>.ts (one hook per file)
│   ├── components/          # feature components + colocated tests
│   ├── hooks/               # non-API feature hooks
│   ├── pages/               # route components (lazy-loaded)
│   ├── schemas/             # Zod schemas: <entity>.schema.ts
│   ├── types/               # <entity>.types.ts
│   ├── utils/               # pure feature helpers
│   ├── constants.ts
│   ├── routes.tsx           # RouteObject[] for this feature
│   └── index.ts             # public API: the only barrel allowed
├── components/
│   ├── ui/                  # design-system wrappers over MUI: EmptyState, ErrorState, ConfirmDialog, …
│   ├── form/                # RHF-bound MUI fields: FormTextField, FormSelect, FormRootError
│   ├── feedback/            # ToastProvider (renders lib/toast), ConfirmProvider
│   └── layout/              # AppLayout, PageHeader, SkipLink
├── hooks/                   # shared hooks: useDebounce, useMediaQuery, useDocumentTitle
├── lib/                     # api-client, query-client, errors, logger, format, sse, toast, safe-redirect, sanitize
├── config/                  # env.ts, constants.ts, permissions.ts
├── theme/                   # theme.ts (createTheme), tokens.ts
├── types/                   # shared types: api.ts (Page<T>, ApiErrorBody)
├── assets/                  # images/svg imported by code
└── test/                    # setup.ts, test-utils.tsx, mocks/ (server.ts, handlers/), factories/
```

## Backend target tree

```
backend/src/
├── server.ts                # process entry: config, migrations, listen, graceful shutdown
├── app.ts                   # createApp(deps): express app, middleware, route mounting (no listen)
├── config/                  # env.ts (Zod-validated), constants.ts
├── http/                    # middleware: auth, csrf, error-handler, validate, request-id, rate-limit
├── modules/<domain>/        # submissions, reports, rating, auth, users, audit, settings…
│   ├── <domain>.routes.ts   # Express Router: parse → call service → respond
│   ├── <domain>.service.ts  # business rules, transactions, no req/res
│   ├── <domain>.repository.ts # SQL only
│   ├── <domain>.schemas.ts  # Zod request/response schemas
│   └── <domain>.types.ts
├── integrations/            # gmail/, drive/, npi/, anthropic/: one adapter per external system
├── jobs/                    # queue.ts, workers/<job>.worker.ts, pipeline stages
├── llm/                     # prompt builders, output schemas, skill loader (see llm-integration)
├── db/                      # pool.ts, tx.ts, migrate.ts, migrations/NNN_<name>.sql
└── lib/                     # logger, errors (AppError), crypto, time: no domain knowledge
backend/tests/               # all backend tests: unit + API (supertest + real Postgres), helpers/, fixtures/
backend/skills/              # runtime product skills read by the LLM pipeline (data, not code)
```

## Rules

- **Pick the folder from the tree, don't invent new top-level ones.** A predictable tree is what lets a
  reviewer (or an agent) find code without searching. If something truly doesn't fit, raise it instead of
  adding `misc/`.
- **No `utils/`, `helpers/`, `common/`, or `shared/` dumping grounds** at the top level. Name modules by
  what they do (`format.ts`, `safe-redirect.ts`). Feature-local `utils/` is fine because its scope is clear.
- **Only one barrel per feature** (`features/<f>/index.ts`), with explicit named exports, no `export *`.
  Other barrels create import cycles and slow Vite HMR. Import shared modules by file path.
- **Frontend imports across folders use `@/`** (`@/lib/api-client`). Inside a feature, relative imports
  one level deep are fine. `../../` is a sign the file is in the wrong place.
- **Backend imports are relative with `.js` extensions** (Node ESM `NodeNext` resolution requires them);
  don't add a path alias to the backend unless the build and test tooling are configured for it.
- **Colocate on the frontend.** `X.test.tsx` sits next to `X.tsx`. A helper used by one component lives beside it. When a
  component grows sub-parts, it becomes a folder (`QuoteTable/QuoteTable.tsx`, `QuoteTable/QuoteRow.tsx`).
- **Backend tests live in `backend/tests/`**, never in `src/`: `tsc` compiles everything under `src/` into
  `dist/`, so a colocated test would ship in the build.
- **Create folders only when needed.** Empty placeholder folders are noise.
- **Static files that aren't imported** (favicon, robots.txt) go in `frontend/public/`.
- **Generated or runtime data never lives in `src/`**: uploads, caches, OCR data, and exports go in
  git-ignored folders configured through env.

## Patterns

```ts
// frontend/vite.config.ts: the alias isn't configured yet. Add it (with tsconfig "paths", see
// typescript-standards) in the PR that creates the first file under features/.
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
```

```ts
// frontend/src/routes/paths.ts: one source for URLs, no string literals in <Link to>
export const paths = {
  inbox: '/',
  login: '/login',
  submission: { pattern: '/submissions/:submissionId', to: (id: string) => `/submissions/${encodeURIComponent(id)}` },
  settings: { root: '/settings', users: '/settings/users' },
} as const;
```

## Files & naming

- Frontend components are `PascalCase.tsx`, hooks are `useThing.ts`, and other files are
  `kebab-case.<role>.ts` (`submissions.service.ts`, `quote.schema.ts`).
- Backend files are `<domain>.<role>.ts` (`reports.service.ts`), and migrations are `NNN_snake_case.sql`
  with a strictly increasing number. Never reuse a number. Two `007_*` files is a bug.
- Feature and module folders are kebab-case plural nouns (`submissions`, `email-drafts`).

## Review checklist

- [ ] The new file is where the tree says it goes (or the PR explains why not)
- [ ] No new barrels, no `export *`, no top-level `utils/`
- [ ] Frontend cross-folder imports use `@/`; backend imports end in `.js`
- [ ] Frontend tests are colocated; backend tests are in `backend/tests/`
- [ ] Legacy moves are in a separate refactor commit
