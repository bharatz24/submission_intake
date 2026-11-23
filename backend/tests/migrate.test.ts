/**
 * Upgrading databases in every known state to 001_schema.sql (db/migrate.ts) against a real PostgreSQL database
 * (TEST_DATABASE_URL host, database ims_test_migrate). The HEAD state is built from tests/fixtures/head-migrations,
 * copies of the committed 001_init … 020_rating_quotes migrations (git show c03183a:backend/src/db/migrations/…).
 * Each scenario resets the public schema, so one pool serves them all.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TEST_DB = (process.env.TEST_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_test').replace(
  /\/[^/]+$/,
  '/ims_test_migrate',
);
process.env.DATABASE_URL = TEST_DB;

const here = path.dirname(fileURLToPath(import.meta.url));
const HEAD_DIR = path.join(here, 'fixtures', 'head-migrations');
const HEAD_FILES = readdirSync(HEAD_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
/** Backfills HEAD recorded; the fingerprint one is named by version, so a bumped version reruns it, as in production. */
const HEAD_BACKFILLS = ['004_structured_names.backfill', '005_report_markdown_names.backfill'];

let db: pg.Client;
let migrate: typeof import('../src/db/migrate.js').migrate;
let pool: pg.Pool;

async function reset() {
  await db.query('DROP SCHEMA IF EXISTS legacy_pre_squash CASCADE');
  await db.query('DROP SCHEMA IF EXISTS ims_converge CASCADE');
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
}

/** A database exactly as HEAD's migrator left it, with `extra` names also recorded as applied. */
async function buildHead(extra: string[] = []) {
  await reset();
  await db.query(
    'CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const f of HEAD_FILES) {
    await db.query(readFileSync(path.join(HEAD_DIR, f), 'utf8'));
    await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
  }
  for (const n of [...HEAD_BACKFILLS, ...extra]) await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [n]);
}

const ids = {
  user: '11111111-1111-4111-8111-111111111111',
  email: '22222222-2222-4222-8222-222222222222',
  sub: '33333333-3333-4333-8333-333333333333',
  report: '44444444-4444-4444-8444-444444444444',
  quoted: '55555555-5555-4555-8555-555555555551',
  incomplete: '55555555-5555-4555-8555-555555555552',
  broken: '55555555-5555-4555-8555-555555555553',
};

const factors = {
  location: { zip: '78701', city: 'Austin', state: 'TX', county: 'Travis', countySource: 'ZIP 78701' },
  state: { state: 'TX', baseRate: 10000, domicileTaxRate: 1, stateTaxRate: 2.5, defense: 'Inside' },
  dates: { effectiveDate: '2027-01-01', expirationDate: '2028-01-01', retroDate: '2024-01-01', retroYears: 4 },
  stepUp: 0.8,
  specialities: [
    {
      requested: 'Internal Medicine',
      code: '80268',
      title: 'Internal Medicine',
      surgeryType: 'No Surgery',
      specialityClass: 1.2,
      practicePercent: 100,
      factorState: 'TX',
      matchedFrom: 'exact title (score 100)',
      candidates: [],
    },
  ],
  speciality: 1.2,
  territory: { territory: 1, factor: 1.1, county: 'Travis', matched: 'county' },
  limits: { key: 'L1', incidentLimit: 1000000, aggregateLimit: 3000000, factor: 1 },
  fte: { key: 'H1', title: '0-40', factor: 1 },
  scheduledCredits: [{ key: 'C1', title: 'CME', percent: -10, type: 'Credit', deductibleLabel: '' }],
  deductible: null,
  ratingFees: [{ key: 'F1', title: 'Fee', calculate: false, amount: 50, required: true }],
  policyFees: [{ key: 'P1', title: 'Policy fee', amount: 150 }],
};
const pricing = {
  baseModifierTotal: 1.056,
  scheduledPremium: 10560,
  scheduled: [{ title: 'CME', percent: -10, amount: -1056.0000001 }],
  uwCredit: { percent: 0, amount: 0 },
  creditTotal: -1056.0000001,
  premium: 9503.9999999,
  ratingFees: [{ title: 'Fee', amount: 50 }],
  ratingFeesTotal: 50,
  taxes: [
    { label: 'NC 1% Tax', rate: 1, amount: 95.04 },
    { label: 'TX 2.5% Tax', rate: 2.5, amount: 237.6 },
  ],
  taxTotal: 332.64,
  policyFeesTotal: 150,
  feesTotal: 200,
  total: 10036.64,
  combineTotal: 9886.64,
};

