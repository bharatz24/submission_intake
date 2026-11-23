/**
 * Hand-off to IMS 2's Submission Intake queue (modules/ims2) against a real PostgreSQL database
 * (TEST_DATABASE_URL host, database ims_test_ims2q) and a fake queue API that keeps IMS 2's rules: bearer token,
 * insert / update / reopen / replay by intakeId + version + content, 409 linked / stale / version_reused with the
 * current status, 400 with `field`, and status read singly or in pages ordered by statusChangedAt (`since` exclusive).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Scripts (and these tests) ask for the session token in the login body; browsers get only the cookie.
const CLI = { 'X-Client': 'cli' };

const TEST_DB = (process.env.TEST_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_test').replace(
  /\/[^/]+$/,
  '/ims_test_ims2q',
);
process.env.DATABASE_URL = TEST_DB;
const TOKEN = 'queue-test-token';

// ---- Fake IMS 2 queue ---------------------------------------------------------------------------------------------

interface Intake {
  intakeId: string;
  version: number;
  hash: string;
  status: 'new' | 'linked' | 'rejected';
  statusChangedAt: string;
  submissionId: number | null;
  rejectedReason: string | null;
  policyNumber: string | null;
}
interface Received {
  method: string;
  url: string;
  auth: string | undefined;
  body: any;
}
const received: Received[] = [];
const intakes = new Map<string, Intake>();
/** Answer the next push with this instead of IMS 2's normal rules. */
let override: { status: number; body: unknown } | null = null;
let clock = Date.parse('2026-11-04T10:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();
let pageSize = 500;

const statusOf = (i: Intake) => ({
  intakeId: i.intakeId,
  version: i.version,
  status: i.status,
  statusChangedAt: i.statusChangedAt,
  submissionId: i.submissionId,
  submissionNumber: i.submissionId ? `sub-${i.submissionId}` : null,
  url: i.submissionId ? `/policy-log/${i.submissionId}` : null,
  workflowStatus: i.submissionId ? 'open' : null,
  policyNumber: i.policyNumber,
  insuredId: i.submissionId ? 'insured-42' : null,
  linkedAt: null,
  rejectedReason: i.rejectedReason,
  rejectedAt: null,
});
const hashOf = (b: any) => JSON.stringify({ ...b, version: undefined });

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    received.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'Invalid or missing token' });
    const url = new URL(req.url!, 'http://x');
    const path = url.pathname.replace(/^\/api\/submission-intake/, '');
    if (req.method === 'GET' && path === '/lookup') {
      if (![...url.searchParams.keys()].length) return send(400, { error: 'Give at least one lookup parameter' });
      const name = url.searchParams.get('brokerName') ?? '';
      return send(200, {
        insureds:
          url.searchParams.get('npi') === '1234567893'
            ? [
                {
                  insuredId: 'insured-42',
                  canonicalName: 'Jane Smith',
                  insuredType: 'individual',
                  npi: '1234567893',
                  email: null,
                  licenseNumber: null,
                  status: 'active',
                  matchedOn: ['npi'],
                },
                {
                  insuredId: 'insured-43',
                  canonicalName: 'Jane Smith MD',
                  insuredType: 'individual',
                  npi: '1234567893',
                  email: null,
                  licenseNumber: null,
                  status: 'inactive',
                  matchedOn: ['npi'],
                },
              ]
            : [],
        brokers: /acme/i.test(name)
          ? [
              {
                id: 12,
                brokerCode: 'ACME',
                brokerName: 'Acme Brokers',
                shortName: 'Acme',
                active: true,
                matchedOn: ['brokerName'],
              },
              {
                id: 13,
                brokerCode: 'ACM2',
                brokerName: 'Acme Old',
                shortName: null,
                active: false,
                matchedOn: ['brokerName'],
              },
            ]
          : [],
      });
    }
    if (req.method === 'POST' && path === '/inbox') {
      if (override) {
        const o = override;
        override = null;
        return send(o.status, o.body);
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(body.intakeId)) return send(400, { error: 'bad intakeId', field: 'intakeId' });
      if ((body.receivedAt && !/(Z|[+-]\d{2}:\d{2})$/.test(body.receivedAt)) || /\s/.test(body.receivedAt ?? ''))
        return send(400, { error: 'Invalid datetime', field: 'receivedAt' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.policy?.effectiveDate ?? ''))
        return send(400, { error: 'must be a real date', field: 'policy.effectiveDate' });
      if (Object.values(body.policy).includes(null))
        return send(400, { error: 'Expected string, received null', field: 'policy' });
      const h = hashOf(body);
      const cur = intakes.get(body.intakeId);
      const conflict = (code: string) => send(409, { error: code, code, status: statusOf(cur!) });
      if (!cur) {
        intakes.set(body.intakeId, {
          intakeId: body.intakeId,
          version: body.version,
          hash: h,
          status: 'new',
          statusChangedAt: tick(),
          submissionId: null,
          rejectedReason: null,
          policyNumber: null,
        });
        return send(201, { intakeId: body.intakeId, version: body.version, status: 'new' });
      }
      if (cur.status === 'linked') return conflict('linked');
      if (body.version < cur.version) return conflict('stale');
      if (body.version === cur.version) {
        if (cur.hash !== h) return conflict('version_reused');
        return send(200, { intakeId: body.intakeId, version: body.version, status: cur.status, replayed: true });
      }
      const reopened = cur.status === 'rejected';
      Object.assign(cur, {
        version: body.version,
        hash: h,
        status: 'new',
        rejectedReason: null,
        ...(reopened ? { statusChangedAt: tick() } : {}),
      });
      return send(200, {
        intakeId: body.intakeId,
        version: body.version,
        status: 'new',
        ...(reopened ? { reopened: true } : { updated: true }),
      });
    }
    if (req.method === 'GET' && path === '/inbox/status') {
      const since = url.searchParams.get('since');
      const ids = url.searchParams.get('ids')?.split(',');
      const cursor = url.searchParams.get('cursor');
      let all = [...intakes.values()].sort(
        (a, b) => a.statusChangedAt.localeCompare(b.statusChangedAt) || a.intakeId.localeCompare(b.intakeId),
      );
      if (since) all = all.filter((i) => i.statusChangedAt > since);
      if (ids) all = all.filter((i) => ids.includes(i.intakeId));
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + pageSize);
      return send(200, {
        items: page.map(statusOf),
        nextCursor: start + pageSize < all.length ? String(start + pageSize) : null,
      });
    }
    const one = /^\/inbox\/([^/]+)\/status$/.exec(path);
    if (req.method === 'GET' && one) {
      const i = intakes.get(decodeURIComponent(one[1]!));
      return i ? send(200, statusOf(i)) : send(404, { error: 'Intake not found' });
    }
    send(404, { error: 'not found' });
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
// The queue URL and token are saved in Settings → IMS 2 intake (beforeAll), not the environment.
const QUEUE_BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/api/submission-intake`;
process.env.IMS2_APP_URL = 'https://ims2.example.com';

/** What an IMS 2 user does in the queue. */
const link = (intakeId: string, submissionId: number) =>
  Object.assign(intakes.get(intakeId)!, { status: 'linked', submissionId, statusChangedAt: tick() });
const reject = (intakeId: string, reason: string) =>
  Object.assign(intakes.get(intakeId)!, { status: 'rejected', rejectedReason: reason, statusChangedAt: tick() });

// ---- App ----------------------------------------------------------------------------------------------------------

let app: import('express').Express;
let pool: pg.Pool;
let auth: Record<string, string> = {};

async function seedSubmission(fields: [string, string][]): Promise<string> {
  const {
    rows: [e],
  } = await pool.query(
    `INSERT INTO emails (from_address, subject, received_at) VALUES ('Bob Broker <bob@acme.com>', 'New submission', '2026-11-02T15:00:00Z') RETURNING id`,
  );
  const {
    rows: [s],
  } = await pool.query(
    `INSERT INTO submissions (email_id, status, classification, applicant_name, applicant_type, applicant_first_name, applicant_last_name, context_version)
     VALUES ($1, 'READY_FOR_REVIEW', 'SUBMISSION', 'Jane Smith', 'INDIVIDUAL', 'Jane', 'Smith', 1) RETURNING id`,
    [e.id],
  );
  for (const [name, value] of fields) {
    await pool.query(
      `INSERT INTO extracted_fields (submission_id, field_name, value, confidence, source_label, context_version) VALUES ($1,$2,$3,0.9,'application.pdf',1)`,
      [s.id, name, value],
    );
  }
  return s.id;
}

/**
 * Records an Accept decision directly: the API would need a priced primary quote first (modules.test.ts covers that
 * rule), and a seeded quote would change what these tests send to IMS 2.
 */
const accept = (id: string) =>
  pool.query(
    `INSERT INTO assessments (submission_id, version, decision, risk_rating, notes, context_version, created_by)
     SELECT $1, COALESCE((SELECT max(version) FROM assessments WHERE submission_id=$1), 0) + 1, 'ACCEPT', 'LOW',
            'Accepted for testing purposes', 1, u.id FROM users u WHERE u.email='uw@example.com'`,
    [id],
  );

const FIELDS: [string, string][] = [
  ['effective_date', '12/01/2026'],
  ['expiration_date', '12/01/2027'],
  ['practice_state', 'TX'],
  ['specialty', 'Internal Medicine (60%)'],
  ['practice_zip', '77002'],
  ['practice_location', '1 Main St, Houston, TX 77002'],
  ['transaction_type', 'New business'],
  ['npi', '1234567893'],
  ['contact_name', 'Ann Roe'],
  ['contact_email', 'ann@example.com'],
  ['contact_phone', '713-555-0100'],
  ['broker_name', 'Debbie Gass, Acme Brokers'],
];

async function reviewedForm(id: string, patch: (f: any) => void = () => undefined) {
  const { body } = await request(app).get(`/api/submissions/${id}/ims2-queue`).set(auth);
  const form = structuredClone(body.defaults.form);
  patch(form);
  return form;
}
const sendForm = (id: string, form: unknown) =>
  request(app).post(`/api/submissions/${id}/ims2-queue/send`).set(auth).send(form);
const pushes = () => received.filter((r) => r.method === 'POST');
/** POST /ims2-queue/sync answers 202 (PERF-01): start it, wait for the background run, return the stored result. */
async function syncNow() {
  const res = await request(app).post('/api/ims2-queue/sync').set(auth);
  expect(res.status).toBe(202);
  const { drainBackground } = await import('../src/services/backgroundTasks.js');
  await drainBackground(20_000);
  const info = (await request(app).get('/api/ims2-queue/sync').set(auth)).body;
  expect(info.lastSync.at >= res.body.since).toBe(true);
  return info.lastSync;
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ims_test_ims2q WITH (FORCE)');
  await admin.query('CREATE DATABASE ims_test_ims2q');
  await admin.end();
  await (await import('../src/db/migrate.js')).migrate();
  ({ pool } = await import('../src/db/pool.js'));
  const { encrypt } = await import('../src/services/crypto.js');
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('ims2_intake_queue_base', $1), ('submission_intake_token', $2)`,
    [JSON.stringify(QUEUE_BASE), JSON.stringify(encrypt(TOKEN))],
  );
  await (await import('../src/services/ims2QueueSettings.js')).refreshIms2QueueSettings();
  app = (await import('../src/app.js')).createApp();
  await request(app)
    .post('/api/auth/register')
    .send({ email: 'uw@example.com', password: 'correct-horse-battery', name: 'Una Writer' });
  const login = await request(app)
    .post('/api/auth/login')
    .set(CLI)
    .send({ email: 'uw@example.com', password: 'correct-horse-battery' });
  auth = { Authorization: `Bearer ${login.body.token}` };
});

