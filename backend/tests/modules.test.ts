/**
 * The modules/ layout (route → service → repository) with injected dependencies: createApp(deps) and setIntegrations()
 * hand the app fake Drive, Gmail, IMS 2 and NPI clients, with no vi.mock of any module. Runs against a real PostgreSQL
 * database (TEST_DATABASE_URL host, database ims_test_modules).
 */
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DriveClient, GmailClient, Ims2Client, NpiClient } from '../src/integrations/index.js';

const CLI = { 'X-Client': 'cli' };
const TEST_DB = (process.env.TEST_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_test').replace(
  /\/[^/]+$/,
  '/ims_test_modules',
);
process.env.DATABASE_URL = TEST_DB;

const looked: string[] = [];
/** Registry records by NPI; any other NPI is Jane Smith. */
const registryRecords = new Map<string, object>();
const fakeNpi: NpiClient = {
  lookup: async (npi) => {
    looked.push(npi);
    return {
      found: true,
      result: (registryRecords.get(npi) ?? { number: npi, basic: { first_name: 'JANE', last_name: 'SMITH' } }) as never,
    };
  },
  search: async () => ({ match: null, candidates: [], reason: 'not used' }) as never,
};

/** Files "in Drive", by file id. */
const driveFiles = new Map<string, Buffer>();
const fakeDrive: DriveClient = {
  ensureSubmissionFolder: async (submissionId) => `folder-${submissionId}`,
  upload: async (_folderId, f) => {
    const id = `drive-${f.documentId}`;
    driveFiles.set(id, Buffer.isBuffer(f.data) ? f.data : await readFile(f.data.path));
    return id;
  },
  download: async (id) => Readable.from([driveFiles.get(id) ?? Buffer.alloc(0)]),
  trash: async (id) => {
    driveFiles.delete(id);
  },
  probe: async () => undefined,
  listAppFiles: async function* () {
    /* none */
  },
};

const imported: string[] = [];
const fakeGmail: GmailClient = {
  status: async () => ({ source: 'OAUTH', configured: true, connected: true, email: 'team@example.test' }) as never,
  authUrl: () => 'https://accounts.example.test/auth?state=s',
  handleOAuthCallback: async () => 'team@example.test',
  pollOnce: async () => 0,
  disconnect: async () => undefined,
  importSkippedMessage: async (id) => {
    imported.push(id);
    return null;
  },
  listRecentMessageIds: async () => [],
  send: async () => ({ transport: 'OAUTH', messageId: 'm1', threadId: 't1' }),
  probe: async () => 'ok',
  rescheduleMonitor: () => undefined,
};

const statusPages: unknown[] = [];
const fakeIms2: Ims2Client = {
  configured: () => true,
  lookup: async () => ({ insureds: [], brokers: [] }),
  push: async () => {
    throw new Error('not used');
  },
  status: async () => {
    throw new Error('not used');
  },
  statusPage: async (p) => {
    statusPages.push(p);
    return { items: [], nextCursor: null };
  },
  appUrl: (url) => url ?? null,
  probe: async () => 'ok',
};

let app: import('express').Express;
let pool: pg.Pool;
let auth: Record<string, string>;
let restoreIntegrations: () => void;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ims_test_modules WITH (FORCE)');
  await admin.query('CREATE DATABASE ims_test_modules');
  await admin.end();
  await (await import('../src/db/migrate.js')).migrate();
  ({ pool } = await import('../src/db/pool.js'));
  // Background work (storage, the pipeline's NPI checks) reads the process's clients; requests get createApp's.
  restoreIntegrations = (await import('../src/integrations/index.js')).setIntegrations({
    drive: fakeDrive,
    npi: fakeNpi,
  });
  app = (await import('../src/app.js')).createApp({ npi: fakeNpi, drive: fakeDrive, gmail: fakeGmail, ims2: fakeIms2 });
  await request(app)
    .post('/api/auth/register')
    .send({ email: 'admin@example.com', password: 'correct-horse-battery', name: 'Ada Admin' });
  const login = await request(app)
    .post('/api/auth/login')
    .set(CLI)
    .send({ email: 'admin@example.com', password: 'correct-horse-battery' });
  auth = { Authorization: `Bearer ${login.body.token}` };
});

afterAll(async () => {
  restoreIntegrations();
  await (await import('../src/services/jobQueue.js')).jobs.stop(5000);
  await (await import('../src/db/pool.js')).closePools();
});

