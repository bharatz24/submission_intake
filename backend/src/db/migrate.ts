import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type pg from 'pg';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { moduleDir } from '../runtime/moduleDir.js';
import { BACKFILLS } from './backfills.js';
// Migrations run on the lock pool: it has no statement_timeout (a backfill or index build may run long) and the
// migrator's session advisory lock must not pin an application connection.
import { closePools, lockPool as pool } from './pool.js';

const MIGRATIONS_DIR = path.join(moduleDir(import.meta.url, 'backend/dist/db'), 'migrations');
const SCHEMA_FILE = '001_schema.sql';

/**
 * Migrations folded into 001_schema.sql. 001_init … 020_rating_quotes were committed; 021 … 024 and the two 002s only
 * ever existed locally, so a database may have run any subset of them. All of them are handled by convergeLegacy().
 */
export const SQUASHED_INTO_SCHEMA = [
  '001_init.sql',
  '002_unique_npi_verification.sql',
  '003_constraints_and_indexes.sql',
  '004_structured_names.sql',
  '005_llm_calls.sql',
  '006_submission_reads.sql',
  '007_duplicates.sql',
  '008_body_fingerprint.sql',
  '009_duplicate_tail_and_signals.sql',
  '010_drive_storage.sql',
  '011_manual_entries.sql',
  '012_outbound_emails.sql',
  '013_manual_field_documents.sql',
  '014_app_settings.sql',
  '014_npi_match_override.sql',
  '015_system_errors_cleared.sql',
  '016_rule_confidence.sql',
  '017_submission_deleted.sql',
  '018_report_comparisons.sql',
  '019_skill_file_revisions.sql',
  '020_rating_quotes.sql',
  '021_single_rating.sql',
  '022_us_location_master.sql',
  '023_lookup_rate_tables.sql',
  '024_drop_lookup_rate_rows.sql',
];
/** Folded into 001_schema.sql after it was first applied. */
const FOLDED_INTO_SCHEMA_LATER = [
  '002_drop_rate_group_files.sql',
  '002_minimize.sql',
  '002_rating_money.sql',
  '010_auth.sql',
  '011_jobs.sql',
  '012_outbound.sql',
];

/** Where convergeLegacy() keeps every pre-squash table (and the legacy quotes backfill reads `quotes` from). */
export const LEGACY_SCHEMA = 'legacy_pre_squash';
const BUILD_SCHEMA = 'ims_converge';
const EXPECTED_SCHEMA = 'ims_expected';
/** pg_advisory_lock key: one migrator at a time across every instance and the CLI. */
const MIGRATION_LOCK = 0x494d5331; // 'IMS1'

/** A stale dist/ (copy-assets copies over it) can still hold the squashed files: they must never run again. */
const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !SQUASHED_INTO_SCHEMA.includes(f) && !FOLDED_INTO_SCHEMA_LATER.includes(f))
    .sort();
const readMigration = (file: string) => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
/** SHA-256 of a migration file, line endings normalized (a Windows checkout with CRLF is the same file). */
export const migrationChecksum = (sql: string) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

// ---- Schema shape: what verification and convergence compare ------------------------------------------------------

export interface SchemaShape {
  /** table → column → "type null|notnull" */
  columns: Map<string, Map<string, string>>;
  /** "table.constraint (type)" and "table.index" names. */
  objects: Set<string>;
  /** The same names → their definition (pg_get_constraintdef / pg_get_indexdef), schema names removed. */
  definitions: Map<string, string>;
}