afterAll(async () => {
  if (pool) await (await import('../src/db/pool.js')).closePools();
  await new Promise((r) => fake.close(r));
});

beforeEach(() => {
  received.length = 0;
  override = null;
  pageSize = 500;
});

describe('error messages', () => {
  it('says why IMS 2 could not be reached, and which side needs the token', async () => {
    const { unreachable, explainNotConfigured } = await import('../src/services/ims2.js');
    const closed = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
    });
    expect(unreachable(closed).message).toMatch(
      /closed without an answer: check the URL points at the IMS 2 app, not its database/,
    );
    expect(
      unreachable(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })).message,
    ).toMatch(/connection refused/);
    expect(
      unreachable(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EOTHER', message: 'boom' } })).message,
    ).toBe('IMS 2 could not be reached (boom)');
    expect(
      explainNotConfigured(503, { error: 'Submission intake is not configured' }, 'SUBMISSION_INTAKE_TOKEN').error,
    ).toMatch(/set SUBMISSION_INTAKE_TOKEN in IMS 2's \.env/);
    expect(explainNotConfigured(503, { error: 'Down for maintenance' }, 'SUBMISSION_INTAKE_TOKEN').error).toBe(
      'Down for maintenance',
    );
  });
});

describe('broker names to look up', () => {
  it('tries the agency part first, then the whole name, then the email domain; never our own domain', async () => {
    const { brokerCandidates } = await import('../src/services/intakeDraft.js');
    const own = new Set(['entrust-us.com']);
    expect(brokerCandidates('Debbie Gass, CRC Specialty', 'Debbie.Gass@crcgroup.com', own)).toEqual([
      'CRC Specialty',
      'Debbie Gass, CRC Specialty',
      'crcgroup',
    ]);
    expect(
      brokerCandidates('Nordia Ramirez, Jabri Business (Consulting and Insurance)', 'nordia@jabribusiness.com', own),
    ).toEqual(['Jabri Business', 'Nordia Ramirez, Jabri Business', 'jabribusiness']);
    expect(brokerCandidates('B Haratz', 'bharatz@entrust-us.com', own)).toEqual(['B Haratz']);
    expect(brokerCandidates(null, 'someone@gmail.com', own)).toEqual([]);
  });
});

