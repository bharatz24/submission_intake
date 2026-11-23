/**
 * Quotes against a real PostgreSQL database (TEST_DATABASE_URL host, database ims_test_rating) with the rate
 * workbooks in data/rates. Field extraction is mocked so the submission has known rating fields; quotes are only
 * created when an underwriter asks for one.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Scripts (and these tests) ask for the session token in the login body; browsers get only the cookie.
const CLI = { 'X-Client': 'cli' };

vi.mock('../src/services/driveStorage.js', async (orig) =>
  (await import('./helpers/fakeDrive.js')).fakeDrive(await orig()),
);

const TEST_DB = (process.env.TEST_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_test').replace(
  /\/[^/]+$/,
  '/ims_test_rating',
);
process.env.DATABASE_URL = TEST_DB;

vi.mock('../src/services/claude.js', async () => ({
  claudeAvailable: () => true,
  claudeModel: () => 'mock-model',
  structuredCall: async () => ({
    model: 'mock-model',
    usage: { inputTokens: 1, outputTokens: 1 },
    data: {
      fields: [
        ['applicant_name', 'Jane Smith'],
        ['practice_location', '100 Congress Ave, Austin, TX 78701'],
        ['practice_state', 'TX'],
        ['specialty', 'Internal Medicine (60%)'],
        ['specialty', 'Cardiology (40%)'],
        ['surgery_type', 'No Surgery'],
        ['requested_limits', '$1M/$3M'],
        ['effective_date', '01/01/2027'],
        ['retroactive_date', '01/01/2024'],
        ['hours_per_week', '40'],
      ].map(([fieldName, value]) => ({
        fieldName,
        value,
        confidence: 0.9,
        evidenceQuote: value,
        sourceLabel: 'application.txt',
      })),
    },
  }),
}));

vi.mock('../src/services/npi.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/npi.js')>()),
  lookupNpi: vi.fn(async () => ({ found: false, result: null })),
}));

let app: import('express').Express;
let pool: pg.Pool;
let auth: Record<string, string> = {};
let viewer: Record<string, string> = {};
let submissionId = '';

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout; last value: ${JSON.stringify(v).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ims_test_rating WITH (FORCE)');
  await admin.query('CREATE DATABASE ims_test_rating');
  await admin.end();
  const { migrate } = await import('../src/db/migrate.js');
  await migrate();
  ({ pool } = await import('../src/db/pool.js'));
  await (await import('../src/services/rating/importer.js')).importRates('data/rates');
  await pool.query(
    `INSERT INTO us_location_master (zip_code, city, county, state_code, state_name) VALUES ('78701', 'Austin', 'Travis', 'TX', 'Texas')`,
  );
  app = (await import('../src/app.js')).createApp();

  await request(app)
    .post('/api/auth/register')
    .send({ email: 'uw@example.com', password: 'correct-horse-battery', name: 'Una Writer' });
  const login = await request(app)
    .post('/api/auth/login')
    .set(CLI)
    .send({ email: 'uw@example.com', password: 'correct-horse-battery' });
  auth = { Authorization: `Bearer ${login.body.token}` };
  const { signToken } = await import('../src/http.js');
  // Tokens are checked against the users table (revocation), so the viewer must exist.
  await pool.query(
    `INSERT INTO users (id, email, name, password_hash, role) VALUES ('00000000-0000-4000-8000-000000000001', 'v@example.com', 'Vic', 'x', 'VIEWER')`,
  );
  viewer = {
    Authorization: `Bearer ${signToken({ id: '00000000-0000-4000-8000-000000000001', email: 'v@example.com', name: 'Vic', role: 'VIEWER' })}`,
  };

  const res = await request(app)
    .post('/api/submissions/upload')
    .set(auth)
    .field('subject', 'New submission - Dr. Jane Smith internal medicine professional liability')
    .field('fromAddress', 'broker@acme.com')
    .field('bodyText', 'Please quote. Application attached.')
    .attach('files', Buffer.from('Applicant: Jane Smith\nInternal Medicine 60%, Cardiology 40%'), 'application.txt');
  submissionId = res.body.id;
  await waitFor(
    async () => (await request(app).get(`/api/submissions/${submissionId}`).set(auth)).body,
    (b) => b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR',
  );
});

afterAll(async () => {
  // Workers and the LISTEN connection first, so nothing touches the pool after it ends.
  await (await import('../src/services/jobQueue.js')).jobs.stop(5000);
  await (await import('../src/services/pgListen.js')).closeListener();
  if (pool) await (await import('../src/db/pool.js')).closePools();
});

describe('quotes', () => {
  it('rejects an impossible date instead of pricing a different one', async () => {
    const res = await request(app)
      .post(`/api/submissions/${submissionId}/quotes/preview`)
      .set(auth)
      .send({ inputs: { effectiveDate: '2027-02-30' } });
    expect(res.status).toBe(400);
  });

  it('never quotes on its own: processing a submission creates no quote', async () => {
    const res = await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('derives rating inputs from the extracted fields, with sources', async () => {
    const res = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.inputs).toMatchObject({
      state: 'TX',
      zip: '78701',
      city: 'Austin',
      specialities: [
        { title: 'Internal Medicine', practicePercent: 60, surgeryType: 'No Surgery' },
        { title: 'Cardiology', practicePercent: 40, surgeryType: 'No Surgery' },
      ],
      limit: { incident: 1_000_000, aggregate: 3_000_000 },
      effectiveDate: '2027-01-01',
      retroDate: '2024-01-01',
      expirationDate: '2028-01-01',
      hoursPerWeek: 40,
    });
    expect(res.body.sources.zip).toBe('practice_location (application.txt)');
    expect(res.body.sources.expirationDate).toBe('default: 1 year after effective date');
  });

  it('previews without saving, then saves versioned quotes on request', async () => {
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    const preview = await request(app)
      .post(`/api/submissions/${submissionId}/quotes/preview`)
      .set(auth)
      .send({ inputs });
    expect(preview.status).toBe(200);
    expect(preview.body.status).toBe('QUOTED');
    expect(preview.body.factors.location.county).toBe('Travis');
    expect(preview.body.summary.total).toBeGreaterThan(0);
    expect((await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body).toHaveLength(0);

    const q1 = await request(app)
      .post(`/api/submissions/${submissionId}/quotes`)
      .set(auth)
      .send({ inputs: { ...inputs, label: 'As submitted' } });
    expect(q1.status).toBe(201);
    expect(q1.body).toMatchObject({
      version: 1,
      status: 'QUOTED',
      label: 'As submitted',
      total: preview.body.summary.total,
    });
    expect(q1.body).not.toHaveProperty('sources');
    expect(q1.body.createdBy.name).toBe('Una Writer');

    const q2 = await request(app)
      .post(`/api/submissions/${submissionId}/quotes`)
      .set(auth)
      .send({ inputs: { ...inputs, uwCreditPercent: -10 } });
    expect(q2.body.version).toBe(2);
    expect(q2.body.premium).toBeLessThan(q1.body.premium);

    // The next dialog starts from the latest quote's underwriter choices.
    const next = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    expect(next.body.inputs.uwCreditPercent).toBe(-10);
    expect(next.body.sources.uwCreditPercent).toBe('quote v2');

    const audit = await request(app).get(`/api/submissions/${submissionId}/audit`).set(auth);
    expect(audit.body.items.filter((e: { action: string }) => e.action === 'QUOTE_CREATED')).toHaveLength(2);
  });

  it('stores quotes in the rating structure and reads them back unchanged', async () => {
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    const preview = await request(app)
      .post(`/api/submissions/${submissionId}/quotes/preview`)
      .set(auth)
      .send({ inputs });
    const list = (await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body;
    const [q2, q1] = list;
    // A saved quote keeps everything but the preview-only extras: other candidate classes and the ZIP's county list.
    const { zipCounties: _z, ...location } = preview.body.factors.location;
    const specialities = preview.body.factors.specialities.map(
      ({ candidates: _c, ...s }: Record<string, unknown>) => s,
    );
    expect(q2.factors).toEqual({ ...preview.body.factors, location, specialities });
    expect(q2.pricing).toEqual(preview.body.pricing);
    expect(q1.isPrimary).toBe(true);
    expect(q2.isPrimary).toBe(false);

    const {
      rows: [r],
    } = await pool.query('SELECT * FROM single_rating WHERE id=$1', [q1.id]);
    expect(r).toMatchObject({
      title: 'As submitted',
      location: 'TX',
      county: 'Travis',
      zipcode: '78701',
      retroyear: '4 Years',
      pickhighest: false,
      credittotal_percentage: 0,
    });
    // Money is numeric(14,2) (a string from pg) and the line items add up to the totals exactly, in cents.
    expect(r.premium).toMatch(/^\d+\.\d{2}$/);
    expect(Math.round((Number(r.premium) + Number(r.tax_total) + Number(r.feestotal)) * 100)).toBe(
      Math.round(Number(r.total) * 100),
    );
    expect(Number(r.premium)).toBe(q1.premium);
    expect(r.basemodifiertotal).toBeCloseTo(
      r.specialityfactor * r.setupfactor * r.territoryfactor * r.limits_factor * r.parttime_fulltime_factor,
      10,
    );
    const count = async (sql: string, id: string) => (await pool.query(sql, [id])).rowCount;
    expect(await count('SELECT 1 FROM specialities WHERE singlerating_id=$1', q1.id)).toBe(2);
    expect(await count('SELECT 1 FROM single_rating_tax WHERE rating_id=$1', q1.id)).toBe(2);
    expect(await count('SELECT 1 FROM Coverage_fees WHERE submission_id=$1', submissionId)).toBe(
      q1.factors.policyFees.length,
    );

    const set = await request(app)
      .put(`/api/submissions/${submissionId}/primary-rating`)
      .set(auth)
      .send({ ratingId: q2.id });
    expect(set.status).toBe(200);
    expect(set.body.find((q: { id: string }) => q.id === q2.id).isPrimary).toBe(true);
    const {
      rows: [s],
    } = await pool.query('SELECT primary_rating_id FROM submissions WHERE id=$1', [submissionId]);
    expect(s.primary_rating_id).toBe(q2.id);
    expect(
      (await request(app).put(`/api/submissions/${submissionId}/primary-rating`).set(viewer).send({ ratingId: q1.id }))
        .status,
    ).toBe(403);
  });

  it('gives the Analysis and chat the primary rating with each calculation step', async () => {
    const { quoteContext } = await import('../src/services/rating/quote.js');
    const text = await quoteContext(submissionId);
    const [q2] = (await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body;
    const money = (n: number) =>
      `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    expect(text).toContain('Quote v2 (primary rating): QUOTED');
    expect(text).toContain(`- Underwriter credit/debit -10% = ${money(q2.pricing.uwCredit.amount)}`);
    expect(text).toContain('Calculation:');
    expect(text).toContain(
      `- Base modifier total ${q2.pricing.baseModifierTotal} = speciality ${q2.factors.speciality} × step-up`,
    );
    expect(text).toContain(
      `- Premium ${money(q2.pricing.premium)} = scheduled premium ${money(q2.pricing.scheduledPremium)}`,
    );
    expect(text).toMatch(/Other saved versions: v1 QUOTED \$/);
  });

  it('saves an unpriceable rating as INCOMPLETE, never as $0', async () => {
    const res = await request(app)
      .post(`/api/submissions/${submissionId}/quotes`)
      .set(auth)
      .send({ inputs: { state: 'TX' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'INCOMPLETE', premium: null, total: null });
    expect(res.body.missing).toContain('Speciality');
  });

  it('lists priced speciality classes and rate options', async () => {
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    const opts = await request(app)
      .post(`/api/submissions/${submissionId}/speciality-options`)
      .set(auth)
      .send({ inputs, index: 1 });
    expect(opts.status).toBe(200);
    expect(opts.body.requested).toBe('Cardiology');
    expect(opts.body.options.length).toBeGreaterThan(0);
    const rates = await request(app).get('/api/rates/options?state=TX').set(auth);
    expect(rates.body.limits.length).toBeGreaterThan(0);
  });

  it('reports the active rate group and ZIP data for Settings', async () => {
    const res = await request(app).get('/api/rates/groups').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0]).toMatchObject({ isActive: true, name: expect.stringMatching(/^rates-/) });
    expect(res.body.groups[0]).not.toHaveProperty('files');
    expect(res.body.groups[0]).not.toHaveProperty('rowCounts');
    expect(res.body.geo).toEqual({ zips: 1, zipCounties: 1 });
  });

  it('keeps the policy fees each version was priced with', async () => {
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    const {
      rows: [pf],
    } = await pool.query('SELECT key, amount, required FROM lookup_rate_policy_fees LIMIT 1');
    await pool.query('UPDATE lookup_rate_policy_fees SET required = true WHERE key = $1', [pf.key]);
    try {
      const before = await request(app).post(`/api/submissions/${submissionId}/quotes`).set(auth).send({ inputs });
      const fee = before.body.factors.policyFees.find((f: { key: string }) => f.key === pf.key);
      expect(fee.amount).toBe(pf.amount);
      await pool.query('UPDATE lookup_rate_policy_fees SET amount = amount + 25 WHERE key = $1', [pf.key]);
      const after = await request(app).post(`/api/submissions/${submissionId}/quotes`).set(auth).send({ inputs });
      expect(after.body.factors.policyFees.find((f: { key: string }) => f.key === pf.key).amount).toBe(pf.amount + 25);
      // The older version still shows (and totals) the fee it was priced with, not the submission's current one.
      const list = (await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body;
      const old = list.find((q: { id: string }) => q.id === before.body.id);
      expect(old.factors.policyFees).toEqual(before.body.factors.policyFees);
      expect(old.pricing.policyFeesTotal).toBe(before.body.pricing.policyFeesTotal);
    } finally {
      await pool.query('UPDATE lookup_rate_policy_fees SET amount = $2, required = $3 WHERE key = $1', [
        pf.key,
        pf.amount,
        pf.required,
      ]);
    }
  });

  it('gives racing saves distinct versions instead of a 500', async () => {
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    const results = await Promise.all(
      [1, 2, 3].map(() => request(app).post(`/api/submissions/${submissionId}/quotes`).set(auth).send({ inputs })),
    );
    for (const r of results) expect([201, 409]).toContain(r.status);
    const versions = results.filter((r) => r.status === 201).map((r) => r.body.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.length).toBeGreaterThan(0);
  });

  it('revises a saved quote into a new version', async () => {
    const list = (await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body;
    const base = list.find((q: { version: number }) => q.version === 1);
    await request(app).put(`/api/submissions/${submissionId}/primary-rating`).set(auth).send({ ratingId: base.id });

    const res = await request(app)
      .post(`/api/submissions/${submissionId}/quotes`)
      .set(auth)
      .send({ inputs: { ...base.inputs, label: 'Revised', uwCreditPercent: -5 }, basedOn: base.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: list.length + 1, label: 'Revised', isPrimary: true });

    const again = (await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body;
    expect(again.find((q: { id: string }) => q.id === base.id).premium).toBe(base.premium);
    const audit = (await request(app).get(`/api/submissions/${submissionId}/audit`).set(auth)).body.items;
    expect(audit.find((e: { action: string }) => e.action === 'QUOTE_REVISED').details).toMatchObject({
      basedOnVersion: 1,
      version: res.body.version,
    });

    // Revising a quote that is not the primary one leaves the primary where it is.
    const v2 = again.find((q: { version: number }) => q.version === 2);
    const r2 = await request(app)
      .post(`/api/submissions/${submissionId}/quotes`)
      .set(auth)
      .send({ inputs: v2.inputs, basedOn: v2.id });
    expect(r2.status).toBe(201);
    expect(r2.body.isPrimary).toBe(false);

    // A quote id that is not this submission's is a 404 and saves nothing.
    const count = again.length + 1;
    const bad = await request(app)
      .post(`/api/submissions/${submissionId}/quotes`)
      .set(auth)
      .send({ inputs: base.inputs, basedOn: randomUUID() });
    expect(bad.status).toBe(404);
    expect((await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body).toHaveLength(count);

    // A class code the active rate tables no longer have saves an INCOMPLETE version saying so, never a $0 one.
    const stale = await request(app)
      .post(`/api/submissions/${submissionId}/quotes`)
      .set(auth)
      .send({ inputs: { ...base.inputs, specialities: [{ code: 'ZZZ99', practicePercent: 100 }] }, basedOn: v2.id });
    expect(stale.status).toBe(201);
    expect(stale.body).toMatchObject({ status: 'INCOMPLETE', total: null });
    expect(stale.body.missing.join(' ')).toMatch(/ZZZ99/);

    expect(
      (
        await request(app)
          .post(`/api/submissions/${submissionId}/quotes`)
          .set(viewer)
          .send({ inputs: base.inputs, basedOn: base.id })
      ).status,
    ).toBe(403);
  });

  it('saves an edit over the quote itself, keeping its id and version', async () => {
    const before = (await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body;
    const target = before.find((q: { status: string }) => q.status === 'QUOTED');
    const specs = async (id: string) =>
      (await pool.query('SELECT code FROM specialities WHERE singlerating_id=$1', [id])).rowCount;
    const childRows = await specs(target.id);

    const res = await request(app)
      .put(`/api/submissions/${submissionId}/quotes/${target.id}`)
      .set(auth)
      .send({ inputs: { ...target.inputs, label: 'Overwritten', uwCreditPercent: -15 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, version: target.version, label: 'Overwritten' });
    expect(res.body.premium).toBeLessThan(target.premium);

    // No version is added, and the child rows are replaced, not appended.
    const after = (await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body;
    expect(after).toHaveLength(before.length);
    expect(await specs(target.id)).toBe(childRows);
    const audit = (await request(app).get(`/api/submissions/${submissionId}/audit`).set(auth)).body.items;
    expect(audit.find((e: { action: string }) => e.action === 'QUOTE_UPDATED').details).toMatchObject({
      version: target.version,
      previous: { premium: target.premium, total: target.total },
    });

    // Another submission's quote id is a 404, and a viewer cannot overwrite.
    expect(
      (
        await request(app)
          .put(`/api/submissions/${submissionId}/quotes/${randomUUID()}`)
          .set(auth)
          .send({ inputs: target.inputs })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .put(`/api/submissions/${submissionId}/quotes/${target.id}`)
          .set(viewer)
          .send({ inputs: target.inputs })
      ).status,
    ).toBe(403);
  });

  it('prefills an edit with what was stated, not what the engine filled in', async () => {
    const [v1] = (await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body.slice(-1);
    expect(v1.factors.location.countySource).toBe('ZIP 78701');
    expect(v1.flags.some((f: string) => f.startsWith('Expiration date not stated'))).toBe(true);

    const res = await request(app).get(`/api/submissions/${submissionId}/quotes/${v1.id}/inputs`).set(auth);
    expect(res.status).toBe(200);
    // The ZIP's county is looked up again, so a changed ZIP rates in its own territory.
    expect(res.body.inputs).not.toHaveProperty('county');
    expect(res.body.inputs.zip).toBe('78701');
    // A defaulted date stays a default: unchanged, it is recomputed from the effective date.
    expect(res.body.inputs.expirationDate).toBe(v1.factors.dates.expirationDate);
    expect(res.body.sources.expirationDate).toMatch(/^default/);
    expect(res.body.sources.zip).toBe('quote v1');
    expect(res.body.inputs.label).toBe(v1.label);
    // The rate group the save will actually price with.
    expect(res.body.rateGroup).toBe(v1.rateGroup);

    expect(
      (await request(app).get(`/api/submissions/${submissionId}/quotes/${randomUUID()}/inputs`).set(auth)).status,
    ).toBe(404);
  });

  it('moves the primary to a revision only when it is priced and its quote is still primary', async () => {
    const { createQuote } = await import('../src/services/rating/quote.js');
    const list = (await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body;
    const quoted = list.filter((q: { status: string }) => q.status === 'QUOTED');
    const [a, b] = [quoted[quoted.length - 1], quoted[quoted.length - 2]];
    const primaryId = async () =>
      (await pool.query('SELECT primary_rating_id FROM submissions WHERE id=$1', [submissionId])).rows[0]
        .primary_rating_id;

    // Someone made b primary after the edit of a was opened: saving the edit of a leaves b primary.
    await request(app).put(`/api/submissions/${submissionId}/primary-rating`).set(auth).send({ ratingId: b.id });
    await createQuote(submissionId, a.inputs, null, { id: a.id, version: a.version, isPrimary: true } as never);
    expect(await primaryId()).toBe(b.id);

    // An edit of the primary that comes back INCOMPLETE does not displace the priced primary.
    const stale = await request(app)
      .post(`/api/submissions/${submissionId}/quotes`)
      .set(auth)
      .send({ inputs: { ...b.inputs, specialities: [{ code: 'ZZZ99', practicePercent: 100 }] }, basedOn: b.id });
    expect(stale.body.status).toBe('INCOMPLETE');
    expect(await primaryId()).toBe(b.id);
  });

  it('hides the quotes of a deleted submission', async () => {
    const {
      rows: [e],
    } = await pool.query(`INSERT INTO emails (from_address, received_at) VALUES ('x@example.com', now()) RETURNING id`);
    const {
      rows: [s],
    } = await pool.query(
      `INSERT INTO submissions (email_id, status, deleted_at) VALUES ($1, 'NOT_SUBMISSION', now()) RETURNING id`,
      [e.id],
    );
    expect((await request(app).get(`/api/submissions/${s.id}/quotes`).set(auth)).status).toBe(404);
  });

  it('lets a viewer read quotes but not create them', async () => {
    expect((await request(app).get(`/api/submissions/${submissionId}/quotes`).set(viewer)).status).toBe(200);
    expect(
      (await request(app).post(`/api/submissions/${submissionId}/quotes`).set(viewer).send({ inputs: {} })).status,
    ).toBe(403);
    expect((await request(app).post('/api/rates/import/Hours_Worked_Factor_Lookup').set(viewer)).status).toBe(403);
    expect((await request(app).post('/api/geo/import').set(viewer)).status).toBe(403);
  });

  it('imports one workbook as a new active rate group, copying the other tables and keeping the old group', async () => {
    const before = await request(app).get('/api/rates/groups').set(auth);
    const oldGroup = before.body.groups.find((g: { isActive: boolean }) => g.isActive).name;
    expect(before.body.workbooks).toHaveLength(13);
    const { readdirSync, readFileSync } = await import('node:fs');
    const name = readdirSync('data/rates').find((f) => f.startsWith('Hours_Worked_Factor_Lookup_'))!;
    const data = readFileSync(`data/rates/${name}`);

    expect(
      (await request(app).post('/api/rates/import/Hours_Worked_Factor_Lookup').set(viewer).attach('file', data, name))
        .status,
    ).toBe(403);
    const wrong = await request(app).post('/api/rates/import/State_Lookup').set(auth).attach('file', data, name);
    expect(wrong.status).toBe(422);
    expect((await request(app).post('/api/rates/import/Nope').set(auth).attach('file', data, name)).status).toBe(400);

    const res = await request(app)
      .post('/api/rates/import/Hours_Worked_Factor_Lookup')
      .set(auth)
      .attach('file', data, name);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      basedOn: oldGroup,
      workbook: 'Hours_Worked_Factor_Lookup',
      file: name,
      rateGroup: expect.stringMatching(/^rates-\d{4}-\d{2}-\d{2}-hours-worked-factor$/),
    });
    const again = await request(app)
      .post('/api/rates/import/Hours_Worked_Factor_Lookup')
      .set(auth)
      .attach('file', data, name);
    expect(again.body.rateGroup).toBe(`${res.body.rateGroup}-2`);

    const after = await request(app).get('/api/rates/groups').set(auth);
    expect(after.body.groups.map((g: { name: string; isActive: boolean }) => [g.name, g.isActive])).toEqual(
      expect.arrayContaining([
        [oldGroup, false],
        [res.body.rateGroup, false],
        [again.body.rateGroup, true],
      ]),
    );
    expect(after.body.workbooks).toEqual(before.body.workbooks);

    // Quotes still price with the new group.
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    expect(
      (await request(app).post(`/api/submissions/${submissionId}/quotes/preview`).set(auth).send({ inputs })).status,
    ).toBe(200);
  });

  it('exports a workbook of the active group that uploads back as the same rows', async () => {
    const res = await request(app)
      .get('/api/rates/export/Policy_Fees_Lookup')
      .set(viewer)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const name = decodeURIComponent(/filename="([^"]+)"/.exec(res.headers['content-disposition'])![1]!);
    expect(name).toMatch(/^Policy_Fees_Lookup_\d{4}-\d{2}-\d{2} \d{2}_\d{2}_\d{2}\.xlsx$/);
    const before = (await request(app).get('/api/rates/groups').set(auth)).body.workbooks;
    const up = await request(app)
      .post('/api/rates/import/Policy_Fees_Lookup')
      .set(auth)
      .attach('file', res.body as Buffer, name);
    expect(up.status).toBe(200);
    expect((await request(app).get('/api/rates/groups').set(auth)).body.workbooks).toEqual(before);
    expect((await request(app).get('/api/rates/export/Nope').set(auth)).status).toBe(400);
  });
});

describe('quotes never under-price or lose track of their rates', () => {
  it('prices a quote with no retro date at the effective date, flagged for the underwriter to confirm', async () => {
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    const { retroDate: _r, ...noRetro } = inputs;
    const res = await request(app)
      .post(`/api/submissions/${submissionId}/quotes/preview`)
      .set(auth)
      .send({ inputs: noRetro });
    expect(res.status).toBe(200);
    expect(res.body.missing.some((m: string) => m.startsWith('Retro date'))).toBe(false);
    expect(res.body.inputs.retroDate).toBe(res.body.inputs.effectiveDate);
    expect(res.body.factors.dates.retroYears).toBe(1);
    expect(res.body.sources.retroDate).toBe('default: same as effective date');
    expect(res.body.flags.filter((f: string) => f.startsWith('Retro date not stated'))).toHaveLength(1);
  });

  it('saving for a submission that does not exist is a 404, not a TypeError', async () => {
    const { saveRating } = await import('../src/services/rating/store.js');
    const { previewQuote } = await import('../src/services/rating/quote.js');
    const result = await previewQuote(submissionId, { state: 'TX' });
    await expect(saveRating(pool, randomUUID(), null, result, null)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps Coverage_fees as the primary rating's set: INCOMPLETE and non-primary saves leave it alone", async () => {
    const coverage = async () =>
      (
        await pool.query('SELECT key, title, amount FROM Coverage_fees WHERE submission_id=$1 ORDER BY key', [
          submissionId,
        ])
      ).rows;
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    const {
      rows: [pf],
    } = await pool.query('SELECT key, amount, required FROM lookup_rate_policy_fees LIMIT 1');
    const before = await coverage();
    await pool.query('UPDATE lookup_rate_policy_fees SET required = true, amount = amount + 7 WHERE key = $1', [
      pf.key,
    ]);
    try {
      expect(
        (
          await request(app)
            .post(`/api/submissions/${submissionId}/quotes`)
            .set(auth)
            .send({ inputs: { state: 'TX' } })
        ).body.status,
      ).toBe('INCOMPLETE');
      const other = await request(app).post(`/api/submissions/${submissionId}/quotes`).set(auth).send({ inputs });
      expect(other.body).toMatchObject({ status: 'QUOTED', isPrimary: false });
      expect(await coverage()).toEqual(before);

      // Making it primary brings its fees along.
      await request(app)
        .put(`/api/submissions/${submissionId}/primary-rating`)
        .set(auth)
        .send({ ratingId: other.body.id });
      const now = await coverage();
      expect(now.find((c: { key: string }) => c.key === pf.key)).toMatchObject({
        amount: (Number(pf.amount) + 7).toFixed(2),
      });
    } finally {
      await pool.query('UPDATE lookup_rate_policy_fees SET amount = $2, required = $3 WHERE key = $1', [
        pf.key,
        pf.amount,
        pf.required,
      ]);
    }
  });

  it('says so when a submission keeps its earlier rate group while newer rates are active', async () => {
    // The group the submission's latest quote used: earlier tests import workbooks, so it need not be the active one.
    const {
      rows: [earlier],
    } = await pool.query('SELECT rate_group FROM single_rating WHERE submission_id=$1 ORDER BY version DESC LIMIT 1', [
      submissionId,
    ]);
    const {
      rows: [active],
    } = await pool.query('SELECT name FROM lookup_rate_groups WHERE is_active');
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    await pool.query(`INSERT INTO lookup_rate_groups (name) VALUES ('rates-newer-test')`);
    await pool.query(`UPDATE lookup_rate_groups SET is_active = (name = 'rates-newer-test')`);
    try {
      const res = await request(app).post(`/api/submissions/${submissionId}/quotes/preview`).set(auth).send({ inputs });
      expect(res.body.rateGroup).toBe(earlier.rate_group);
      expect(res.body.flags).toContain(
        `Priced with rate group ${earlier.rate_group}, as this submission's earlier quotes; newer rates (rates-newer-test) are active for new submissions`,
      );
    } finally {
      await pool.query(`DELETE FROM lookup_rate_groups WHERE name = 'rates-newer-test'`);
      await pool.query('UPDATE lookup_rate_groups SET is_active = (name = $1)', [active.name]);
    }
  });
});

// Last, so the quotes they save do not shift the versions the tests above count.
describe('manual specialty factors', () => {
  it("rates a specialty no class matches with an underwriter's factor, never one that matches exactly", async () => {
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    const preview = (specialities: unknown[]) =>
      request(app)
        .post(`/api/submissions/${submissionId}/quotes/preview`)
        .set(auth)
        .send({ inputs: { ...inputs, specialities } });
    const odd = { title: 'Hyperbaric wound care', practicePercent: 100 };

    // Unmatched: unpriceable, and the message says what to do.
    const none = await preview([odd]);
    expect(none.body.status).toBe('INCOMPLETE');
    expect(none.body.missing.join(' ')).toMatch(/enter a manual factor with a reason/);

    // With a factor and a reason: priced with it, under the name as written, and flagged.
    const manual = { ...odd, manualFactor: 1.35, manualReason: 'Carrier agreed 1.35 by email' };
    const priced = await preview([manual]);
    expect(priced.body.status).toBe('QUOTED');
    expect(priced.body.factors.specialities[0]).toMatchObject({
      code: 'MANUAL',
      requested: 'Hyperbaric wound care',
      specialityClass: 1.35,
      manual: { reason: 'Carrier agreed 1.35 by email' },
    });
    expect(priced.body.factors.speciality).toBe(1.35);
    expect(priced.body.flags.join(' ')).toMatch(/Manual factor 1\.35 for specialty "Hyperbaric wound care"/);

    // Mixed with a table class: weighted by practice share like any other.
    const mixed = await preview([
      { ...manual, practicePercent: 50 },
      { title: 'Internal Medicine', surgeryType: 'No Surgery', practicePercent: 50 },
    ]);
    const table = mixed.body.factors.specialities[1].specialityClass;
    expect(mixed.body.factors.speciality).toBeCloseTo(0.675 + table / 2, 4);

    // An exact match always takes the rate table's factor.
    const exact = await preview([
      { title: 'Internal Medicine', practicePercent: 100, manualFactor: 2, manualReason: 'x' },
    ]);
    expect(exact.body.status).toBe('INCOMPLETE');
    expect(exact.body.missing.join(' ')).toMatch(/exactly, so it takes the rate table's factor/);

    // Saved: the audit trail records the factor, the reason and who entered it.
    const saved = await request(app)
      .post(`/api/submissions/${submissionId}/quotes`)
      .set(auth)
      .send({ inputs: { ...inputs, specialities: [manual] } });
    expect(saved.status).toBe(201);
    const audit = await request(app).get(`/api/submissions/${submissionId}/audit`).set(auth);
    const created = audit.body.items.find(
      (e: { action: string; entityId: string }) => e.action === 'QUOTE_CREATED' && e.entityId === saved.body.id,
    );
    expect(created.details.manualFactors).toEqual([
      { specialty: 'Hyperbaric wound care', factor: 1.35, reason: 'Carrier agreed 1.35 by email' },
    ]);
    // Read back from the stored rating, the reason is still there.
    const [back] = (await request(app).get(`/api/submissions/${submissionId}/quotes`).set(auth)).body.filter(
      (q: { id: string }) => q.id === saved.body.id,
    );
    expect(back.factors.specialities[0]).toMatchObject({
      code: 'MANUAL',
      specialityClass: 1.35,
      manual: { reason: 'Carrier agreed 1.35 by email' },
    });
  });

  it('rejects a manual factor out of range, without a reason, or beside a class code', async () => {
    const {
      body: { inputs },
    } = await request(app).get(`/api/submissions/${submissionId}/rating-inputs`).set(auth);
    for (const spec of [
      { title: 'Hyperbaric wound care', manualFactor: 135, manualReason: 'typo' },
      { title: 'Hyperbaric wound care', manualFactor: 1.35 },
      { title: 'Hyperbaric wound care', code: 'ZZZ99', manualFactor: 1.35, manualReason: 'x' },
    ]) {
      const res = await request(app)
        .post(`/api/submissions/${submissionId}/quotes/preview`)
        .set(auth)
        .send({ inputs: { ...inputs, specialities: [spec] } });
      expect(res.status, JSON.stringify(spec)).toBe(400);
    }
  });
});
