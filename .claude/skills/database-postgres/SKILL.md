---
name: database-postgres
description: Use when touching the PostgreSQL database from the backend — writing SQL with node-postgres (pg), repository functions, parameterised queries, transactions and row locking, numbered SQL migrations (forward-only, idempotent, safe on live data), schema design (keys, constraints, foreign keys, timestamps, enums via CHECK, jsonb), indexes and EXPLAIN, pagination queries, LISTEN/NOTIFY, backfills, the append-only audit table, connection pool settings, or backup/restore. Use it for any new table, column, query, or migration.
---

# PostgreSQL

Postgres is the system of record: submissions, extracted fields, report versions, quotes, audit events,
job state. Data correctness is enforced **in the database** (constraints, foreign keys, triggers) as well
as in code, because code paths multiply and constraints don't get forgotten.

Related: `node-api` (repositories), `background-jobs` (job tables, LISTEN/NOTIFY), `performance`,
`security` (audit).

## Query rules

- **Parameterise everything** (`$1, $2`). Identifiers that must vary (sort column) come from an allow-list
  map in code. String-building SQL with user input is never acceptable.
- **SQL lives in repositories**, which return typed domain objects (not raw rows) and accept a `Queryable`
  (pool or transaction client) so the caller controls transactions.
- **Select explicit columns**, not `SELECT *`, on anything that returns to an API, so adding a column
  can't leak data.
- **Transactions** via one helper (`withTransaction(pool, fn)`) that always releases the client and rolls
  back on error. Keep them short; never call an external API (LLM, Gmail, Drive) inside one.
- **Concurrency:** use `SELECT … FOR UPDATE` when reading-then-writing a row (status transitions), or
  `UPDATE … WHERE status = $expected RETURNING *` to make the transition atomic; use
  `FOR UPDATE SKIP LOCKED` to claim queue rows; use `INSERT … ON CONFLICT` for upserts and dedup.
- **Pagination:** offset for small admin lists; keyset (`WHERE (received_at, id) < ($1, $2) ORDER BY
  received_at DESC, id DESC LIMIT $3`) for large or live tables.
- **`pg` type gotchas:** `bigint`/`numeric` come back as strings; `timestamptz` as `Date`; convert in the
  repository. Money is `numeric(12,2)` or integer cents, never `float`.
- **Pool:** one pool per process, sized to the DB's limits (e.g. 10–20), with `statement_timeout` and
  `idle_in_transaction_session_timeout` set so a stuck query can't hold locks forever.

## Schema rules

- **Primary keys:** `uuid DEFAULT gen_random_uuid()` for entities exposed in URLs; `bigint GENERATED
  ALWAYS AS IDENTITY` for internal/high-volume rows (audit, events).
- **Every table has `created_at timestamptz NOT NULL DEFAULT now()`**; mutable ones also `updated_at`.
  Always `timestamptz`, never `timestamp`.
- **Constraints carry the rules:** `NOT NULL` by default, `CHECK (status IN (…))` for enumerations (easier
  to evolve than native enums), `UNIQUE` for natural keys (Gmail message id, content fingerprint),
  `FOREIGN KEY … ON DELETE` chosen deliberately (`CASCADE` for owned children, `RESTRICT` otherwise).
- **Index every foreign key** and every column combination used in hot `WHERE`/`ORDER BY` clauses.
  Partial indexes for hot subsets (`WHERE status = 'queued'`).
- **`jsonb` for genuinely variable documents** (LLM report content, extraction evidence), with the
  schema version stored next to it. Columns you filter or join on are real columns, not jsonb paths.
- **Versioned content is immutable:** report/assessment versions are inserted, never updated; "current"
  is a pointer or the latest by `version`.
- **Audit events are append-only**, enforced by a trigger (see `security/references/backend-hardening.md`).

## Migration rules

- **Numbered, forward-only SQL files:** `NNN_description.sql`, strictly increasing, never edited after
  merge, never two files with the same number. The migrator records applied files (name + checksum) and
  runs each in a transaction.
- **Safe on a live, populated database:**
  - Add columns as nullable or with a constant default; backfill in batches; add `NOT NULL` after.
  - Create indexes on large tables `CONCURRENTLY` (in its own non-transactional migration).
  - Rename/drop in two releases: add the new thing and dual-write, then remove the old after code no
    longer reads it.
  - Add constraints `NOT VALID`, then `VALIDATE CONSTRAINT` separately for large tables.
- **Idempotent where possible** (`IF NOT EXISTS`) so a partially applied environment can recover.
- **Data backfills** that need application logic live in code (`db/backfills.ts`) as resumable, batched
  jobs, not giant `UPDATE`s inside a migration.
- **Test:** CI migrates an empty database to head and runs the suite on it.

## Operations

- **LISTEN/NOTIFY** is a wake-up signal, not a message bus: payloads are small (ids only, < 8 KB), may be
  missed during reconnects, and are sent only on commit. Listeners re-query the table for the truth and
  reconnect with backoff on a dedicated client (not a pooled one).
- **Backups:** scheduled `pg_dump -Fc` (or managed snapshots/PITR), encrypted, retained per policy, and
  **restore-tested** regularly into a scratch database. Files stored outside Postgres (Drive) are not in
  the dump, so jobs that reconcile DB ↔ storage must be disabled until a restored DB matches storage.

## Patterns

```ts
// db/tx.ts
export async function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((e: Error) => { broken = e; }); // keep the original error
    throw error;
  } finally {
    client.release(broken); // a client that couldn't roll back is destroyed, never reused mid-transaction
  }
}
```

```ts
// Atomic status transition, no read-modify-write race
const { rows } = await tx.query<SubmissionRow>(
  `UPDATE submissions SET status = $3, updated_at = now()
   WHERE id = $1 AND status = $2 RETURNING id, status, updated_at`,
  [id, expectedStatus, nextStatus],
);
if (rows.length === 0) throw new AppError('INVALID_STATE', 409, 'This submission changed. Refresh and try again.');
```

```sql
-- 015_assessment_decision_check.sql
-- Decisions are versioned rows in assessments (UNIQUE (submission_id, version)), not a submissions column.
ALTER TABLE assessments DROP CONSTRAINT IF EXISTS assessments_decision_check;
ALTER TABLE assessments ADD CONSTRAINT assessments_decision_check
  CHECK (decision IN ('ACCEPT', 'ACCEPT_WITH_CONDITIONS', 'DECLINE', 'REFER', 'REQUEST_INFORMATION')) NOT VALID;
ALTER TABLE assessments VALIDATE CONSTRAINT assessments_decision_check; -- checks old rows without blocking writes
```

## Review checklist

- [ ] All SQL parameterised; dynamic identifiers from allow-lists
- [ ] Explicit column lists; typed repository results; numeric/bigint converted deliberately
- [ ] Transactions short, with no external calls inside; races handled with locks or conditional updates
- [ ] New tables: PK, `created_at`, constraints, FK indexes
- [ ] Migration is numbered uniquely, forward-only, safe on live data, never edits an old file
- [ ] New hot queries checked with `EXPLAIN` and indexed