describe('prefill and lookup', () => {
  it('fills city, state, business and record type, insured email and contact from what was parsed', async () => {
    await pool.query(
      `INSERT INTO us_location_master (zip_code, city, county, state_code, state_name) VALUES ('78701', 'Austin', 'Travis', 'TX', 'Texas')`,
    );
    // No practice_state, no city in the address, no contact_name: ZIP table, address and applicant fill them in.
    const id = await seedSubmission([
      ['effective_date', 'Dec 1, 2026'],
      ['practice_zip', '78701'],
      ['practice_location', '100 Congress Ave'],
      ['transaction_type', 'ERP / tail'],
      ['application_form', 'DPLRRG renewal application, signed'],
      ['contact_email', 'jane@smithmd.com'],
      ['contact_phone', '(512) 555-0100'],
    ]);
    const { body } = await request(app).get(`/api/submissions/${id}/ims2-queue`).set(auth);
    expect(body.defaults.form.policy).toMatchObject({
      effectiveDate: '2026-12-01',
      businessType: 'renewal',
      recordType: 'POL-TL',
      state: 'TX',
      city: 'Austin',
    });
    expect(body.defaults.sources).toMatchObject({
      businessType: { from: 'application_form' },
      city: { from: 'ZIP lookup' },
    });
    expect(body.defaults.form.insured.create.email).toBe('jane@smithmd.com');
    expect(body.defaults.form.location).toMatchObject({ city: 'Austin', state: 'TX', zipcode: '78701' });
    expect(body.defaults.form.contact).toEqual({
      name: 'Jane Smith',
      email: 'jane@smithmd.com',
      phone: '(512) 555-0100',
    });

    // A full address names its own city and state.
    const id2 = await seedSubmission([['practice_location', '1 Main St, Houston, TX 77002']]);
    const { body: b2 } = await request(app).get(`/api/submissions/${id2}/ims2-queue`).set(auth);
    expect(b2.defaults.form.policy).toMatchObject({ state: 'TX', city: 'Houston' });
    expect(b2.defaults.sources.city).toMatchObject({ source: 'extracted', from: 'practice_location' });
  });

  it('prefills the queue form: broker by name, top-level location and contact, ISO receivedAt', async () => {
    const id = await seedSubmission(FIELDS);
    const { body } = await request(app).get(`/api/submissions/${id}/ims2-queue`).set(auth);
    expect(body).toMatchObject({ configured: true, canSend: false, row: null, legacyHandoff: null });
    expect(body.defaults.form.broker).toEqual({ brokerId: null, brokerName: 'Acme Brokers' });
    expect(body.defaults.form.location).toEqual({
      address1: '1 Main St',
      address2: null,
      city: 'Houston',
      state: 'TX',
      zipcode: '77002',
    });
    expect(body.defaults.form.contact).toEqual({ name: 'Ann Roe', email: 'ann@example.com', phone: '713-555-0100' });
    expect(body.defaults.form.insured.create).toMatchObject({
      insuredType: 'person',
      npi: '1234567893',
      licenseNumber: null,
    });
    expect(body.defaults.receivedAt).toBe('2026-11-02T15:00:00.000Z');
  });

  it('merges broker hits across names by id, active first, without a score', async () => {
    const id = await seedSubmission(FIELDS);
    const res = await request(app).get(`/api/submissions/${id}/ims2-queue/lookup`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.brokers.map((b: any) => b.id)).toEqual([12, 13]);
    expect(res.body.insureds.map((i: any) => i.status)).toEqual(['active', 'inactive']);
    expect(received.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(received.some((r) => r.url.includes('brokerName=Acme'))).toBe(true);
  });
});

describe('send', () => {
  it('refuses before an Accept assessment', async () => {
    const id = await seedSubmission(FIELDS);
    const res = await sendForm(id, await reviewedForm(id));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_ACCEPTED');
    expect(pushes()).toHaveLength(0);
  });

  it('queues contract v1: new insured mapped, broker by name only, location / contact top level, blanks dropped', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    const res = await sendForm(
      id,
      await reviewedForm(id, (f) => {
        f.policy.premium = 1234.567;
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'QUEUED', intakeId: id, version: 1, lastHttpStatus: 201 });
    const sent = pushes()[0]!.body;
    expect(sent).toMatchObject({
      contractVersion: 1,
      intakeId: id,
      version: 1,
      sentBy: 'uw@example.com',
      receivedAt: '2026-11-02T15:00:00.000Z',
      sourceUrl: `http://localhost:5174/submissions/${id}`,
      insured: {
        mode: 'new',
        insuredType: 'individual',
        canonicalName: 'Jane Smith',
        firstName: 'Jane',
        lastName: 'Smith',
        npi: '1234567893',
      },
      broker: { brokerName: 'Acme Brokers' },
      policy: { effectiveDate: '2026-12-01', premium: 1234.57, state: 'TX', specialty: 'Internal Medicine' },
      location: { address1: '1 Main St', city: 'Houston', state: 'TX', zipcode: '77002' },
      contact: { name: 'Ann Roe', email: 'ann@example.com', phone: '713-555-0100' },
    });
    expect(sent.broker.brokerId).toBeUndefined();
    expect(sent.location.title).toBeUndefined();
    expect(Object.values(sent.policy)).not.toContain(null);
    const {
      rows: [a],
    } = await pool.query(`SELECT details FROM audit_events WHERE submission_id=$1 AND action='IMS2_QUEUE_SENT'`, [id]);
    expect(a.details).toMatchObject({ intakeId: id, version: 1, status: 'new' });
  });

  it('sends the latest completed analysis and the coverage values, without evidence quotes; no quote when none is priced', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    const content = { executiveSummary: 'Clean file', overallRisk: 'LOW', recommendation: 'PROCEED' };
    for (const [version, status, summary] of [
      [1, 'COMPLETED', 'old'],
      [2, 'COMPLETED', 'Clean file'],
      [3, 'FAILED', 'broken'],
    ] as const) {
      await pool.query(
        `INSERT INTO reports (submission_id, kind, version, status, context_version, skill_name, skill_version, model, content_json)
         VALUES ($1, 'ANALYSIS', $2, $3, 1, 'underwriting-analysis', '1', 'claude-test', $4)`,
        [id, version, status, JSON.stringify({ ...content, executiveSummary: summary })],
      );
    }
    await sendForm(id, await reviewedForm(id));
    const sent = pushes()[0]!.body;
    expect(sent.analysisReport).toMatchObject({ version: 2, model: 'claude-test', content });
    expect(sent.coverage.values.npi).toEqual({ value: '1234567893', confidence: 0.9, sourceLabel: 'application.pdf' });
    expect(sent.coverage.derived).toBeDefined();
    expect(sent.quote).toBeUndefined();
  });

  it("drops the review parts, analysis report first, when the push would not fit IMS 2's inbox cap", async () => {
    const { buildPush, queueDefaults, IMS2_REVIEW_BUDGET_BYTES } = await import(
      '../src/services/intakeQueuePayload.js'
    );
    const id = await seedSubmission(FIELDS);
    const { queue, draft } = await queueDefaults(id);
    const big = (n: number) => ({ blob: 'x'.repeat(n) });
    const base = {
      form: queue.form as any,
      draft,
      queue,
      intakeId: id,
      version: 1,
      sentBy: 'uw@example.com',
      submissionId: id,
    };
    const review = (report: number) => ({
      quote: big(1000) as any,
      coverage: big(1000) as any,
      analysisReport: {
        reportId: 'r',
        version: 1,
        createdAt: '2026-11-04T00:00:00Z',
        model: null,
        content: big(report),
      },
    });
    const fits = buildPush({ ...base, review: review(1000) });
    expect(fits.analysisReport && fits.quote && fits.coverage).toBeTruthy();
    const over = buildPush({ ...base, review: review(IMS2_REVIEW_BUDGET_BYTES) });
    expect(over.analysisReport).toBeUndefined();
    expect(over.quote).toBeDefined();
    expect(over.coverage).toBeDefined();
  });

  it('sends an existing insured with location and contact; unchanged resend keeps the version, a change bumps it', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    const form = await reviewedForm(id, (f) => {
      f.insured = { mode: 'link', insuredId: 'insured-42' };
      f.broker = { brokerId: 12, brokerName: 'Acme Brokers' };
    });
    await sendForm(id, form);
    expect(pushes()[0]!.body).toMatchObject({
      insured: { mode: 'existing', insuredId: 'insured-42' },
      broker: { brokerId: 12 },
      location: { zipcode: '77002' },
    });
    const again = await sendForm(id, form);
    expect(again.body).toMatchObject({ state: 'QUEUED', version: 1 });
    form.policy.premium = 1000.001; // rounds to 1000: still a change from null
    const changed = await sendForm(id, form);
    expect(changed.body).toMatchObject({ state: 'QUEUED', version: 2 });
    form.policy.premium = 1000.004; // rounds to the same 1000: no change
    expect((await sendForm(id, form)).body.version).toBe(2);
  });

  it('keeps a 400 on the field IMS 2 names', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    override = { status: 400, body: { error: 'must be a real date', field: 'policy.effectiveDate' } };
    const res = await sendForm(id, await reviewedForm(id));
    expect(res.body).toMatchObject({ state: 'ERROR', lastHttpStatus: 400, lastErrorField: 'policy.effectiveDate' });
  });

  it('marks a network-class failure FAILED, and the retry replays the same version', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    const form = await reviewedForm(id);
    override = { status: 502, body: { error: 'Bad gateway' } };
    expect((await sendForm(id, form)).body).toMatchObject({ state: 'FAILED', version: 1 });
    expect((await sendForm(id, form)).body).toMatchObject({ state: 'QUEUED', version: 1 });
  });

  it('resends once at status.version + 1 on stale, and gives up on a second 409', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    const form = await reviewedForm(id);
    await sendForm(id, form);
    intakes.get(id)!.version = 5; // IMS 2 holds a newer version than ours
    form.policy.specialty = 'Cardiology';
    const res = await sendForm(id, form);
    expect(res.body).toMatchObject({ state: 'QUEUED', version: 6 });
    expect(pushes().map((p) => p.body.version)).toEqual([1, 2, 6]);

    const st = { intakeId: id, version: 9, status: 'new', statusChangedAt: tick() };
    received.length = 0;
    form.policy.specialty = 'Neurology';
    override = { status: 409, body: { code: 'stale', error: 'stale', status: st } };
    // The resend meets IMS 2's real state (version 6) with version 10: accepted.
    expect((await sendForm(id, form)).body).toMatchObject({ state: 'QUEUED', version: 10 });
  });

  it('a linked intake is final: 409 linked stores the link, later sends are refused', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    const form = await reviewedForm(id);
    await sendForm(id, form);
    link(id, 501);
    form.policy.specialty = 'Cardiology';
    const res = await sendForm(id, form);
    expect(res.body).toMatchObject({
      state: 'LINKED',
      imsSubmissionId: 501,
      imsSubmissionNumber: 'sub-501',
      imsUrl: 'https://ims2.example.com/policy-log/501',
    });
    const again = await sendForm(id, form);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('IMS2_QUEUE_LINKED');
  });

  it('a rejected intake is resent as the next version and reopened', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    const form = await reviewedForm(id);
    await sendForm(id, form);
    reject(id, 'Missing broker');
    // The GET only reads what is stored (SEC-07): no call to IMS 2, the rejection is not seen yet.
    const calls = received.length;
    const stored = await request(app).get(`/api/submissions/${id}/ims2-queue/status`).set(auth);
    expect(stored.body).toMatchObject({ state: 'QUEUED' });
    expect(received).toHaveLength(calls);
    const st = await request(app).post(`/api/submissions/${id}/ims2-queue/status/refresh`).set(auth);
    expect(st.body).toMatchObject({ state: 'REJECTED', rejectedReason: 'Missing broker' });
    expect(received.length).toBeGreaterThan(calls);
    const res = await sendForm(id, form); // unchanged, but a rejection always takes a new version
    expect(res.body).toMatchObject({ state: 'QUEUED', version: 2, rejectedReason: null });
  });

  it('flags a token problem (401) as a configuration error', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    override = { status: 401, body: { error: 'Invalid or missing token' } };
    expect((await sendForm(id, await reviewedForm(id))).body).toMatchObject({ state: 'ERROR', lastHttpStatus: 401 });
    expect((await pool.query(`SELECT 1 FROM system_errors WHERE scope='ims2'`)).rowCount).toBeGreaterThan(0);
  });

  it('validates the form before calling IMS 2', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    const res = await sendForm(
      id,
      await reviewedForm(id, (f) => {
        f.policy.premium = 1e13;
      }),
    );
    expect(res.status).toBe(400);
    expect(pushes()).toHaveLength(0);
  });
});