export async function readShape(db: pg.ClientBase, schema: string): Promise<SchemaShape> {
  const { rows: cols } = await db.query<{ table_name: string; column_name: string; type: string }>(
    `SELECT c.table_name, c.column_name,
            c.udt_name || COALESCE('(' || c.character_maximum_length || ')', '')
              || CASE WHEN c.udt_name = 'numeric' THEN COALESCE('(' || c.numeric_precision || ',' || c.numeric_scale || ')', '') ELSE '' END
              || CASE WHEN c.is_nullable = 'YES' THEN ' null' ELSE ' notnull' END AS type
     FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'`,
    [schema],
  );
  const columns = new Map<string, Map<string, string>>();
  for (const c of cols) {
    if (c.table_name === 'schema_migrations') continue;
    const t = columns.get(c.table_name) ?? new Map<string, string>();
    t.set(c.column_name, c.type);
    columns.set(c.table_name, t);
  }
  const { rows: objs } = await db.query<{ name: string; def: string }>(
    `SELECT cl.relname || '.' || co.conname || ' (' || co.contype::text || ')' AS name, pg_get_constraintdef(co.oid) AS def
     FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = $1 AND cl.relname <> 'schema_migrations'
     UNION ALL
     SELECT tablename || '.' || indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename <> 'schema_migrations'`,
    [schema],
  );
  // The scratch schema and public print their own name in definitions (ON ims_expected.t, REFERENCES public.t, the
  // trigram opclass public.gin_trgm_ops): both are removed so only the definition itself is compared.
  const unqualify = (def: string) =>
    [`${ident(schema)}.`, `${schema}.`, 'public.'].reduce((text, prefix) => text.split(prefix).join(''), def);
  return {
    columns,
    objects: new Set(objs.map((o) => o.name)),
    definitions: new Map(objs.map((o) => [o.name, unqualify(o.def)])),
  };
}

/**
 * What `actual` lacks or has differently from `expected`. Extra tables, columns and indexes are reported separately.
 * With `definitions`, a constraint or index present on both sides must also have the same definition (DB-14): only the
 * post-migration verification asks for it; legacy convergence keeps comparing shapes by name, as it always has.
 */
export function diffShapes(
  expected: SchemaShape,
  actual: SchemaShape,
  opts: { definitions?: boolean } = {},
): { problems: string[]; extras: string[] } {
  const problems: string[] = [];
  const extras: string[] = [];
  for (const [table, cols] of expected.columns) {
    const have = actual.columns.get(table);
    if (!have) {
      problems.push(`table ${table} is missing`);
      continue;
    }
    for (const [col, type] of cols) {
      const got = have.get(col);
      if (!got) problems.push(`column ${table}.${col} is missing`);
      else if (got !== type) problems.push(`column ${table}.${col} is ${got}, expected ${type}`);
    }
    for (const col of have.keys()) if (!cols.has(col)) extras.push(`column ${table}.${col}`);
  }
  for (const table of actual.columns.keys()) if (!expected.columns.has(table)) extras.push(`table ${table}`);
  for (const o of expected.objects) {
    if (!actual.objects.has(o)) problems.push(`constraint/index ${o} is missing`);
    else if (opts.definitions && expected.definitions.get(o) !== actual.definitions.get(o))
      problems.push(
        `constraint/index ${o} is "${actual.definitions.get(o)}", expected "${expected.definitions.get(o)}"`,
      );
  }
  return { problems, extras };
}

/** Runs migration files into a scratch schema and reads the shape they produce. The caller's transaction is rolled back. */
async function buildInScratch(db: pg.ClientBase, schema: string, files: string[]): Promise<void> {
  await db.query(`CREATE SCHEMA ${schema}`);
  // Only the scratch schema on the path: unqualified names in the files resolve there, never to the live tables.
  await db.query(`SET LOCAL search_path TO ${schema}`);
  for (const f of files) await db.query(readMigration(f));
  await db.query('SET LOCAL search_path TO "$user", public');
}

async function expectedShape(db: pg.PoolClient, files: string[]): Promise<SchemaShape> {
  await db.query('BEGIN');
  try {
    await buildInScratch(db, EXPECTED_SCHEMA, files);
    return await readShape(db, EXPECTED_SCHEMA);
  } finally {
    await db.query('ROLLBACK');
  }
}

