---
name: typescript-standards
description: Use when writing or reviewing TypeScript in frontend/ or backend/ — tsconfig strictness, type vs interface, removing any/as casts/non-null assertions, typing props and API DTOs, Zod-inferred types, discriminated unions for statuses and pipeline states, as-const objects instead of enums, exhaustive switches, generics, unknown and narrowing, Node ESM (NodeNext, .js import extensions), Express request typing, or sharing types between the two apps.
---

# TypeScript Standards

Strict TypeScript is the cheapest test suite we have. Types should describe real states (a submission is
*either* held *or* classified, not a bag of optional fields) and runtime boundaries (HTTP bodies, DB rows,
LLM output, env) are validated, not cast.

Related: `forms-validation` and `node-api` (Zod), `component-patterns` (props), `coding-standards`.

## Rules

- **Strict flags stay on and get stricter, never weaker:** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters`,
  `verbatimModuleSyntax`, `isolatedModules`. Turning on a missing flag is a good small PR.
- **Backend is Node ESM:** `module`/`moduleResolution: "NodeNext"`, relative imports end in `.js`, target
  matches the Node version in `engines`.
- **`interface` for object shapes** (props, entities, DTOs); **`type`** for unions, intersections, mapped
  and function types, and `z.infer`.
- **Validate at runtime boundaries, then trust the type:** request bodies/params/query (Zod in `node-api`),
  DB rows (typed repository functions), LLM structured output (Zod), env (Zod), `JSON.parse` results,
  `postMessage`/URL params. A cast at a boundary is a bug waiting for bad data.
- **One source of truth per type.** If a Zod schema exists, use `z.infer` (or `z.input`/`z.output` when
  it coerces or transforms, see `forms-validation`); derive variants with `Pick`,
  `Omit`, `Partial`, indexed access (`Submission['status']`). Don't hand-write a parallel interface.
- **Model finite states as discriminated unions** and switch exhaustively with `assertNever`. Pipeline
  stages, job states, report generation status and email audience are all unions.
- **`as const` objects + derived unions instead of `enum`** (enums don't erase cleanly and don't match
  string data from the DB/API).
- **`unknown`, never `any`**, for values of unknown shape; narrow with Zod, `instanceof`, or a type guard.
- **No `as` casts** except `as const`, `satisfies` checks, and documented library typing gaps at an
  integration boundary. No `as unknown as X`.
- **No non-null `!`** on data from the API, DB, DOM, or index access; handle the missing case.
- **No `@ts-ignore`.** `@ts-expect-error` only in tests, with a reason.
- **Explicit return types** on exported functions, services, repositories, and hooks returning objects.
- **Dates cross boundaries as ISO strings;** money as integer cents or a decimal string from Postgres
  `numeric`, never a float that's been through arithmetic. Postgres `bigint`/`numeric` arrive as strings
  from `pg`; convert deliberately.
- **Shared contracts:** frontend and backend can't import each other. Keep the API contract in Zod schemas
  on the backend and mirror the response types on the frontend (or generate them). When a shared package is
  introduced, put schemas there, not hand-copied types.
- **Express typing:** augment `Request` once (`req.user`, `req.id`) in a `.d.ts`; handlers read typed
  values from the validated result, not from `req.body` directly.

## Patterns

```ts
// Status as const + union + exhaustive handling
export const PIPELINE_STAGES = ['dedup', 'classify', 'extract', 'npi', 'synthesis', 'analysis'] as const; // same list as background-jobs
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type StageState =
  | { status: 'pending' }
  | { status: 'running'; startedAt: string }
  | { status: 'done'; finishedAt: string }
  | { status: 'failed'; errorCode: string; message: string; attempts: number };

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

export function stageLabel(state: StageState): string {
  switch (state.status) {
    case 'pending': return 'Waiting';
    case 'running': return 'In progress';
    case 'done': return 'Done';
    case 'failed': return `Failed (${state.errorCode})`;
    default: return assertNever(state);
  }
}
```

```jsonc
// backend/tsconfig.json (essentials)
{ "compilerOptions": {
  "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
  "strict": true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true,
  "verbatimModuleSyntax": true, "isolatedModules": true, "skipLibCheck": true,
  "outDir": "dist", "rootDir": "src" } }
// frontend/tsconfig.json adds: "moduleResolution": "bundler", "jsx": "react-jsx", "noEmit": true,
// "types": ["vite/client"], "paths": { "@/*": ["./src/*"] }
```

```ts
// Typed repository result instead of casting rows at call sites
interface SubmissionRow { id: string; status: SubmissionStatus; received_at: Date; premium_cents: string | null }
export async function findSubmission(db: Queryable, id: string): Promise<Submission | null> {
  const { rows } = await db.query<SubmissionRow>('SELECT id, status, received_at, premium_cents FROM submissions WHERE id = $1', [id]);
  const row = rows[0];
  return row ? { id: row.id, status: row.status, receivedAt: row.received_at.toISOString(), premiumCents: row.premium_cents === null ? null : Number(row.premium_cents) } : null;
}
```

## Review checklist

- [ ] `tsc --noEmit` passes in both apps with zero errors
- [ ] No `any`, `@ts-ignore`, unjustified `as`, or `!`
- [ ] Runtime boundaries (HTTP, DB, LLM, env, JSON) are validated, not cast
- [ ] Finite states are unions with exhaustive handling
- [ ] No hand-written type duplicates a Zod schema
- [ ] Backend relative imports end in `.js`