describe('one IMS 2 record per submission', () => {
  // The other direction (the direct hand-off refuses a queued submission) is in ims2.test.ts, where it is configured.
  it('the queue refuses a submission the direct hand-off created', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    const {
      rows: [u],
    } = await pool.query('SELECT id FROM users LIMIT 1');
    await pool.query(
      `INSERT INTO ims2_handoffs (submission_id, draft_id, state, payload, payload_hash, pushed_by, ims_submission_id, ims_url)
       VALUES ($1, $2, 'ACCEPTED', '{}', 'x', $3, 7, '/policy-log/7')`,
      [id, `tri-${id}`, u.id],
    );
    const res = await sendForm(id, await reviewedForm(id));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IMS2_ALREADY_HANDED_OFF');
    expect(pushes()).toHaveLength(0);
  });
});

describe('sync', () => {
  it('pages through status changes, ignores unknown ids, stores the last statusChangedAt, and repeats as a no-op', async () => {
    const a = await seedSubmission(FIELDS);
    const b = await seedSubmission(FIELDS);
    for (const id of [a, b]) {
      await accept(id);
      await sendForm(id, await reviewedForm(id));
    }
    intakes.set('someone-else', {
      intakeId: 'someone-else',
      version: 1,
      hash: '',
      status: 'new',
      statusChangedAt: tick(),
      submissionId: null,
      rejectedReason: null,
      policyNumber: null,
    });
    link(a, 601);
    reject(b, 'Duplicate');
    pageSize = 1;

    const res = { body: await syncNow() };
    expect(res.body).toMatchObject({ linked: 1, rejected: 1 });
    expect(res.body.pages).toBeGreaterThan(2);
    expect(res.body.error).toBeUndefined();
    const { rows } = await pool.query(
      'SELECT submission_id, state, ims_submission_number, rejected_reason FROM ims2_intake_queue WHERE submission_id = ANY($1)',
      [[a, b]],
    );
    expect(
      Object.fromEntries(rows.map((r) => [r.submission_id, [r.state, r.ims_submission_number ?? r.rejected_reason]])),
    ).toEqual({ [a]: ['LINKED', 'sub-601'], [b]: ['REJECTED', 'Duplicate'] });
    const {
      rows: [since],
    } = await pool.query(`SELECT value FROM app_settings WHERE key='ims2_intake_queue.last_status_changed_at'`);
    expect(since.value).toBe(intakes.get(b)!.statusChangedAt);

    expect(await syncNow()).toMatchObject({ linked: 0, rejected: 0 });
    const info = await request(app).get('/api/ims2-queue/sync').set(auth);
    expect(info.body).toMatchObject({ configured: true, lastSync: { linked: 0 }, running: false });
    expect(info.body.counts.LINKED).toBeGreaterThanOrEqual(1);
  });

  it('refreshes the policy number of a linked intake and never moves it back', async () => {
    const id = await seedSubmission(FIELDS);
    await accept(id);
    await sendForm(id, await reviewedForm(id));
    link(id, 701);
    await syncNow();
    intakes.get(id)!.policyNumber = 'DPL-1'; // bound later: no status change
    await syncNow();
    const {
      rows: [r],
    } = await pool.query('SELECT state, remote_status FROM ims2_intake_queue WHERE submission_id=$1', [id]);
    expect(r).toMatchObject({ state: 'LINKED', remote_status: { policyNumber: 'DPL-1' } });

    const { applyStatus } = await import('../src/modules/ims2/ims2.service.js');
    expect(await applyStatus({ ...r.remote_status, status: 'new', statusChangedAt: tick() })).toBeNull();
  });
});