/** HEAD-shaped rows in every table whose shape changed, plus three quotes (priced, incomplete, unconvertible). */
async function seedHead() {
  await db.query(
    `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, 'uw@example.com', 'Una', 'x', 'UNDERWRITER')`,
    [ids.user],
  );
  await db.query(
    `INSERT INTO emails (id, gmail_message_id, from_address, subject, received_at, signals)
    VALUES ($1, 'g1', 'broker@acme.com', 'New submission', now(), '{"listUnsubscribe": true, "gmailCategory": "UPDATES", "precedence": "bulk"}')`,
    [ids.email],
  );
  await db.query(
    `INSERT INTO submissions (id, email_id, status, classification, classification_reasons)
    VALUES ($1, $2, 'READY_FOR_REVIEW', 'SUBMISSION', '["+3: subject says submission", "LLM: looks like one"]')`,
    [ids.sub, ids.email],
  );
  await db.query(
    `INSERT INTO npi_verifications (submission_id, npi, status, mismatches) VALUES ($1, '1234567890', 'MISMATCH', '["state differs"]')`,
    [ids.sub],
  );
  await db.query(
    `INSERT INTO reports (id, submission_id, kind, version, status, context_version, skill_name, skill_version, model, usage)
    VALUES ($1, $2, 'SYNTHESIS', 1, 'COMPLETED', 1, 'synthesis', '1.0', 'm', '{"inputTokens": 1200, "outputTokens": 300}')`,
    [ids.report, ids.sub],
  );
  await db.query(
    `INSERT INTO audit_events (submission_id, actor_type, action, entity_type) VALUES ($1, 'SYSTEM', 'INGESTED', 'submission')`,
    [ids.sub],
  );
  await db.query(`INSERT INTO rate_groups (name, is_active) VALUES ('rates-old', true)`);
  const quote = `INSERT INTO quotes (id, submission_id, version, label, status, rate_group, context_version, inputs, sources, factors,
    pricing, premium, total, flags, missing, created_by, created_at) VALUES ($1, $2, $3, $4, $5, 'rates-old', 1, $6, '{"state": "underwriter"}',
    $7, $8, $9, $10, $11, $12, $13, $14)`;
  await db.query(quote, [
    ids.incomplete,
    ids.sub,
    1,
    null,
    'INCOMPLETE',
    '{"state": "TX"}',
    '{}',
    null,
    null,
    null,
    '[]',
    '["Speciality"]',
    ids.user,
    '2026-01-01T00:00:00Z',
  ]);
  await db.query(quote, [
    ids.quoted,
    ids.sub,
    2,
    'As submitted',
    'QUOTED',
    JSON.stringify({ state: 'TX', uwCreditPercent: 0 }),
    JSON.stringify(factors),
    JSON.stringify(pricing),
    9504,
    10036.64,
    '["a flag"]',
    '[]',
    ids.user,
    '2026-01-02T00:00:00Z',
  ]);
  // QUOTED without pricing breaks single_rating's premium check: kept in the legacy table, never silently dropped.
  await db.query(quote, [
    ids.broken,
    ids.sub,
    3,
    null,
    'QUOTED',
    '{}',
    '{}',
    null,
    null,
    null,
    '[]',
    '[]',
    ids.user,
    '2026-01-03T00:00:00Z',
  ]);
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ims_test_migrate WITH (FORCE)');
  await admin.query('CREATE DATABASE ims_test_migrate');
  await admin.end();
  db = new pg.Client({ connectionString: TEST_DB });
  await db.connect();
  ({ migrate } = await import('../src/db/migrate.js'));
  ({ pool } = await import('../src/db/pool.js'));
});

afterAll(async () => {
  await db?.end();
  if (pool) await (await import('../src/db/pool.js')).closePools();
});

