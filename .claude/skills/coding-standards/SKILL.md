---
name: coding-standards
description: Use when naming files, components, hooks, functions, variables, constants or database objects, ordering imports, removing magic numbers/strings, writing comments and TSDoc, keeping files and functions small, configuring ESLint/Prettier/lint-staged/Husky, writing commit messages, or opening a pull request. Applies to both frontend/ and backend/.
---

# Coding Standards

Consistency is what lets someone (or an agent) change unfamiliar code safely. These rules apply to both
apps; where they differ, the table says so. Tooling enforces what it can, so review time goes to design.

Related: `typescript-standards`, `project-structure`, `testing`.

## Naming

| Thing | Convention | Example |
|---|---|---|
| React component + file | PascalCase | `SubmissionHeader.tsx` |
| Hook + file | `use` + camelCase | `useSubmission.ts` |
| Other frontend files | kebab-case + role | `submissions.service.ts`, `quote.schema.ts` |
| Backend files | `<domain>.<role>.ts` | `reports.service.ts`, `npi.client.ts` |
| Folders | kebab-case | `email-drafts/` |
| Functions | camelCase, verb first | `classifySubmission`, `formatCurrency` |
| Booleans | `is/has/can/should` | `isHeld`, `canSend` |
| Module constants | UPPER_SNAKE | `MAX_ATTACHMENT_BYTES` |
| Types / interfaces | PascalCase, no `I`/`T` prefix | `SubmissionFilters` |
| Event handlers | `onX` prop / `handleX` impl | `onSelect={handleSelect}` |
| Zod schema | camelCase + `Schema` | `quoteInputsSchema` |
| Error codes | UPPER_SNAKE | `UPSTREAM_UNAVAILABLE` |
| SQL tables / columns | snake_case, tables plural | `submissions.received_at` |
| Env vars | UPPER_SNAKE, prefixed by area | `GOOGLE_CLIENT_ID`, `ANTHROPIC_MODEL_ANALYSIS`, `VITE_API_BASE` |

## Rules

- **Tooling status:** neither app has ESLint, Prettier, lint-staged or Husky installed yet, so today the
  gates are `npm run typecheck` and `npm test` in both apps. Add the tooling in its own `chore:` PR (flat
  `eslint.config.js` with `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`,
  `eslint-plugin-simple-import-sort`), fixing or explicitly suppressing existing violations in that PR.
- **Size limits:** a component ≤ ~200 lines, any file ≤ ~400, a function ≤ ~50. More than three positional
  parameters → one options object. Big files are where bugs hide and merges conflict.
- **Import order** (one blank line between groups): node built-ins → external packages → `@/` (frontend)
  → relative → styles/assets. Enforced by `simple-import-sort`.
- **`import type` for type-only imports** (required once `verbatimModuleSyntax` is on; see
  `typescript-standards`).
- **No magic values.** Limits, durations, thresholds, status strings and keys become named constants in the
  feature/module `constants.ts` or `config/constants.ts`. Inline is fine for `0`, `1`, `-1`, `''`, booleans.
  Business thresholds that admins may tune (polling interval, token limits) belong in settings, not code.
- **Comments explain *why*,** not what. Exported functions in `lib/`, `hooks/`, services and integrations
  get TSDoc when the contract isn't obvious (units, side effects, thrown errors).
- **TODOs have an owner or ticket:** `// TODO(IMS-123): …`.
- **Every promise is handled:** `await`ed, returned, `void`ed deliberately, or `.catch`ed. Floating
  promises in the backend become unhandled rejections.
- **Named exports only**, except where a tool requires a default (`vite.config.ts`, `eslint.config.js`,
  `React.lazy` modules mapped in place).
- **No `console.*`** outside the logger modules, no `debugger`, no commented-out code.
- **No nested ternaries in JSX**; use early returns or a lookup map.
- **`eslint-disable` needs a reason on the same line**, scoped to one rule and one line.
- **Prettier owns formatting** (single quotes, semicolons, trailing commas, width 110–120). Don't argue
  formatting in review.
- **Commit messages are free-form** (not linted, locally or in CI): write a clear summary of the change.
  One logical change per commit; refactors separate from behaviour changes.
- **Pull requests** explain *why*, list user-visible changes, include tests, note migrations/env changes,
  and pass `typecheck`, `lint`, and `test` for both apps.
- **Never bypass hooks** (`--no-verify`) to get a commit in.

## Patterns

```js
// eslint.config.js (core rules, both apps). no-floating-promises needs type-aware linting:
// languageOptions: { parserOptions: { projectService: true } }
rules: {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/consistent-type-imports': 'error',
  '@typescript-eslint/no-non-null-assertion': 'error',
  'no-console': 'error',
  'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
  'simple-import-sort/imports': 'error',
  // frontend only
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'error',
  'no-restricted-imports': ['error', { patterns: [
    { group: ['../../*'], message: 'Use the @/ alias' },
    { group: ['@/features/*/*'], message: 'Import from the feature public API: @/features/<name>' },
  ] }],
},
```

```jsonc
// package.json (root or per app)
"lint-staged": {
  "*.{ts,tsx}": ["eslint --fix --max-warnings 0", "prettier --write"],
  "*.{json,md,sql,yml}": ["prettier --write"]
}
// .husky/pre-commit → npx lint-staged · CI → typecheck, lint, test (both apps)
```

## Review checklist

- [ ] Names follow the table; file names match their main export
- [ ] No magic values, `console`, default exports, or commented-out code
- [ ] Imports sorted; `import type` used
- [ ] No floating promises
- [ ] Commit messages are clear; PR explains why and lists migrations/env changes