/** After migrating: the live schema must have every table, column (same type and nullability), constraint and index. */
async function verifySchema(files: string[]): Promise<void> {
  const db = await pool.connect();
  try {
    let expected: SchemaShape;
    try {
      expected = await expectedShape(db, files);
    } catch (err) {
      // Not drift: the files themselves could not be replayed in a scratch schema. In CI (MIGRATION_REPLAY_CHECK=fail)
      // that is a broken migration file and fails the run; elsewhere it is said and the start carries on.
      if (config.MIGRATION_REPLAY_CHECK === 'fail')
        throw new Error(`Schema verification failed: the migrations could not be replayed in a scratch schema`, {
          cause: err,
        });
      logger.warn({ err }, 'schema verification skipped: migrations could not be replayed in a scratch schema');
      return;
    }
    const { problems } = diffShapes(expected, await readShape(db, 'public'), { definitions: true });
    if (problems.length) {
      throw new Error(
        `Database schema does not match the migrations (${problems.length} difference${problems.length === 1 ? '' : 's'}):\n- ` +
          `${problems.slice(0, 40).join('\n- ')}\nThe server will not start on a drifted schema. See README "Database migrations".`,
      );
    }
  } finally {
    db.release();
  }
}

// ---- Legacy convergence --------------------------------------------------------------------------------------------

/**
 * Column expressions for target columns whose legacy form differs in more than type. Keyed by table, then target
 * column; each takes the source's column set and returns an SQL expression over alias s, or null when not derivable.
 */
const DERIVED: Record<string, Record<string, (src: Set<string>) => string | null>> = {
  // HEAD kept message facts in emails.signals (jsonb, keys as in classificationRules.MessageSignals).
  emails: {
    auto_submitted: (src) => (src.has('signals') ? `s.signals->>'autoSubmitted'` : null),
    list_unsubscribe: (src) =>
      src.has('signals') ? `COALESCE((s.signals->>'listUnsubscribe')::boolean, false)` : null,
    precedence: (src) => (src.has('signals') ? `s.signals->>'precedence'` : null),
    report_type: (src) => (src.has('signals') ? `s.signals->>'reportType'` : null),
    gmail_category: (src) => (src.has('signals') ? `s.signals->>'gmailCategory'` : null),
  },
  // HEAD kept token counts in usage jsonb ({ inputTokens, outputTokens }).
  reports: {
    input_tokens: (src) => (src.has('usage') ? `(s.usage->>'inputTokens')::int` : null),
    output_tokens: (src) => (src.has('usage') ? `(s.usage->>'outputTokens')::int` : null),
  },
  report_comparisons: {
    input_tokens: (src) => (src.has('usage') ? `(s.usage->>'inputTokens')::int` : null),
    output_tokens: (src) => (src.has('usage') ? `(s.usage->>'outputTokens')::int` : null),
  },
};

/** Source → target cast. jsonb arrays become text[] element by element (classification_reasons, mismatches). */
function castExpr(col: string, from: string, to: string, toFormatted: string): string {
  const c = `s.${ident(col)}`;
  if (from === to) return c;
  if (from === 'jsonb' && to === '_text') {
    return `CASE WHEN ${c} IS NULL THEN NULL WHEN jsonb_typeof(${c}) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(${c}))
            ELSE ARRAY[${c} #>> '{}'] END`;
  }
  if (from === 'text' && to === '_text') {
    return `ARRAY(SELECT btrim(x) FROM unnest(string_to_array(${c}, ',')) AS x WHERE btrim(x) <> '')`;
  }
  return `${c}::${toFormatted}`;
}