describe('createApp(deps)', () => {
  it('answers GET /npi/lookup from the injected NPI client', async () => {
    const res = await request(app).get('/api/npi/lookup/1234567893').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ found: true, result: { number: '1234567893' } });
    expect(looked).toEqual(['1234567893']);
  });

  it('refuses a malformed NPI before calling the client', async () => {
    expect((await request(app).get('/api/npi/lookup/123').set(auth)).status).toBe(400);
    expect(looked).toHaveLength(1);
  });

  it('reads Gmail through the injected client', async () => {
    expect((await request(app).get('/api/gmail/status').set(auth)).body).toMatchObject({
      connected: true,
      email: 'team@example.test',
    });
    await pool.query(
      `INSERT INTO skipped_emails (gmail_message_id, from_address, subject, received_at, confidence, method)
       VALUES ('msg-1', 'someone@example.test', 'Lunch?', now(), 0.9, 'RULES')`,
    );
    // 202 at once; the import runs in the background (PERF-01) and its outcome is read from the status endpoint.
    const started = await request(app).post('/api/skipped-emails/msg-1/process').set(auth);
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ started: true });
    const { drainBackground } = await import('../src/services/backgroundTasks.js');
    await drainBackground(5000);
    expect(imported).toEqual(['msg-1']);
    expect((await request(app).get('/api/skipped-emails/msg-1/process').set(auth)).body).toEqual({
      state: 'failed',
      error: { code: 'GMAIL_MESSAGE_GONE', status: 410, message: 'The email is no longer in the Gmail mailbox' },
    });
  });

  it('syncs IMS 2 intake statuses through the injected client', async () => {
    const res = await request(app).post('/api/ims2-queue/sync').set(auth);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ started: true });
    const { drainBackground } = await import('../src/services/backgroundTasks.js');
    await drainBackground(5000);
    expect(statusPages).toHaveLength(1);
    const info = (await request(app).get('/api/ims2-queue/sync').set(auth)).body;
    expect(info).toMatchObject({ configured: true, running: false, lastSync: { pages: 1, seen: 0, updated: 0 } });
    expect(info.lastSync.at >= res.body.since).toBe(true);
  });
});

