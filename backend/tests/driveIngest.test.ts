/**
 * Ingest into Google Drive against a real PostgreSQL database (TEST_DATABASE_URL, default the
 * docker-compose db's `ims_test` database). Google Drive is replaced by an in-memory fake that can be told to fail;
 * the pipeline, retry queue, routes and reconciliation run for real.
 */
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Scripts (and these tests) ask for the session token in the login body; browsers get only the cookie.
const CLI = { 'X-Client': 'cli' };

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_test';
process.env.DATABASE_URL = TEST_DB;
process.env.GOOGLE_REFRESH_TOKEN = 'refresh-token';
process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.GDRIVE_SHARED_DRIVE_ID = 'shared-drive';
process.env.ATTACHMENT_MAX_BYTES = '2000';
process.env.GMAIL_RETRY_ALERT_AFTER = '2';

const fake = vi.hoisted(() => ({
  files: new Map<string, { data: Buffer; filename: string; documentId: string }>(),
  trashed: new Set<string>(),
  uploads: 0,
  downloads: 0,
  /** Uploads allowed before every further one fails. */
  failAfter: Infinity,
  down: false,
}));

const gmailFake = vi.hoisted(() => ({ ids: [] as string[], attachmentCounts: new Map<string, number>() }));

vi.mock('../src/services/driveStorage.js', async (orig) => {
  const real = await orig<typeof import('../src/services/driveStorage.js')>();
  const { Readable } = await import('node:stream');
  const unavailable = () => new real.StorageError('UNAVAILABLE', 'Drive is down');
  return {
    ...real,
    ensureSubmissionFolder: async (submissionId: string) => {
      if (fake.down) throw unavailable();
      return `folder-${submissionId}`;
    },
    uploadToDrive: async (
      _folderId: string,
      f: { documentId: string; filename: string; data: Buffer | { path: string } },
    ) => {
      if (fake.down || fake.uploads >= fake.failAfter) throw unavailable();
      fake.uploads++;
      const id = `drive-${f.documentId}`;
      const data = Buffer.isBuffer(f.data) ? f.data : await (await import('node:fs/promises')).readFile(f.data.path);
      fake.files.set(id, { data, filename: f.filename, documentId: f.documentId });
      return id;
    },
    downloadDriveFile: async (id: string) => {
      if (fake.down) throw unavailable();
      const f = fake.files.get(id);
      if (!f || fake.trashed.has(id)) throw new real.StorageError('NOT_FOUND', 'File not found');
      fake.downloads++;
      return Readable.from([f.data]);
    },
    trashDriveFile: async (id: string) => {
      fake.trashed.add(id);
    },
    driveProbe: async () => {
      if (fake.down) throw unavailable();
    },
    listAppFiles: async function* () {
      for (const [id, f] of fake.files)
        if (!fake.trashed.has(id)) yield { id, name: f.filename, documentId: f.documentId };
    },
  };
});

vi.mock('../src/services/gmail.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/gmail.js')>()),
  listRecentMessageIds: async () => gmailFake.ids,
  gmailAttachmentCount: async (id: string) => gmailFake.attachmentCounts.get(id) ?? null,
}));

let app: import('express').Express;
let pool: pg.Pool;
let token = '';
let pipelineMod: typeof import('../src/services/pipeline.js');
let queue: typeof import('../src/services/ingestQueue.js');
let fileCache: typeof import('../src/services/fileCache.js');

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ims_test WITH (FORCE)');
  await admin.query('CREATE DATABASE ims_test');
  await admin.end();
  await (await import('../src/db/migrate.js')).migrate();
  ({ pool } = await import('../src/db/pool.js'));
  app = (await import('../src/app.js')).createApp();
  pipelineMod = await import('../src/services/pipeline.js');
  queue = await import('../src/services/ingestQueue.js');
  fileCache = await import('../src/services/fileCache.js');
  await request(app)
    .post('/api/auth/register')
    .send({ email: 'admin@example.com', password: 'correct-horse-battery', name: 'Ada Admin' });
  token = (
    await request(app)
      .post('/api/auth/login')
      .set(CLI)
      .send({ email: 'admin@example.com', password: 'correct-horse-battery' })
  ).body.token;
});