async function relations(db: pg.ClientBase, schema: string) {
  // Extension members (pgcrypto's functions) and sequences owned by a column move with their owner, so they are left out.
  const { rows } = await db.query<{ name: string; kind: string }>(
    `SELECT c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S') AND c.relname <> 'schema_migrations'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e','a','i'))`,
    [schema],
  );
  const { rows: fns } = await db.query<{ sig: string }>(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.prokind = 'f'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`,
    [schema],
  );
  return { rels: rows, fns: fns.map((f) => f.sig) };
}

const KIND_SQL: Record<string, string> = {
  r: 'TABLE',
  p: 'TABLE',
  v: 'VIEW',
  m: 'MATERIALIZED VIEW',
  f: 'FOREIGN TABLE',
  S: 'SEQUENCE',
};

async function moveSchema(db: pg.ClientBase, from: string, to: string, only?: Set<string>): Promise<string[]> {
  const { rels, fns } = await relations(db, from);
  const moved: string[] = [];
  for (const r of rels) {
    if (only && !only.has(r.name)) continue;
    await db.query(`ALTER ${KIND_SQL[r.kind]} ${ident(from)}.${ident(r.name)} SET SCHEMA ${ident(to)}`);
    moved.push(r.name);
  }
  if (!only) {
    for (const sig of fns) {
      const [name, args] = [sig.slice(0, sig.indexOf('(')), sig.slice(sig.indexOf('('))];
      await db.query(`ALTER FUNCTION ${ident(from)}.${ident(name)}${args} SET SCHEMA ${ident(to)}`);
    }
  }
  return moved;
}

/** Copies every 001_schema table's rows from public into the build schema, mapping columns that changed shape. */
async function copyIntoBuild(db: pg.ClientBase): Promise<Record<string, number>> {
  const { rows: fks } = await db.query<{ tbl: string; name: string; def: string }>(
    `SELECT cl.relname AS tbl, co.conname AS name, pg_get_constraintdef(co.oid) AS def
     FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = $1 AND co.contype = 'f'`,
    [BUILD_SCHEMA],
  );
  // Foreign keys off while copying (submissions ↔ single_rating is a cycle), then re-added, which re-checks every row.
  for (const fk of fks)
    await db.query(`ALTER TABLE ${BUILD_SCHEMA}.${ident(fk.tbl)} DROP CONSTRAINT ${ident(fk.name)}`);

  const { rows: target } = await db.query<{
    table_name: string;
    column_name: string;
    udt_name: string;
    formatted: string;
    is_identity: string;
  }>(
    `SELECT c.table_name, c.column_name, c.udt_name, c.is_identity,
            format_type(a.atttypid, a.atttypmod) AS formatted
     FROM information_schema.columns c
     JOIN pg_attribute a ON a.attrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass AND a.attname = c.column_name
     WHERE c.table_schema = $1 ORDER BY c.table_name, c.ordinal_position`,
    [BUILD_SCHEMA],
  );
  const { rows: source } = await db.query<{ table_name: string; column_name: string; udt_name: string }>(
    `SELECT c.table_name, c.column_name, c.udt_name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
  );
  const src = new Map<string, Map<string, string>>();
  for (const c of source) src.set(c.table_name, (src.get(c.table_name) ?? new Map()).set(c.column_name, c.udt_name));

  const tables = new Map<string, typeof target>();
  for (const c of target) tables.set(c.table_name, [...(tables.get(c.table_name) ?? []), c]);
  const copied: Record<string, number> = {};
  for (const [table, cols] of tables) {
    const from = src.get(table);
    if (!from) continue; // new in 001_schema (single_rating, coverage_fees, …) or re-importable (lookup_rate_*, us_location_master)
    const srcCols = new Set(from.keys());
    const names: string[] = [];
    const exprs: string[] = [];
    for (const c of cols) {
      const derived = !from.has(c.column_name) ? DERIVED[table]?.[c.column_name]?.(srcCols) : null;
      if (from.has(c.column_name))
        exprs.push(castExpr(c.column_name, from.get(c.column_name)!, c.udt_name, c.formatted));
      else if (derived) exprs.push(derived);
      else continue; // the column's default applies
      names.push(ident(c.column_name));
    }
    const identity = cols.some((c) => c.is_identity === 'YES') ? ' OVERRIDING SYSTEM VALUE' : '';
    // Re-importable rate and ZIP rows may repeat a key 001_schema makes unique: the first copy of each is kept.
    const reimportable = table.startsWith('lookup_rate_') || table === 'us_location_master';
    const order = reimportable && from.has('id') ? ' ORDER BY s.id' : '';
    const onConflict = reimportable ? ' ON CONFLICT DO NOTHING' : '';
    try {
      const res = await db.query(
        `INSERT INTO ${BUILD_SCHEMA}.${ident(table)} (${names.join(', ')})${identity} SELECT ${exprs.join(', ')} FROM public.${ident(table)} s${order}${onConflict}`,
      );
      copied[table] = res.rowCount ?? 0;
    } catch (err) {
      throw new Error(`copying ${table}: ${(err as Error).message}`);
    }
  }

  for (const fk of fks) {
    try {
      await db.query(`ALTER TABLE ${BUILD_SCHEMA}.${ident(fk.tbl)} ADD CONSTRAINT ${ident(fk.name)} ${fk.def}`);
    } catch (err) {
      throw new Error(`legacy rows break ${fk.tbl}.${fk.name}: ${(err as Error).message}`);
    }
  }
  // Serial and identity sequences continue after the copied ids.
  const { rows: seqs } = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = $1 AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')`,
    [BUILD_SCHEMA],
  );
  for (const s of seqs) {
    await db.query(
      `SELECT setval(pg_get_serial_sequence($1, $2), m) FROM (SELECT max(${ident(s.column_name)}) AS m FROM ${BUILD_SCHEMA}.${ident(s.table_name)}) x WHERE m IS NOT NULL`,
      [`${BUILD_SCHEMA}.${s.table_name}`, s.column_name],
    );
  }
  return copied;
}