describe('Settings → IMS 2 intake queue URL and token', () => {
  it('shows the URL and only a hint of the token', async () => {
    const res = await request(app).get('/api/settings/ims2-queue').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      baseUrl: QUEUE_BASE,
      tokenSet: true,
      tokenHint: `…${TOKEN.slice(-4)}`,
      tokenError: null,
      configured: true,
      imsUrl: null,
    });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it('tests the saved values, or a token typed into the form before saving', async () => {
    const saved = await request(app).post('/api/settings/ims2-queue/test').set(auth).send({});
    expect(saved.body).toMatchObject({ ok: true, detail: expect.stringContaining('Reachable') });
    const wrong = await request(app)
      .post('/api/settings/ims2-queue/test')
      .set(auth)
      .send({ token: 'not-the-right-token' });
    expect(wrong.body.ok).toBe(false);
  });

  it('refuses a URL that is not http(s) and a short token', async () => {
    const badUrl = await request(app).put('/api/settings/ims2-queue').set(auth).send({ baseUrl: 'ftp://ims2/x' });
    expect(badUrl.status).toBe(400);
    const shortToken = await request(app)
      .put('/api/settings/ims2-queue')
      .set(auth)
      .send({ baseUrl: QUEUE_BASE, token: 'short' });
    expect(shortToken.status).toBe(400);
  });

  it('turns sending off when the token is removed, and audits each change', async () => {
    const off = await request(app).put('/api/settings/ims2-queue').set(auth).send({ baseUrl: QUEUE_BASE, token: null });
    expect(off.body).toMatchObject({ configured: false, tokenSet: false });
    const on = await request(app).put('/api/settings/ims2-queue').set(auth).send({ baseUrl: QUEUE_BASE, token: TOKEN });
    expect(on.body).toMatchObject({ configured: true, tokenSet: true });
    const { rows } = await pool.query(
      `SELECT details FROM audit_events WHERE action='IMS2_QUEUE_SETTINGS_CHANGED' ORDER BY id`,
    );
    expect(rows.map((r) => r.details.token)).toEqual(['removed', 'replaced']);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it('saves, keeps and removes the IMS button URL, and refuses one that is not http(s)', async () => {
    const IMS = 'https://ims.example.com/policies';
    const put = (body: object) => request(app).put('/api/settings/ims2-queue').set(auth).send(body);
    expect((await put({ baseUrl: QUEUE_BASE, imsUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await put({ baseUrl: QUEUE_BASE, imsUrl: IMS })).body).toMatchObject({ imsUrl: IMS, configured: true });
    // Omitted: the saved URL is kept.
    expect((await put({ baseUrl: QUEUE_BASE })).body.imsUrl).toBe(IMS);
    expect((await request(app).get('/api/settings/ims2-queue').set(auth)).body.imsUrl).toBe(IMS);
    expect((await put({ baseUrl: QUEUE_BASE, imsUrl: null })).body).toMatchObject({ imsUrl: null, configured: true });
  });
});
