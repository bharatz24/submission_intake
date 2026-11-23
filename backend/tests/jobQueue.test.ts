/**
 * Durable job queue (services/jobQueue.ts) against a real PostgreSQL database (TEST_DATABASE_URL, default the
 * docker-compose db; uses its own `ims_test_jobs` database). Handlers are test doubles registered on real kinds.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DB = (process.env.TEST_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_test').replace(
  /\/[^/]+$/,
  '/ims_test_jobs',
);
process.env.DATABASE_URL = TEST_DB;
process.env.JOB_POLL_INTERVAL_MS = '100';
process.env.JOB_LEASE_SECONDS = '10'; // renewals every ~3 s, so the lost-lease test sees one quickly

let pool: pg.Pool;
let jobs: typeof import('../src/services/jobQueue.js').jobs;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ims_test_jobs WITH (FORCE)');
  await admin.query('CREATE DATABASE ims_test_jobs');
  await admin.end();
  await (await import('../src/db/migrate.js')).migrate();
  ({ pool } = await import('../src/db/pool.js'));
  ({ jobs } = await import('../src/services/jobQueue.js'));
});

afterAll(async () => {
  await jobs?.stop(2000);
  await (await import('../src/services/pgListen.js')).closeListener();
  if (pool) await (await import('../src/db/pool.js')).closePools();
});

const row = async (key: string) =>
  (await pool.query('SELECT * FROM jobs WHERE dedupe_key=$1 ORDER BY id DESC LIMIT 1', [key])).rows[0];
async function until(ok: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('job queue', () => {
  it('runs a job once per key, and queues a re-run behind a running one instead of running it alongside', async () => {
    let running = 0;
    let maxRunning = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runs: string[] = [];
    jobs.register('comparison', async ({ comparisonId }) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      runs.push(comparisonId);
      if (comparisonId === 'first') await gate;
      running--;
    });
    expect(await jobs.enqueue('comparison', 'cmp:a', { comparisonId: 'first' })).toBe(true);
    await until(async () => (await row('cmp:a'))?.status === 'running');
    // Running: a second one may wait behind it, a third is refused (one is already waiting).
    expect(await jobs.enqueue('comparison', 'cmp:a', { comparisonId: 'second' })).toBe(true);
    expect(await jobs.enqueue('comparison', 'cmp:a', { comparisonId: 'third' })).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(runs).toEqual(['first']);
    release();
    await jobs.drain();
    expect(runs).toEqual(['first', 'second']);
    expect(maxRunning).toBe(1);
    expect(await jobs.depth()).toBe(0);
  });

  it('retries with backoff, then fails the job and records a system error', async () => {
    let calls = 0;
    jobs.register(
      'extract',
      async () => {
        calls++;
        throw new Error('boom');
      },
      { maxAttempts: 2 },
    );
    await jobs.enqueue('extract', 'ext:poison', { submissionId: 's', documentIds: [], actorId: null });
    await until(
      async () => (await row('ext:poison'))?.attempts === 1 && (await row('ext:poison'))?.status === 'queued',
    );
    const first = await row('ext:poison');
    expect(new Date(first.run_after).getTime()).toBeGreaterThan(Date.now() + 20_000); // backed off, not hot-looping
    expect(first.last_error).toContain('boom');
    await pool.query(`UPDATE jobs SET run_after=now() WHERE dedupe_key='ext:poison'`);
    await until(async () => (await row('ext:poison'))?.status === 'failed');
    expect(calls).toBe(2);
    // The system error is written just after the job is marked failed (jobQueue.ts), so wait for it rather than race it.
    await until(
      async () => (await pool.query(`SELECT 1 FROM system_errors WHERE scope='job:ext:poison'`)).rowCount === 1,
    );
  });

  it('fails at once when the handler opts out of retries', async () => {
    jobs.register(
      'report',
      async () => {
        throw new Error('recorded by the handler');
      },
      { retryOnError: false },
    );
    await jobs.enqueue('report', 'rep:x', { reportId: 'x', submissionId: 's', actorId: null });
    await until(async () => (await row('rep:x'))?.status === 'failed');
    expect((await row('rep:x')).attempts).toBe(1);
  });

  it('reclaims a job whose worker died (lapsed lease), and abandons it after max attempts', async () => {
    const seen: string[] = [];
    jobs.register('process', async ({ submissionId }) => {
      seen.push(submissionId);
    });
    // A job left running by a dead worker, lease already expired.
    await pool.query(
      `INSERT INTO jobs (kind, dedupe_key, payload, status, attempts, max_attempts, locked_by, locked_until)
       VALUES ('process', 'proc:dead', '{"submissionId":"dead","actorId":null}', 'running', 1, 3, 'gone:1', now() - interval '1 second'),
              ('process', 'proc:crashloop', '{"submissionId":"loop","actorId":null}', 'running', 3, 3, 'gone:1', now() - interval '1 second')`,
    );
    await until(
      async () => (await row('proc:dead'))?.status === 'done' && (await row('proc:crashloop'))?.status === 'failed',
    );
    expect(seen).toEqual(['dead']);
    expect((await row('proc:crashloop')).last_error).toMatch(/Abandoned after 3 attempts/);
  });

  it('never runs a lapsed job and the queued re-run of the same key together', async () => {
    let running = 0;
    let maxRunning = 0;
    const seen: string[] = [];
    jobs.register('auto-quote', async ({ reportId }) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      seen.push(reportId);
      await new Promise((r) => setTimeout(r, 200));
      running--;
    });
    await pool.query(
      `INSERT INTO jobs (kind, dedupe_key, payload, status, attempts, max_attempts, locked_by, locked_until)
       VALUES ('auto-quote', 'aq:k', '{"reportId":"lapsed","submissionId":"s"}', 'running', 1, 3, 'gone:1', now() - interval '1 second')`,
    );
    await pool.query(
      `INSERT INTO jobs (kind, dedupe_key, payload, run_after) VALUES ('auto-quote', 'aq:k', '{"reportId":"queued","submissionId":"s"}', now() - interval '1 minute')`,
    );
    jobs.start();
    await until(
      async () =>
        (await pool.query(`SELECT 1 FROM jobs WHERE dedupe_key='aq:k' AND status IN ('queued','running')`)).rowCount ===
        0,
    );
    expect(seen).toEqual(['lapsed', 'queued']);
    expect(maxRunning).toBe(1);
  });

  it('stops writing for a job whose lease was taken over, and aborts its handler', async () => {
    let signal!: AbortSignal;
    let release!: () => void;
    jobs.register('extract', (_p, s) => {
      signal = s;
      return new Promise<void>((r) => {
        release = r;
      });
    });
    await jobs.enqueue('extract', 'ext:stolen', { submissionId: 's', documentIds: [], actorId: null });
    await until(async () => (await row('ext:stolen'))?.status === 'running' && Boolean(signal));
    await pool.query(`UPDATE jobs SET locked_by='other:1' WHERE dedupe_key='ext:stolen'`);
    await until(async () => signal.aborted, 15_000);
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(await row('ext:stolen')).toMatchObject({ status: 'running', locked_by: 'other:1' });
    await pool.query(`UPDATE jobs SET status='done' WHERE dedupe_key='ext:stolen'`);
  }, 20_000);

  it('enqueues inside a transaction only when it commits', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    expect(await jobs.enqueue('process', 'proc:tx', { submissionId: 'tx', actorId: null }, { db: client })).toBe(true);
    await client.query('ROLLBACK');
    client.release();
    expect(await row('proc:tx')).toBeUndefined();
  });

  it('hands unfinished jobs back on stop, without counting the attempt', async () => {
    let release!: () => void;
    jobs.register(
      'comparison',
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    await jobs.enqueue('comparison', 'cmp:slow', { comparisonId: 'slow' });
    await until(async () => (await row('cmp:slow'))?.status === 'running');
    await jobs.stop(200);
    const r = await row('cmp:slow');
    expect(r).toMatchObject({ status: 'queued', attempts: 0, locked_by: null });
    release();
  });
});