/**
 * Brings a database from any pre-squash state to exactly the 001_schema.sql shape, in one transaction:
 *  1. 001_schema.sql is built in a scratch schema.
 *  2. Already that shape (it ran every squashed migration): the scratch is dropped and leftover tables are moved aside.
 *  3. Otherwise every 001_schema table's rows are copied from public (jsonb arrays → text[], emails.signals → columns,
 *     usage → token columns), foreign keys re-checked, the old tables moved to schema legacy_pre_squash, and the new
 *     ones moved into public. Nothing is dropped: legacy_pre_squash keeps every old table, including HEAD's `quotes`
 *     (converted into single_rating by the legacy_quotes backfill) and rate_* / geo_* (re-imported on start from
 *     data/rates and Census/GeoNames by ensureRatesImported / ensureGeoImported).
 * Any error rolls everything back, so a failed upgrade leaves the database exactly as it was.
 */
async function convergeLegacy(reason: string): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const {
      rows: [legacy],
    } = await db.query(`SELECT to_regnamespace($1) AS oid`, [LEGACY_SCHEMA]);
    await db.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public`);
    await buildInScratch(db, BUILD_SCHEMA, [SCHEMA_FILE]);
    const { problems, extras } = diffShapes(await readShape(db, BUILD_SCHEMA), await readShape(db, 'public'));
    const extraTables = new Set(extras.filter((e) => e.startsWith('table ')).map((e) => e.slice(6)));
    const extraColumns = extras.filter((e) => e.startsWith('column '));
    if (legacy.oid && (problems.length || extraColumns.length || extraTables.size)) {
      throw new Error(
        `schema ${LEGACY_SCHEMA} already exists; check what it holds and rename or drop it, then start again`,
      );
    }
    const copiedPath = problems.length > 0 || extraColumns.length > 0;
    if (!copiedPath) {
      await db.query(`DROP SCHEMA ${BUILD_SCHEMA} CASCADE`);
      if (extraTables.size) {
        await db.query(`CREATE SCHEMA ${LEGACY_SCHEMA}`);
        await moveSchema(db, 'public', LEGACY_SCHEMA, extraTables);
      }
      logger.info(
        { reason, movedAside: [...extraTables] },
        'database already has the 001_schema.sql shape; recorded it',
      );
    } else {
      logger.warn(
        { reason, differences: problems.length + extraColumns.length },
        'converging legacy database to 001_schema.sql',
      );
      const copied = await copyIntoBuild(db);
      await db.query(`CREATE SCHEMA ${LEGACY_SCHEMA}`);
      const moved = await moveSchema(db, 'public', LEGACY_SCHEMA);
      await moveSchema(db, BUILD_SCHEMA, 'public');
      await db.query(`DROP SCHEMA ${BUILD_SCHEMA}`);
      logger.warn(
        { copied, legacySchema: LEGACY_SCHEMA, legacyTables: moved },
        `legacy database converged; old tables kept in schema ${LEGACY_SCHEMA} (drop it once the upgrade is verified)`,
      );
    }
    // Copied: public is now exactly 001_schema.sql, so every later SQL migration runs again. Adopted: it already was.
    await db.query(
      copiedPath
        ? `DELETE FROM schema_migrations WHERE name LIKE '%.sql'`
        : 'DELETE FROM schema_migrations WHERE name = ANY($1)',
      copiedPath ? [] : [[...SQUASHED_INTO_SCHEMA, ...FOLDED_INTO_SCHEMA_LATER, SCHEMA_FILE]],
    );
    await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [SCHEMA_FILE]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw new Error(
      `Upgrading the legacy database (${reason}) failed and was rolled back; the database is unchanged.\n` +
        `${(err as Error).message}\nSee README "Database migrations" (restore from the pre-deploy dump if needed).`,
    );
  } finally {
    db.release();
  }
}

/** Decides whether the database needs convergeLegacy() before the normal migration run. */
async function prepareLegacy(applied: Set<string>, files: string[]): Promise<void> {
  const folded = FOLDED_INTO_SCHEMA_LATER.filter((n) => applied.has(n));
  if (folded.length && applied.has(SCHEMA_FILE)) {
    await pool.query('DELETE FROM schema_migrations WHERE name = ANY($1)', [folded]);
    for (const n of folded) applied.delete(n);
  }
  const { rows } = await pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`,
  );
  const tables = new Set(rows.map((r) => r.name));

  if (!applied.has(SCHEMA_FILE)) {
    if (!tables.size) return; // empty database: 001_schema.sql runs as a normal migration
    const ours = SQUASHED_INTO_SCHEMA.some((n) => applied.has(n)) || folded.length > 0 || tables.has('submissions');
    if (!ours) {
      throw new Error(
        `The database has tables (${[...tables].slice(0, 10).join(', ')}) but no record of this app's migrations. ` +
          "Point DATABASE_URL at an empty database or at this app's database.",
      );
    }
    await convergeLegacy('migrated before 001_schema.sql');
  } else if (!files.some((f) => f > SCHEMA_FILE && applied.has(f))) {
    // 001_schema.sql recorded but nothing after it: an early copy of the file may have produced a different shape.
    const db = await pool.connect();
    let differences: string[] = [];
    try {
      const d = diffShapes(await expectedShape(db, [SCHEMA_FILE]), await readShape(db, 'public'));
      // Extra columns count too (a leftover NOT NULL column would break inserts); extra tables are left alone.
      differences = [...d.problems, ...d.extras.filter((e) => e.startsWith('column '))];
    } finally {
      db.release();
    }
    if (differences.length)
      await convergeLegacy(`001_schema.sql recorded but ${differences.length} difference(s) from it`);
  } else {
    return;
  }
  applied.clear();
  const { rows: now } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  for (const r of now) applied.add(r.name);
}

