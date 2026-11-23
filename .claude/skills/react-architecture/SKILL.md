---
name: react-architecture
description: Use when adding a new frontend feature or screen, deciding whether React code is feature-specific or shared, wiring the UI → hook → service → api-client layers, defining a feature's public API (index.ts), avoiding cross-feature imports, or setting ESLint import-boundary rules. Use it whenever frontend work spans more than one file.
---

# React Architecture

Frontend code is organised by **business feature** (submissions, assessments, rating, email, settings,
users, audit, auth), with a strict downward call chain inside each feature. The goal is that a feature can
be read, changed and deleted on its own, and that data access always flows through one place.

Related: `project-structure` (folder tree), `api-integration`, `state-management`, `component-patterns`.

## Layers inside a feature

| Layer | Lives in | Does | Must not |
|---|---|---|---|
| UI | `pages/`, `components/` | Render, handle events, choose loading/empty/error | Call `fetch`/services directly |
| Hooks | `api/use*.ts`, `hooks/` | TanStack Query calls, UI logic | Render JSX |
| Services | `api/<f>.service.ts` | Typed request functions, response parsing | Import React, hooks, or context |
| Client | `@/lib/api-client` | One `fetch` wrapper: base URL, credentials, CSRF header, errors | Know about any feature |

Calls only go **down** the table. A component that wants data calls a hook; the hook calls a service; the
service calls `apiClient`. This keeps caching, error normalisation, and cancellation in one place.

## Rules

- **Dependency direction is `app → routes → features → shared`**, where shared means `components`, `hooks`,
  `lib`, `config`, `theme`, `types`. Shared code never imports from `features/`, otherwise "shared" code
  silently carries domain logic and cycles appear.
- **Use another feature only through its `index.ts`** (`@/features/submissions`). Deep imports
  (`@/features/submissions/components/X`) couple you to internals the owner may rename.
- **No circular feature dependencies.** If two features need each other, extract the shared piece to a
  shared layer, or let the page (one level up) compose both.
- **A new feature module is justified** when a domain noun has its own routes or its own API resource. A
  single extra component in an existing area is not a new feature.
- **Promote to shared only when 2+ features use it and it has no domain knowledge.** A `RiskBadge` that
  knows risk levels stays in its feature even if two places render it; export it from the feature instead.
- **Routes are declared by the feature** (`features/<f>/routes.tsx`) and composed in `app/router.tsx`, so a
  feature owns its URLs and lazy-loading.
- **Enforce boundaries with ESLint.** Rules that are only in a document get broken; a lint error doesn't.

## Patterns

```js
// eslint.config.js (excerpt): layer boundaries via eslint-plugin-import
'import/no-restricted-paths': ['error', {
  zones: [
    { target: './src/components', from: './src/features' },
    { target: './src/hooks', from: './src/features' },
    { target: './src/lib', from: ['./src/features', './src/app', './src/routes'] },
    { target: './src/features', from: './src/app' },
    { target: './src/features', from: './src/routes', except: ['./paths.ts'] }, // paths are constants only
  ],
}],
// The deep-import ban (`@/features/*/*`) lives in the single `no-restricted-imports` rule in coding-standards.
```

```ts
// src/features/submissions/index.ts: the only import target from outside the feature
export { submissionsRoutes } from './routes';
export { SubmissionStatusChip } from './components/SubmissionStatusChip';
export { useSubmission } from './api/useSubmission';
export type { Submission, SubmissionStatus } from './types/submission.types';
```

```tsx
// src/features/submissions/routes.tsx: pages stay private and lazy
import type { RouteObject } from 'react-router';
import { paths } from '@/routes/paths';

export const submissionsRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./pages/InboxPage')).InboxPage }) },
  { path: paths.submission.pattern, lazy: async () => ({ Component: (await import('./pages/SubmissionPage')).SubmissionPage }) },
];
```

## Typical feature flow (example: "add a re-run analysis button")

1. Service: `rerunAnalysis(submissionId)` in `features/assessments/api/assessments.service.ts`.
2. Hook: `useRerunAnalysis()` in `api/useRerunAnalysis.ts`, which is a `useMutation` that invalidates
   `assessmentKeys.detail(id)`.
3. UI: `RerunAnalysisButton` in `components/`, which uses the hook, shows pending state and toasts.
4. Export it from `index.ts` only if another feature renders it.

## Review checklist

- [ ] The code sits in the right feature, or is justified as shared (2+ users, no domain logic)
- [ ] UI → hook → service → `apiClient` chain respected; no `fetch` in components
- [ ] Cross-feature use goes through `index.ts` only
- [ ] No imports from shared layers into features' internals or upward into `app/`
- [ ] ESLint boundary rules pass