const applied = async () =>
  (await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
const udt = async (table: string, column: string) =>
  (
    await db.query(
      `SELECT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column],
    )
  ).rows[0]?.udt_name;

describe('empty database', () => {
  beforeEach(reset);

  it('builds 001_schema.sql and every later migration, and a second run does nothing', async () => {
    const ran = await migrate();
    expect(ran[0]).toBe('001_schema.sql');
    expect(ran).toContain('002_ims2_handoffs.sql');
    expect(await udt('single_rating', 'premium')).toBe('numeric');
    expect(await migrate()).toEqual([]);
  });

  it('records a checksum per migration file and refuses to start when an applied file changed', async () => {
    await migrate();
    const { rows } = await db.query(`SELECT name, checksum FROM schema_migrations WHERE name LIKE '%.sql'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum))).toBe(true);

    // Recorded before checksums existed: filled in on the next run, trusted as is.
    await db.query(`UPDATE schema_migrations SET checksum=NULL WHERE name='015_evidence_verified.sql'`);
    expect(await migrate()).toEqual([]);
    expect(
      (await db.query(`SELECT checksum FROM schema_migrations WHERE name='015_evidence_verified.sql'`)).rows[0]
        .checksum,
    ).toMatch(/^[0-9a-f]{64}$/);

    // The file no longer matches what ran (vitest.config.ts sets MIGRATION_CHECKSUM_CHECK=fail).
    await db.query(`UPDATE schema_migrations SET checksum=repeat('0', 64) WHERE name='015_evidence_verified.sql'`);
    await expect(migrate()).rejects.toThrow(/015_evidence_verified\.sql/);
  });

  it('keeps the audit trail append-only, TRUNCATE included', async () => {
    await migrate();
    await expect(db.query('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
  });

  it('carries the old report output limit into the three report limits, keeping limits already saved', async () => {
    await migrate();
    const step = '011_split_report_max_tokens.sql';
    const rerun = async () => {
      await db.query('DELETE FROM schema_migrations WHERE name=$1', [step]);
      expect(await migrate()).toEqual([step]);
    };
    const setting = async (key: string) =>
      (await db.query('SELECT value FROM app_settings WHERE key=$1', [key])).rows[0]?.value;

    // No limits saved yet: the row is created with the old value in all three.
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('anthropic_report_max_tokens', '40000')`);
    await rerun();
    expect(await setting('limits_settings')).toEqual({
      synthesisMaxTokens: 40000,
      analysisMaxTokens: 40000,
      comparisonMaxTokens: 40000,
    });
    expect(await setting('anthropic_report_max_tokens')).toBeUndefined();

    // Limits already saved: merged in, never overwriting a key that is there.
    await db.query(
      `UPDATE app_settings SET value='{"analysisMaxTokens": 50000, "uploadMaxFiles": 5}' WHERE key='limits_settings'`,
    );
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('anthropic_report_max_tokens', '45000')`);
    await rerun();
    const merged = {
      synthesisMaxTokens: 45000,
      analysisMaxTokens: 50000,
      comparisonMaxTokens: 45000,
      uploadMaxFiles: 5,
    };
    expect(await setting('limits_settings')).toEqual(merged);
    expect(await setting('anthropic_report_max_tokens')).toBeUndefined();

    // Nothing to carry over: the limits are left as they are.
    await rerun();
    expect(await setting('limits_settings')).toEqual(merged);
  });

  it('lets two migrators race: the advisory lock makes one wait, and nothing runs twice', async () => {
    const [a, b] = await Promise.all([migrate(), migrate()]);
    expect([...a, ...b].filter((n) => n === '001_schema.sql')).toHaveLength(1);
  });
});