// ---- Migration run -------------------------------------------------------------------------------------------------

async function migrateLocked(): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  // Checksum of each applied file (NULL for backfills, which are code), so an edited migration is noticed.
  await pool.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
  const files = migrationFiles();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  await prepareLegacy(applied, files);
  const steps = [
    ...files.map((file) => ({ name: file, run: (db: pg.PoolClient) => db.query(readMigration(file)) })),
    ...BACKFILLS,
  ];
  const ran: string[] = [];
  for (const step of steps) {
    if (applied.has(step.name)) continue;
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      // DB-15: a migration that cannot get its table lock in time fails and rolls back (and the start with it) instead
      // of queueing every application query on that table behind it. SET LOCAL ends with the transaction.
      if (config.MIGRATION_LOCK_TIMEOUT_MS > 0)
        await client.query(`SET LOCAL lock_timeout = ${Math.trunc(config.MIGRATION_LOCK_TIMEOUT_MS)}`);
      await step.run(client);
      await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [
        step.name,
        files.includes(step.name) ? migrationChecksum(readMigration(step.name)) : null,
      ]);
      await client.query('COMMIT');
      ran.push(step.name);
    } catch (err) {
      // A failed ROLLBACK must not hide the migration error; that connection is then destroyed, not pooled.
      await client.query('ROLLBACK').catch((e: Error) => {
        broken = e;
      });
      throw new Error(`Migration ${step.name} failed and was rolled back: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release(broken);
    }
  }
  await verifyChecksums(files);
  await verifySchema(files);
  return ran;
}

/**
 * Applied migration files must not change: an edit never runs again, so the database silently differs from what the
 * file now says. Files recorded before checksums existed get theirs now (trusted as they are). A mismatch is logged,
 * and with MIGRATION_CHECKSUM_CHECK=fail it stops the start. Fix by reverting the edit and adding a new migration.
 */
async function verifyChecksums(files: string[]): Promise<void> {
  const { rows } = await pool.query<{ name: string; checksum: string | null }>(
    'SELECT name, checksum FROM schema_migrations WHERE name = ANY($1)',
    [files],
  );
  const changed: string[] = [];
  for (const r of rows) {
    const sum = migrationChecksum(readMigration(r.name));
    if (r.checksum === null)
      await pool.query('UPDATE schema_migrations SET checksum=$2 WHERE name=$1 AND checksum IS NULL', [r.name, sum]);
    else if (r.checksum !== sum) changed.push(r.name);
  }
  if (!changed.length) return;
  const message =
    `Applied migration file(s) changed since they ran: ${changed.join(', ')}. ` +
    'Revert the edit and put the change in a new migration.';
  if (config.MIGRATION_CHECKSUM_CHECK === 'fail') throw new Error(message);
  logger.error({ changed }, message);
}

/** Migration files and backfills not yet recorded as applied (readiness check: an instance must not serve before them). */
export async function pendingMigrations(db: Pick<pg.Pool, 'query'> = pool): Promise<string[]> {
  const { rows } = await db
    .query<{ name: string }>('SELECT name FROM schema_migrations')
    .catch(() => ({ rows: [] as { name: string }[] }));
  const applied = new Set(rows.map((r) => r.name));
  return [...migrationFiles(), ...BACKFILLS.map((b) => b.name)].filter((n) => !applied.has(n));
}

/** Applies pending migrations and backfills, holding a session advisory lock so two instances never migrate at once. */
/**
 * The database must be UTF8: emails, documents and some migration comments hold characters a Windows ANSI database
 * (WIN1252, the default of a Postgres cluster initialised on Windows) cannot store, and would fail part-way (QA-008).
 */
async function assertUtf8(db: Pick<pg.Pool, 'query'>): Promise<void> {
  const {
    rows: [r],
  } = await db.query<{ server_encoding: string }>('SHOW server_encoding');
  if (r?.server_encoding.toUpperCase() !== 'UTF8')
    throw new Error(
      `The database uses ${r?.server_encoding} encoding; it must be UTF8. Create it with ` +
        `"CREATE DATABASE <name> ENCODING 'UTF8' TEMPLATE template0" (or initdb -E UTF8) and run the migrations again.`,
    );
}

export async function migrate(): Promise<string[]> {
  await assertUtf8(pool);
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    return await migrateLocked();
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    lock.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  migrate()
    .then((ran) => {
      console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database up to date');
      return closePools();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