describe('modules/assessments and modules/submissions', () => {
  let id: string;
  beforeAll(async () => {
    const created = await request(app)
      .post('/api/submissions/upload')
      .set(auth)
      .field('subject', 'Quote request')
      .field('fromAddress', 'broker@example.test')
      .field('bodyText', 'Please quote.')
      .attach('files', Buffer.from('application form'), 'application.txt');
    id = created.body.id;
    // Let the upload's processing finish first: it sets the status itself and would race the assertions below.
    await (await import('../src/services/jobQueue.js')).jobs.drain();
    await pool.query(`UPDATE submissions SET status='READY_FOR_REVIEW' WHERE id=$1`, [id]);
  });

  it('stores uploads in the injected Drive and serves them back from it', async () => {
    const {
      rows: [doc],
    } = await pool.query('SELECT id, storage_key FROM documents WHERE submission_id=$1', [id]);
    expect(driveFiles.get(doc.storage_key)?.toString()).toBe('application form');
    const download = await request(app)
      .get(`/api/documents/${doc.id}/download`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect((download.body as Buffer).toString()).toBe('application form');
  });

  it('records assessment versions, moves the status, and lists them newest first', async () => {
    const first = await request(app)
      .post(`/api/submissions/${id}/assessments`)
      .set(auth)
      .send({ decision: 'REFER', riskRating: 'MODERATE' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      version: 1,
      decision: 'REFER',
      riskRating: 'MODERATE',
      createdBy: { name: 'Ada Admin' },
    });
    expect((await pool.query('SELECT status FROM submissions WHERE id=$1', [id])).rows[0].status).toBe('IN_REVIEW');

    await seedPrimaryQuote(id, { premium: 1000, total: 1100 });
    const second = await request(app)
      .post(`/api/submissions/${id}/assessments`)
      .set(auth)
      .send({ decision: 'ACCEPT', riskRating: 'LOW', notes: 'ok' });
    expect(second.body.version).toBe(2);
    expect((await pool.query('SELECT status FROM submissions WHERE id=$1', [id])).rows[0].status).toBe('COMPLETED');

    const list = await request(app).get(`/api/submissions/${id}/assessments`).set(auth);
    expect(list.body.items.map((a: { version: number }) => a.version)).toEqual([2, 1]);

    // The same decision again (a double click, a repeat save) is refused; a changed reason is a new version.
    const again = await request(app)
      .post(`/api/submissions/${id}/assessments`)
      .set(auth)
      .send({ decision: 'ACCEPT', riskRating: 'LOW', notes: ' ok ' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_ASSESSMENT');
    const changed = await request(app)
      .post(`/api/submissions/${id}/assessments`)
      .set(auth)
      .send({ decision: 'ACCEPT', riskRating: 'LOW', notes: 'ok, limits confirmed' });
    expect(changed.body.version).toBe(3);
  });

  it('accepts only with a primary quote priced above zero; refer, request information and decline need none', async () => {
    const created = await request(app)
      .post('/api/submissions/upload')
      .set(auth)
      .field('subject', 'Quote request - accept rule')
      .field('fromAddress', 'broker@example.test')
      .field('bodyText', 'Please quote.')
      .attach('files', Buffer.from('application form'), 'application.txt');
    const sub = created.body.id as string;
    await (await import('../src/services/jobQueue.js')).jobs.drain();
    await pool.query(`UPDATE submissions SET status='READY_FOR_REVIEW', primary_rating_id=NULL WHERE id=$1`, [sub]);
    await pool.query('DELETE FROM single_rating WHERE submission_id=$1', [sub]);
    const record = (decision: string, notes: string) =>
      request(app).post(`/api/submissions/${sub}/assessments`).set(auth).send({ decision, riskRating: 'LOW', notes });
    const count = async () =>
      (await pool.query('SELECT count(*)::int AS n FROM assessments WHERE submission_id=$1', [sub])).rows[0].n;

    for (const decision of ['ACCEPT', 'ACCEPT_WITH_CONDITIONS']) {
      const none = await record(decision, 'no quote yet');
      expect(none.status).toBe(409);
      expect(none.body.error.code).toBe('NO_PRIMARY_QUOTE');
      expect(none.body.error.message).toMatch(/no primary quote.*Coverage & Rating/);
    }
    expect((await record('REFER', 'refer without a quote')).status).toBe(201);

    const quoteId = await seedPrimaryQuote(sub, { premium: 0, total: 0 });
    const zero = await record('ACCEPT', 'zero premium');
    expect(zero.status).toBe(409);
    expect(zero.body.error.code).toBe('PRIMARY_QUOTE_NOT_PRICED');
    await pool.query('UPDATE single_rating SET premium=1000, total=0 WHERE id=$1', [quoteId]);
    expect((await record('ACCEPT', 'zero total')).body.error.code).toBe('PRIMARY_QUOTE_NOT_PRICED');
    expect(await count()).toBe(1);
    expect((await pool.query('SELECT status FROM submissions WHERE id=$1', [sub])).rows[0].status).toBe('IN_REVIEW');

    await pool.query('UPDATE single_rating SET total=1100 WHERE id=$1', [quoteId]);
    expect((await record('ACCEPT_WITH_CONDITIONS', 'priced primary quote')).status).toBe(201);
    expect((await pool.query('SELECT status FROM submissions WHERE id=$1', [sub])).rows[0].status).toBe('COMPLETED');
  });

  it('refuses an analysis report of another submission, and a deleted submission', async () => {
    const bad = await request(app)
      .post(`/api/submissions/${id}/assessments`)
      .set(auth)
      .send({ decision: 'REFER', riskRating: 'LOW', analysisReportId: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status).toBe(400);
    expect(
      (await request(app).get('/api/submissions/00000000-0000-4000-8000-000000000000/assessments').set(auth)).status,
    ).toBe(404);
  });

  it('changes status only along the allowed transitions, and assigns to active users', async () => {
    const refused = await request(app).patch(`/api/submissions/${id}`).set(auth).send({ status: 'NEW' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INVALID_TRANSITION');
    const unknownUser = await request(app)
      .patch(`/api/submissions/${id}`)
      .set(auth)
      .send({ assignedToId: '00000000-0000-4000-8000-000000000000' });
    expect(unknownUser.status).toBe(400);
    const {
      rows: [me],
    } = await pool.query(`SELECT id FROM users WHERE email='admin@example.com'`);
    const assigned = await request(app).patch(`/api/submissions/${id}`).set(auth).send({ assignedToId: me.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.assignedTo).toMatchObject({ id: me.id });
  });

  it('matches /submissions/unread-count before /submissions/:id', async () => {
    const res = await request(app).get('/api/submissions/unread-count').set(auth);
    expect(res.status).toBe(200);
    expect(typeof res.body.unread).toBe('number');
  });
});

describe('NPI checks on a group submission', () => {
  const doctor = (first: string, last: string, specialty: string) => ({
    enumeration_type: 'NPI-1',
    basic: { first_name: first, last_name: last, status: 'A' },
    taxonomies: [{ primary: true, desc: specialty, state: 'CA' }],
    addresses: [{ address_purpose: 'LOCATION', state: 'CA' }],
  });
  const field = (fieldName: string, value: string, confidence = 0.9) => ({ fieldName, value, confidence });

  async function seedSubmission(): Promise<string> {
    const {
      rows: [email],
    } = await pool.query(
      `INSERT INTO emails (from_address, subject, received_at) VALUES ('broker@example.com','Group',now()) RETURNING id`,
    );
    const {
      rows: [sub],
    } = await pool.query(`INSERT INTO submissions (email_id, status) VALUES ($1,'NEW') RETURNING id`, [email.id]);
    return sub.id as string;
  }

  async function checks(id: string) {
    const { rows } = await pool.query(
      `SELECT npi, status, claimed_name, mismatches FROM npi_verifications WHERE submission_id=$1 ORDER BY npi`,
      [id],
    );
    return rows;
  }

  it("checks each provider's NPI against that provider, not the first one named (F-01)", async () => {
    registryRecords.set('1234567893', doctor('MICHAEL', 'ANDERSON', 'Internal Medicine'));
    registryRecords.set('1234567901', doctor('SARAH', 'WILLIAMS', 'Family Medicine'));
    const id = await seedSubmission();
    const { verifySubmissionNpis } = await import('../src/services/pipeline.js');
    await verifySubmissionNpis(
      id,
      [
        field('applicant_name', 'Dr. Michael Anderson', 0.95),
        field('applicant_name', 'Dr. Sarah Williams'),
        field('npi', '1234567893'),
        field('npi', '1234567901'),
        field('practice_state', 'CA'),
        field('specialty', 'Internal Medicine', 0.95),
        field('specialty', 'Family Medicine'),
      ],
      null,
    );
    expect(await checks(id)).toMatchObject([
      { npi: '1234567893', status: 'MATCH', claimed_name: 'Dr. Michael Anderson' },
      { npi: '1234567901', status: 'MATCH', claimed_name: 'Dr. Sarah Williams' },
    ]);
  });

  it("fills missing contact details from the main applicant's NPI only, not another provider's", async () => {
    const withPhone = (record: object, phone: string) => ({
      ...record,
      addresses: [{ address_purpose: 'LOCATION', state: 'CA', telephone_number: phone }],
    });
    registryRecords.set('1234567893', withPhone(doctor('MICHAEL', 'ANDERSON', 'Internal Medicine'), '555-0100'));
    registryRecords.set('1234567901', withPhone(doctor('SARAH', 'WILLIAMS', 'Family Medicine'), '555-0199'));
    const id = await seedSubmission();
    const stated = [
      field('applicant_name', 'Dr. Michael Anderson', 0.95),
      field('applicant_name', 'Dr. Sarah Williams'),
      field('npi', '1234567893'),
      field('npi', '1234567901'),
    ];
    for (const f of stated)
      await pool.query(
        `INSERT INTO extracted_fields (submission_id, field_name, value, confidence, evidence_quote, source_label, context_version)
         VALUES ($1,$2,$3,$4,$3,'email body',1)`,
        [id, f.fieldName, f.value, f.confidence],
      );
    const { verifySubmissionNpis } = await import('../src/services/pipeline.js');
    await verifySubmissionNpis(id, stated, null);
    const { rows } = await pool.query(
      `SELECT value FROM extracted_fields WHERE submission_id=$1 AND field_name='contact_phone' ORDER BY value`,
      [id],
    );
    expect(rows.map((r) => r.value)).toEqual(['555-0100']);
  });

  it('records an NPI failing the check digit instead of dropping it, without asking the registry (F-02)', async () => {
    registryRecords.set('1234567893', doctor('MICHAEL', 'ANDERSON', 'Internal Medicine'));
    const id = await seedSubmission();
    const before = looked.length;
    const { verifySubmissionNpis } = await import('../src/services/pipeline.js');
    await verifySubmissionNpis(
      id,
      [
        field('applicant_name', 'Dr. Michael Anderson', 0.95),
        field('applicant_name', 'Dr. Sarah Williams'),
        field('npi', '1234567893'),
        field('npi', '1234567894'),
      ],
      null,
    );
    const rows = await checks(id);
    expect(rows.map((r) => [r.npi, r.status])).toEqual([
      ['1234567893', 'MATCH'],
      ['1234567894', 'NOT_FOUND'],
    ]);
    expect(rows[1].mismatches[0]).toMatch(/check digit/i);
    expect(looked.slice(before)).toEqual(['1234567893']);
  });
});

/** A QUOTED rating made the submission's primary one, priced as given (accepting needs premium and total above 0). */
async function seedPrimaryQuote(submissionId: string, price: { premium: number; total: number }): Promise<string> {
  const {
    rows: [r],
  } = await pool.query(
    `INSERT INTO single_rating (submission_id, version, title, status, rate_group, context_version, premium, total, inputs)
     VALUES ($1, COALESCE((SELECT max(version) FROM single_rating WHERE submission_id=$1), 0) + 1, 'Test quote', 'QUOTED',
             'rg', 1, $2, $3, '{}') RETURNING id`,
    [submissionId, price.premium, price.total],
  );
  await pool.query('UPDATE submissions SET primary_rating_id=$2 WHERE id=$1', [submissionId, r.id]);
  return r.id as string;
}