describe('HEAD database (001_init … 020_rating_quotes applied)', () => {
  beforeAll(async () => {
    await buildHead();
    await seedHead();
    await migrate();
  });

  it('records 001_schema.sql in place of the squashed migrations', async () => {
    const names = await applied();
    expect(names).toContain('001_schema.sql');
    expect(names).toContain('legacy_quotes.backfill');
    for (const f of HEAD_FILES) expect(names).not.toContain(f);
    expect(names).toEqual(expect.arrayContaining(HEAD_BACKFILLS));
  });

  it('converts jsonb arrays to text[] and moved columns, keeping every value', async () => {
    expect(await udt('submissions', 'classification_reasons')).toBe('_text');
    expect(await udt('npi_verifications', 'mismatches')).toBe('_text');
    const {
      rows: [s],
    } = await db.query('SELECT classification_reasons FROM submissions WHERE id=$1', [ids.sub]);
    expect(s.classification_reasons).toEqual(['+3: subject says submission', 'LLM: looks like one']);
    const {
      rows: [n],
    } = await db.query('SELECT mismatches FROM npi_verifications WHERE submission_id=$1', [ids.sub]);
    expect(n.mismatches).toEqual(['state differs']);
    const {
      rows: [e],
    } = await db.query('SELECT list_unsubscribe, gmail_category, precedence, auto_submitted FROM emails WHERE id=$1', [
      ids.email,
    ]);
    expect(e).toEqual({ list_unsubscribe: true, gmail_category: 'UPDATES', precedence: 'bulk', auto_submitted: null });
    const {
      rows: [r],
    } = await db.query('SELECT input_tokens, output_tokens FROM reports WHERE id=$1', [ids.report]);
    expect(r).toEqual({ input_tokens: 1200, output_tokens: 300 });
  });

  it('keeps sequences going after the copied ids', async () => {
    const {
      rows: [before],
    } = await db.query('SELECT max(id)::int AS m FROM audit_events');
    const {
      rows: [ins],
    } = await db.query(
      `INSERT INTO audit_events (actor_type, action, entity_type) VALUES ('SYSTEM', 'X', 'test') RETURNING id::int`,
    );
    expect(ins.id).toBeGreaterThan(before.m);
  });

  it('converts HEAD quotes into single_rating with their child rows and fees; the unconvertible one stays in the legacy table', async () => {
    const { rows } = await db.query(
      'SELECT id, version, status, title, premium, total, rate_group, policy_fees_stored, created_at FROM single_rating ORDER BY version',
    );
    expect(rows.map((r) => [r.id, r.version, r.status])).toEqual([
      [ids.incomplete, 1, 'INCOMPLETE'],
      [ids.quoted, 2, 'QUOTED'],
    ]);
    expect(rows[1]).toMatchObject({
      title: 'As submitted',
      premium: '9504.00',
      total: '10036.64',
      rate_group: 'rates-old',
      policy_fees_stored: true,
    });
    expect(new Date(rows[1].created_at).toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect((await db.query('SELECT 1 FROM specialities WHERE singlerating_id=$1', [ids.quoted])).rowCount).toBe(1);
    expect((await db.query('SELECT 1 FROM single_rating_tax WHERE rating_id=$1', [ids.quoted])).rowCount).toBe(2);
    expect(
      (await db.query('SELECT amount FROM single_rating_policy_fees WHERE rating_id=$1', [ids.quoted])).rows,
    ).toEqual([{ amount: '150.00' }]);
    const {
      rows: [s],
    } = await db.query('SELECT primary_rating_id FROM submissions WHERE id=$1', [ids.sub]);
    expect(s.primary_rating_id).toBe(ids.quoted);
    // The submission's current fees: its latest converted rating's (v3 was not converted).
    expect((await db.query('SELECT title, amount FROM coverage_fees WHERE submission_id=$1', [ids.sub])).rows).toEqual([
      { title: 'Policy fee', amount: '150.00' },
    ]);
    const { rows: legacy } = await db.query('SELECT id FROM legacy_pre_squash.quotes ORDER BY version');
    expect(legacy.map((r) => r.id)).toEqual([ids.incomplete, ids.quoted, ids.broken]);
  });

  it('reads a converted quote back as numbers through the API shape', async () => {
    const { loadQuotes } = await import('../src/services/rating/store.js');
    const [q] = await loadQuotes({ id: ids.quoted });
    expect(q).toMatchObject({
      version: 2,
      status: 'QUOTED',
      premium: 9504,
      total: 10036.64,
      isPrimary: true,
      flags: ['a flag'],
    });
    expect(q!.pricing!.premium).toBe(9504);
    expect(q!.pricing!.scheduled[0]!.amount).toBe(-1056);
    expect(q!.factors.policyFees).toEqual([{ key: 'P1', title: 'Policy fee', amount: 150 }]);
  });

  it('moves every old table aside instead of dropping it, and rate/geo data is left to re-import', async () => {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='legacy_pre_squash'`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(['quotes', 'rate_groups', 'geo_zips', 'submissions', 'audit_events']));
    expect((await db.query('SELECT count(*)::int AS n FROM lookup_rate_groups')).rows[0].n).toBe(0);
    expect(await udt('quotes', 'id')).toBeUndefined();
  });

  it('is idempotent', async () => {
    expect(await migrate()).toEqual([]);
  });
});

describe('other legacy states', () => {
  it('converges a HEAD database that also recorded the local-only 021–024 and 002 migrations', async () => {
    await buildHead(['021_single_rating.sql', '022_us_location_master.sql', '002_minimize.sql']);
    await seedHead();
    await migrate();
    const names = await applied();
    expect(names).toContain('001_schema.sql');
    expect(names).not.toContain('021_single_rating.sql');
    expect(names).not.toContain('002_minimize.sql');
    expect((await db.query('SELECT count(*)::int AS n FROM single_rating')).rows[0].n).toBe(2);
  });

  it('adopts a database that already has the 001_schema.sql shape (it ran every squashed migration) without copying', async () => {
    await reset();
    await db.query(
      'CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await db.query(readFileSync(path.join(here, '..', 'src', 'db', 'migrations', '001_schema.sql'), 'utf8'));
    const { SQUASHED_INTO_SCHEMA } = await import('../src/db/migrate.js');
    await db.query('INSERT INTO schema_migrations(name) SELECT unnest($1::text[])', [
      [...SQUASHED_INTO_SCHEMA, '002_drop_rate_group_files.sql'],
    ]);
    await db.query(`INSERT INTO users (email, name, password_hash, role) VALUES ('a@example.com', 'A', 'x', 'ADMIN')`);
    const ran = await migrate();
    expect(ran).not.toContain('001_schema.sql');
    const names = await applied();
    expect(names).toContain('001_schema.sql');
    for (const n of SQUASHED_INTO_SCHEMA) expect(names).not.toContain(n);
    expect((await db.query(`SELECT to_regnamespace('legacy_pre_squash') AS s`)).rows[0].s).toBeNull();
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
  });

  it('adopts a database that ran 001_schema.sql and the files later folded into it, without copying', async () => {
    await reset();
    await db.query(
      'CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await db.query(readFileSync(path.join(here, '..', 'src', 'db', 'migrations', '001_schema.sql'), 'utf8'));
    const folded = ['002_rating_money.sql', '010_auth.sql', '011_jobs.sql', '012_outbound.sql'];
    await db.query('INSERT INTO schema_migrations(name) SELECT unnest($1::text[])', [['001_schema.sql', ...folded]]);
    const ran = await migrate();
    // Nothing folded runs again; only migrations newer than the squash do.
    // Every file after 001_schema.sql, in order (read from the folder, so a new migration needs no edit here).
    const later = readdirSync(path.join(here, '..', 'src', 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql') && f !== '001_schema.sql')
      .sort();
    expect(later.slice(0, 3)).toEqual(['002_ims2_handoffs.sql', '003_quote_task.sql', '004_skipped_emails.sql']);
    expect(ran.filter((n) => n.endsWith('.sql'))).toEqual(later);
    const names = await applied();
    for (const n of folded) expect(names).not.toContain(n);
    expect((await db.query(`SELECT to_regnamespace('legacy_pre_squash') AS s`)).rows[0].s).toBeNull();
  });

  it('re-converges a database whose 001_schema.sql was an earlier, different copy', async () => {
    await reset();
    await db.query(
      'CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await db.query(readFileSync(path.join(here, '..', 'src', 'db', 'migrations', '001_schema.sql'), 'utf8'));
    await db.query(`INSERT INTO schema_migrations(name) VALUES ('001_schema.sql')`);
    await db.query('ALTER TABLE emails ADD COLUMN signals jsonb'); // what an early copy still had
    await migrate();
    expect(await udt('emails', 'signals')).toBeUndefined();
    expect((await db.query(`SELECT to_regclass('legacy_pre_squash.emails') AS t`)).rows[0].t).not.toBeNull();
  });

  it('refuses a database with foreign tables and no record of this app', async () => {
    await reset();
    await db.query('CREATE TABLE someone_elses (id int)');
    await expect(migrate()).rejects.toThrow(/no record of this app's migrations/);
  });

  it('fails fast, naming the difference, when the schema drifted from the migrations', async () => {
    await reset();
    await migrate();
    await db.query('ALTER TABLE single_rating DROP COLUMN combine_total');
    await expect(migrate()).rejects.toThrow(/column single_rating.combine_total is missing/);
  });

  it('rolls a failed upgrade back, leaving the legacy database unchanged', async () => {
    await buildHead();
    await seedHead();
    // A duplicate HEAD never prevented: breaks 001_schema's unique npi index during the copy.
    await db.query('DROP INDEX npi_submission_npi_uniq');
    await db.query(`INSERT INTO npi_verifications (submission_id, npi, status) VALUES ($1, '1234567890', 'MATCH')`, [
      ids.sub,
    ]);
    await expect(migrate()).rejects.toThrow(/rolled back; the database is unchanged/);
    expect(await applied()).toContain('020_rating_quotes.sql');
    expect(await udt('quotes', 'id')).toBe('uuid');
    expect((await db.query(`SELECT to_regnamespace('legacy_pre_squash') AS s`)).rows[0].s).toBeNull();
  });
});
