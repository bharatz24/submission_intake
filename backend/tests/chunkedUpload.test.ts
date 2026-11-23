/**
 * Chunked uploads (modules/uploads, RUNTIME=netlify) against a real database (`ims_test_chunked`), with an in-memory
 * chunk store and fake Drive. Enqueued jobs only trigger the (mocked) worker here, so none runs. Also the other
 * netlify-runtime API behaviour that needs a signed-in user (the SSE stream is refused).
 */
import http from 'node:http';

import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { makeUser, registerAdmin, startTestApp, stopTestApp, testDatabaseUrl } from './helpers/apiTestDb.js';
import { driveFiles } from './helpers/fakeDrive.js';

process.env.DATABASE_URL = testDatabaseUrl('ims_test_chunked');
process.env.RUNTIME = 'netlify';
process.env.WORKER_TOKEN = 'chunked-test-worker-token-0123456789abcdef';

vi.mock('../src/runtime/workerTrigger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/workerTrigger.js')>()),
  triggerWorker: vi.fn(async () => undefined),
}));
vi.mock('../src/services/driveStorage.js', async (orig) =>
  (await import('./helpers/fakeDrive.js')).fakeDrive(await orig()),
);

let app: Express;
let pool: pg.Pool;
let admin: { Authorization: string };
let store: import('../src/modules/uploads/chunkStore.js').ChunkStore;
let CHUNK: number;

beforeAll(async () => {
  ({ pool } = await startTestApp('ims_test_chunked'));
  ({ UPLOAD_CHUNK_BYTES: CHUNK } = await import('../src/constants.js'));
  store = (await import('../src/modules/uploads/chunkStore.js')).createMemoryChunkStore();
  app = (await import('../src/app.js')).createApp({ chunks: store });
  admin = await registerAdmin(app);
});
afterAll(async () => {
  await stopTestApp();
});

/** Declare a file of `size` bytes; returns its id and chunk count. */
async function declare(auth: Record<string, string>, size: number, filename = 'loss-runs.pdf') {
  const res = await request(app)
    .post('/api/uploads')
    .set(auth)
    .send({ filename, mimeType: 'application/pdf', size })
    .expect(201);
  return res.body as { uploadId: string; chunkBytes: number; chunkCount: number };
}
const putChunk = (auth: Record<string, string>, id: string, index: number, bytes: Buffer) =>
  request(app)
    .put(`/api/uploads/${id}/chunks/${index}`)
    .set(auth)
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
/** Bytes of a file of `size`, and its chunks as the client cuts them. */
function fileOf(size: number) {
  const data = Buffer.alloc(size, 0x61);
  data.write('%PDF-1.4\n', 0);
  const parts: Buffer[] = [];
  for (let off = 0; off < size || parts.length === 0; off += CHUNK) parts.push(data.subarray(off, off + CHUNK));
  return { data, parts };
}
const submissionCount = async () => (await pool.query('SELECT count(*)::int AS n FROM submissions')).rows[0].n;