afterAll(async () => {
  // Workers and the LISTEN connection first, so nothing touches the pool after it ends.
  await (await import('../src/services/jobQueue.js')).jobs.stop(5000);
  await (await import('../src/services/pgListen.js')).closeListener();
  if (pool) await (await import('../src/db/pool.js')).closePools();
});

beforeEach(() => {
  fake.down = false;
  fake.failAfter = Infinity;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

function email(
  gmailMessageId: string | null,
  attachments: { filename: string; data: Buffer }[],
  extra: Partial<import('../src/services/pipeline.js').IncomingEmail> = {},
) {
  return {
    gmailMessageId,
    threadId: null,
    fromAddress: 'broker@acme.com',
    toAddress: 'uw@example.com',
    subject: `Submission ${gmailMessageId ?? 'manual'}`,
    bodyText: 'Please quote.',
    receivedAt: new Date(),
    attachments: attachments.map((a) => ({ ...a, mimeType: 'text/plain' })),
    ...extra,
  };
}

const ingestVia = (build: (id: string) => ReturnType<typeof email>) => async (id: string) =>
  (await pipelineMod.ingestEmail(build(id), null)).created ? ('CREATED' as const) : ('EXISTING' as const);

async function rowsFor(gmailMessageId: string) {
  const { rows } = await pool.query(
    `SELECT s.id, s.drive_folder_id FROM emails e JOIN submissions s ON s.email_id=e.id WHERE e.gmail_message_id=$1`,
    [gmailMessageId],
  );
  return rows;
}

describe('Google Drive storage', () => {
  let submissionId = '';
  let documentId = '';

  it('stores manual uploads in Drive, never on disk', async () => {
    const res = await request(app)
      .post('/api/submissions/upload')
      .set(auth())
      .field('subject', 'New submission - Dr. Jane Smith')
      .field('fromAddress', 'broker@acme.com')
      .attach('files', Buffer.from('Applicant: Jane Smith\nNPI 1234567893'), 'application.txt');
    expect(res.status).toBe(201);
    submissionId = res.body.id;
    documentId = res.body.documents[0].id;
    const {
      rows: [doc],
    } = await pool.query('SELECT storage_backend, storage_key FROM documents WHERE id=$1', [documentId]);
    expect(doc).toEqual({ storage_backend: 'GDRIVE', storage_key: `drive-${documentId}` });
    const {
      rows: [sub],
    } = await pool.query('SELECT drive_folder_id FROM submissions WHERE id=$1', [submissionId]);
    expect(sub.drive_folder_id).toBe(`folder-${submissionId}`);
    expect(res.body.documents[0]).not.toHaveProperty('storageKey');
  });

  it('extracts text from the in-memory copy without downloading from Drive', async () => {
    await pipelineMod.extractPendingText(submissionId);
    const {
      rows: [doc],
    } = await pool.query('SELECT extraction_status FROM documents WHERE id=$1', [documentId]);
    expect(doc.extraction_status).not.toBe('PENDING');
    expect(fake.downloads).toBe(0);
  });

  it('serves view/download from Drive, re-opens from the server cache, and maps storage failures', async () => {
    fileCache.clear();
    const view = await request(app).get(`/api/documents/${documentId}/view`).set(auth());
    expect(view.status).toBe(200);
    expect(view.text).toContain('Jane Smith');
    expect(view.headers['cache-control']).toBe('private, no-store');
    expect(fake.downloads).toBe(1);
    // The read filled the cache, so re-opening or downloading needs no second Drive request.
    expect((await request(app).get(`/api/documents/${documentId}/view`).set(auth())).status).toBe(200);
    expect((await request(app).get(`/api/documents/${documentId}/download`).set(auth())).status).toBe(200);
    expect(fake.downloads).toBe(1);

    fileCache.clear();
    fake.down = true;
    const down = await request(app).get(`/api/documents/${documentId}/download`).set(auth());
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('STORAGE_UNAVAILABLE');
    fake.down = false;
    fake.trashed.add(`drive-${documentId}`);
    const gone = await request(app).get(`/api/documents/${documentId}/view`).set(auth());
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe('FILE_MISSING');
    // Routes outside the viewer get the same mapping (http.ts), not a generic 500.
    await pool.query("UPDATE documents SET extraction_status='PENDING' WHERE id=$1", [documentId]);
    // The read runs as a job (202); GET reports the document it could not read once the job has failed.
    const extract = await request(app).post(`/api/submissions/${submissionId}/extract-text`).set(auth());
    expect(extract.status).toBe(202);
    expect(extract.body).toMatchObject({ status: 'EXTRACTING', pendingDocuments: 1 });
    let result = extract;
    for (let i = 0; i < 100 && result.status === 202; i++) {
      await new Promise((r) => setTimeout(r, 100));
      result = await request(app).get(`/api/submissions/${submissionId}/extract-text`).set(auth());
    }
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('EXTRACTION_INCOMPLETE');
    expect(result.body.error.message).toMatch(/1 document was not read/);
    fake.trashed.delete(`drive-${documentId}`);
  });

  it('rejects a manual upload with 502 and records nothing when Drive is down', async () => {
    const {
      rows: [before],
    } = await pool.query('SELECT count(*)::int AS n FROM submissions');
    fake.down = true;
    const res = await request(app)
      .post('/api/submissions/upload')
      .set(auth())
      .field('subject', 'Will fail')
      .field('fromAddress', 'broker@acme.com')
      .attach('files', Buffer.from('x'), 'a.txt');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const {
      rows: [after],
    } = await pool.query('SELECT count(*)::int AS n FROM submissions');
    expect(after.n).toBe(before.n);
  });

  it('keeps a message queued when Drive fails mid-email, trashes partial uploads, and ingests it on retry', async () => {
    const build = (id: string) =>
      email(id, [
        { filename: 'one.txt', data: Buffer.from('one') },
        { filename: 'two.txt', data: Buffer.from('two') },
      ]);
    await queue.enqueueMessages(pool, ['msg-partial'], 'OAUTH');
    fake.failAfter = fake.uploads + 1;
    const trashedBefore = fake.trashed.size;
    expect(await queue.drainQueue(ingestVia(build))).toBe(0);
    expect(await rowsFor('msg-partial')).toEqual([]);
    expect(fake.trashed.size).toBe(trashedBefore + 1);
    const {
      rows: [q],
    } = await pool.query(
      `SELECT attempts, next_attempt_at > now() AS later, last_error FROM gmail_ingest_queue WHERE gmail_message_id='msg-partial'`,
    );
    expect(q).toMatchObject({ attempts: 1, later: true });
    expect(q.last_error).toContain('Drive is down');

    fake.failAfter = Infinity;
    await pool.query(`UPDATE gmail_ingest_queue SET next_attempt_at=now() WHERE gmail_message_id='msg-partial'`);
    expect(await queue.drainQueue(ingestVia(build))).toBe(1);
    expect(await rowsFor('msg-partial')).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM gmail_ingest_queue WHERE gmail_message_id='msg-partial'`)).rowCount).toBe(
      0,
    );
    // Already ingested: enqueueing it again is a no-op.
    expect(await queue.enqueueMessages(pool, ['msg-partial'], 'OAUTH')).toBe(0);
  });

  it('trashes uploaded files when the database transaction fails after upload', async () => {
    const before = fake.trashed.size;
    // A constraint this subject breaks, so the INSERT fails after the files are in Drive. (NUL characters, which
    // PostgreSQL also rejects, are stripped before storing.)
    await pool.query(`ALTER TABLE emails ADD CONSTRAINT test_reject_subject CHECK (subject <> 'rejected subject')`);
    try {
      await expect(
        pipelineMod.ingestEmail(
          email(null, [{ filename: 'x.txt', data: Buffer.from('x') }], { subject: 'rejected subject' }),
          null,
        ),
      ).rejects.toThrow();
    } finally {
      await pool.query('ALTER TABLE emails DROP CONSTRAINT test_reject_subject');
    }
    expect(fake.trashed.size).toBe(before + 1);
  });

  it('records oversize attachments and Drive links as gaps and still ingests the email', async () => {
    const { submissionId: id } = await pipelineMod.ingestEmail(
      email(
        'msg-gaps',
        [
          { filename: 'small.txt', data: Buffer.from('ok') },
          { filename: 'huge.pdf', data: Buffer.alloc(5000) },
        ],
        { bodyText: 'Loss runs are too big to attach: https://drive.google.com/file/d/abc/view' },
      ),
      null,
    );
    const detail = (await request(app).get(`/api/submissions/${id}`).set(auth())).body;
    expect(detail.documents.map((d: any) => d.filename)).toEqual(['small.txt']);
    expect(detail.attachmentGaps.map((g: any) => [g.filename, g.reason])).toEqual([
      ['huge.pdf', 'TOO_LARGE'],
      ['Google Drive link', 'LINKED_FILE'],
    ]);
    expect(detail.attachmentGaps[1].detail).toBe('https://drive.google.com/file/d/abc/view');
  });

  it('alerts once after GMAIL_RETRY_ALERT_AFTER failures and never drops the message', async () => {
    await queue.enqueueMessages(pool, ['msg-alert'], 'MCP');
    const failing = async () => {
      throw new Error('gmail unreachable');
    };
    for (let i = 0; i < 3; i++) {
      await pool.query(`UPDATE gmail_ingest_queue SET next_attempt_at=now() WHERE gmail_message_id='msg-alert'`);
      await queue.drainQueue(failing);
    }
    const {
      rows: [q],
    } = await pool.query(`SELECT attempts, alerted_at FROM gmail_ingest_queue WHERE gmail_message_id='msg-alert'`);
    expect(q.attempts).toBe(3);
    expect(q.alerted_at).not.toBeNull();
    const {
      rows: [a],
    } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action='GMAIL_INGEST_DELAYED' AND entity_id='msg-alert'`,
    );
    expect(a.n).toBe(1);
    expect(await queue.queueStats()).toMatchObject({ alerted: 1 });

    const stats = (await request(app).get('/api/monitoring/stats').set(auth())).body;
    expect(stats.ingestQueue).toMatchObject({ alerted: 1 });
    const retry = await request(app).post('/api/ingest-queue/retry-now').set(auth());
    expect(retry.status).toBe(202);
    await pool.query(`DELETE FROM gmail_ingest_queue WHERE gmail_message_id='msg-alert'`);
  });

  it('removes a message deleted from Gmail from the queue and audits it', async () => {
    await queue.enqueueMessages(pool, ['msg-gone'], 'OAUTH');
    await queue.drainQueue(async () => 'GONE');
    expect((await pool.query(`SELECT 1 FROM gmail_ingest_queue WHERE gmail_message_id='msg-gone'`)).rowCount).toBe(0);
    expect(
      (await pool.query(`SELECT 1 FROM audit_events WHERE action='GMAIL_MESSAGE_GONE' AND entity_id='msg-gone'`))
        .rowCount,
    ).toBe(1);
  });

  it('reconciliation queues missed messages and flags attachment-count mismatches', async () => {
    const { reconcileGmail, sweepDriveOrphans } = await import('../src/services/reconcile.js');
    gmailFake.ids = ['msg-missed', 'msg-partial'];
    gmailFake.attachmentCounts.set('msg-partial', 3); // two were stored
    const result = await reconcileGmail();
    expect(result).toEqual({ enqueued: 1, mismatches: 1 });
    expect((await pool.query(`SELECT 1 FROM gmail_ingest_queue WHERE gmail_message_id='msg-missed'`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM system_errors WHERE scope='reconcile:msg-partial'`)).rowCount).toBe(1);
    // The next daily run sees the same mismatch but does not report it again.
    expect(await reconcileGmail()).toEqual({ enqueued: 0, mismatches: 1 });
    expect((await pool.query(`SELECT 1 FROM system_errors WHERE scope='reconcile:msg-partial'`)).rowCount).toBe(1);

    // A Drive file with no documents row (crash between upload and commit) is swept to trash.
    fake.files.set('drive-orphan', { data: Buffer.from('o'), filename: 'orphan.txt', documentId: 'none' });
    expect(await sweepDriveOrphans()).toBe(1);
    expect(fake.trashed.has('drive-orphan')).toBe(true);
    expect(fake.trashed.has(`drive-${documentId}`)).toBe(false);
  });

  it('reports Drive and the queue on the system status menu', async () => {
    const status = (await request(app).get('/api/system/status').set(auth())).body;
    const storage = status.services.find((s: any) => s.key === 'storage');
    expect(storage).toMatchObject({ label: 'Google Drive (attachments)' });
    expect(storage.detail).toMatch(/^Google Drive · \d+ waiting/);
  });
});