describe('chunked uploads', () => {
  it('creates upload and accepts chunks', async () => {
    const { data, parts } = fileOf(CHUNK + 10);
    const up = await declare(admin, data.length);
    expect(up).toMatchObject({ chunkBytes: CHUNK, chunkCount: 2 });
    await putChunk(admin, up.uploadId, 0, parts[0]!).expect(204);
    await putChunk(admin, up.uploadId, 1, parts[1]!).expect(204);
    await putChunk(admin, up.uploadId, 2, parts[1]!).expect(400); // no such chunk
    await putChunk(admin, up.uploadId, 1, parts[1]!.subarray(1)).expect(400); // wrong length
  });

  it('rejects chunk larger than UPLOAD_CHUNK_BYTES (413)', async () => {
    const up = await declare(admin, CHUNK * 2);
    // Refused from Content-Length before the body is read, so only the headers are sent here (a client still
    // writing 3 MB would see the connection reset instead of the answer).
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as import('node:net').AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          port,
          method: 'PUT',
          path: `/api/uploads/${up.uploadId}/chunks/0`,
          headers: { ...admin, 'Content-Type': 'application/octet-stream', 'Content-Length': String(CHUNK + 1) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.flushHeaders();
    });
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    expect(status).toBe(413);
  });

  it("rejects chunk for another user's upload (403)", async () => {
    const other = await makeUser(pool, 'other-uw@example.com', 'UNDERWRITER');
    const up = await declare(admin, 10);
    await putChunk(other.auth, up.uploadId, 0, Buffer.alloc(10)).expect(403);
    await request(app)
      .post('/api/submissions/upload')
      .set(other.auth)
      .send({ subject: 'Not yours', fromAddress: 'b@broker.test', uploadIds: [up.uploadId] })
      .expect(403);
  });

  it('oversize declared size rejected (413)', async () => {
    await request(app)
      .post('/api/uploads')
      .set(admin)
      .send({ filename: 'huge.pdf', mimeType: 'application/pdf', size: 1024 * 1024 * 1024 })
      .expect(413);
  });

  it('submission upload with missing chunk returns 409 and stores nothing', async () => {
    const { data, parts } = fileOf(CHUNK + 100);
    const up = await declare(admin, data.length);
    await putChunk(admin, up.uploadId, 0, parts[0]!).expect(204);
    const before = { submissions: await submissionCount(), drive: driveFiles.size };
    const res = await request(app)
      .post('/api/submissions/upload')
      .set(admin)
      .send({ subject: 'Incomplete upload', fromAddress: 'b@broker.test', uploadIds: [up.uploadId] })
      .expect(409);
    expect(res.body.error?.code ?? res.body.code).toBe('UPLOAD_INCOMPLETE');
    expect({ submissions: await submissionCount(), drive: driveFiles.size }).toEqual(before);
    expect(await store.meta(up.uploadId)).not.toBeNull(); // kept: the client may send the chunk and retry
  });

  it('submission upload with uploadIds creates documents and enqueues extract like multipart', async () => {
    const { data, parts } = fileOf(CHUNK * 2 + 123);
    const up = await declare(admin, data.length, 'acord-125.pdf');
    for (const [i, p] of parts.entries()) await putChunk(admin, up.uploadId, i, p).expect(204);
    const res = await request(app)
      .post('/api/submissions/upload')
      .set(admin)
      .send({ subject: 'Chunked submission', fromAddress: 'b@broker.test', uploadIds: [up.uploadId] })
      .expect(201);
    const submissionId = res.body.id as string;
    const { rows: docs } = await pool.query('SELECT id, filename, storage_key FROM documents WHERE submission_id=$1', [
      submissionId,
    ]);
    expect(docs.map((d) => d.filename)).toEqual(['acord-125.pdf']);
    expect(driveFiles.get(docs[0].storage_key)?.data.equals(data)).toBe(true); // assembled byte for byte
    const { rows: jobs } = await pool.query(
      `SELECT kind FROM jobs WHERE payload->>'submissionId' = $1 AND status = 'queued'`,
      [submissionId],
    );
    expect(jobs.length).toBeGreaterThan(0);
    expect(await store.meta(up.uploadId)).toBeNull(); // chunks removed once used
  });

  it('adds documents to a submission from uploadIds', async () => {
    const created = await request(app)
      .post('/api/submissions/upload')
      .set(admin)
      .send({ subject: 'Docs later', fromAddress: 'b@broker.test', uploadIds: [] })
      .expect(201);
    const { data, parts } = fileOf(500);
    const up = await declare(admin, data.length, 'schedule.pdf');
    await putChunk(admin, up.uploadId, 0, parts[0]!).expect(204);
    await request(app)
      .post(`/api/submissions/${created.body.id}/documents`)
      .set(admin)
      .send({ uploadIds: [up.uploadId] })
      .expect(201);
    const { rows } = await pool.query('SELECT filename FROM documents WHERE submission_id=$1', [created.body.id]);
    expect(rows.map((r) => r.filename)).toEqual(['schedule.pdf']);
  });
});

describe('stale uploads', () => {
  it('the retention purge deletes uploads older than 24 h and keeps newer ones', async () => {
    const { createMemoryChunkStore, purgeStaleUploads } = await import('../src/modules/uploads/chunkStore.js');
    const s = createMemoryChunkStore();
    const base = { userId: 'u', filename: 'f.pdf', mimeType: 'application/pdf', size: 1, chunkCount: 1 };
    const now = new Date('2026-11-19T12:00:00Z');
    const old = await s.create({ ...base, createdAt: '2026-11-18T11:00:00Z' });
    const fresh = await s.create({ ...base, createdAt: '2026-11-19T11:00:00Z' });
    await s.put(old, 0, new Uint8Array([1]));
    expect(await purgeStaleUploads(s, now)).toBe(1);
    expect(await s.meta(old)).toBeNull();
    expect(await s.meta(fresh)).not.toBeNull();
  });
});

describe('events in netlify runtime', () => {
  it('stream returns 503 in netlify runtime', async () => {
    const res = await request(app).get('/api/events/stream').set(admin).expect(503);
    expect(res.body.error.code).toBe('SSE_UNAVAILABLE');
    await request(app).get('/api/events/since').set(admin).expect(200); // the poll transport works
  });
});
