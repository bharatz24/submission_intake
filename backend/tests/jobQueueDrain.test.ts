/**
 * Drain mode of the job queue (services/jobQueue.ts runUntilIdle) as the Netlify background worker uses it, against a
 * real PostgreSQL database (its own `ims_test_jobs_drain`). RUNTIME=netlify, so enqueue triggers the worker
 * (mocked here) instead of starting the poll loop; the server-mode loop is covered by jobQueue.test.ts.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DB = (process.env.TEST_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_test').replace(
  /\/[^/]+$/,
  '/ims_test_jobs_drain',
);
process.env.DATABASE_URL = TEST_DB;
process.env.RUNTIME = 'netlify';
process.env.WORKER_TOKEN = 'drain-test-worker-token-0123456789abcdef';
process.env.JOB_LEASE_SECONDS = '10';

const triggerWorker = vi.fn(async () => undefined);
vi.mock('../src/runtime/workerTrigger.js', () => ({ triggerWorker }));

let pool: pg.Pool;
let jobs: typeof import('../src/services/jobQueue.js').jobs;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ims_test_jobs_drain WITH (FORCE)');
  await admin.query('CREATE DATABASE ims_test_jobs_drain');
  await admin.end();
  await (await import('../src/db/migrate.js')).migrate();
  ({ pool } = await import('../src/db/pool.js'));
  ({ jobs } = await import('../src/services/jobQueue.js'));
});

afterAll(async () => {
  await (await import('../src/services/pgListen.js')).closeListener();
  if (pool) await (await import('../src/db/pool.js')).closePools();
});

beforeEach(async () => {
  triggerWorker.mockClear();
  await pool.query('DELETE FROM jobs');
});

const row = async (key: string) =>
  (await pool.query('SELECT * FROM jobs WHERE dedupe_key=$1 ORDER BY id DESC LIMIT 1', [key])).rows[0];
const FAST = { claimDeadlineMs: 10_000, hardDeadlineMs: 20_000, idleGraceMs: 0 };

describe('drain mode', () => {
  it('enqueue in netlify runtime triggers worker and does not start the poll loop', async () => {
    jobs.register('comparison', async () => undefined);
    expect(await jobs.enqueue('comparison', 'cmp:trigger', { comparisonId: 't' })).toBe(true);
    expect(triggerWorker).toHaveBeenCalledWith('jobs');
    expect(await jobs.enqueueMany('comparison', [{ key: 'cmp:many', payload: { comparisonId: 'm' } }])).toEqual([
      'cmp:many',
    ]);
    expect(triggerWorker).toHaveBeenCalledTimes(2);
    expect(jobs.heartbeatAgeMs()).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect((await row('cmp:trigger')).status).toBe('queued'); // nothing claims it until the worker drains
  });

  it('runUntilIdle runs all queued jobs then resolves', async () => {
    const seen: string[] = [];
    jobs.register('comparison', async ({ comparisonId }) => {
      await new Promise((r) => setTimeout(r, 20));
      seen.push(comparisonId);
    });
    await jobs.enqueueMany(
      'comparison',
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ key: `cmp:${id}`, payload: { comparisonId: id } })),
    );
    const result = await jobs.runUntilIdle(FAST);
    expect(result).toEqual({ ran: 5, released: 0 });
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(await jobs.depth()).toBe(0);
    expect(jobs.heartbeatAgeMs()).toBeNull();
  });

  it('runs a job queued by a running handler before going idle', async () => {
    const seen: string[] = [];
    jobs.register('comparison', async ({ comparisonId }) => {
      seen.push(comparisonId);
      if (comparisonId === 'parent') await jobs.enqueue('comparison', 'cmp:child', { comparisonId: 'child' });
    });
    await jobs.enqueue('comparison', 'cmp:parent', { comparisonId: 'parent' });
    expect(await jobs.runUntilIdle(FAST)).toEqual({ ran: 2, released: 0 });
    expect(seen).toEqual(['parent', 'child']);
  });

  it('runUntilIdle stops claiming after claimDeadlineMs and releases running jobs at hardDeadlineMs with attempt refunded', async () => {
    jobs.register('comparison', async ({ comparisonId }, signal) => {
      if (comparisonId !== 'slow') return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    await jobs.enqueue('comparison', 'cmp:slow', { comparisonId: 'slow' });
    const drained = jobs.runUntilIdle({ claimDeadlineMs: 300, hardDeadlineMs: 900, idleGraceMs: 0 });
    await new Promise((r) => setTimeout(r, 500)); // past the claim deadline
    await jobs.enqueue('comparison', 'cmp:late', { comparisonId: 'late' });
    expect(await drained).toEqual({ ran: 1, released: 1 });
    const slow = await row('cmp:slow');
    expect(slow.status).toBe('queued');
    expect(slow.attempts).toBe(0); // released, not counted
    expect(slow.locked_by).toBeNull();
    expect((await row('cmp:late')).status).toBe('queued'); // left for the next worker
    // The queue is usable again after a hard stop (a warm function instance runs the next drain): it runs the late
    // job and takes the slow one again, which is released once more.
    expect(await jobs.runUntilIdle({ claimDeadlineMs: 300, hardDeadlineMs: 900, idleGraceMs: 0 })).toEqual({
      ran: 2,
      released: 1,
    });
    expect((await row('cmp:late')).status).toBe('done');
    expect((await row('cmp:slow')).attempts).toBe(0);
  }, 15_000);

  it('reclaims a job whose worker vanished', async () => {
    const seen: string[] = [];
    jobs.register('process', async ({ submissionId }) => {
      seen.push(submissionId);
    });
    // A run killed at the function time limit: still `running`, its lease lapsed, nobody renewing it.
    await pool.query(
      `INSERT INTO jobs (kind, dedupe_key, payload, status, attempts, max_attempts, locked_by, locked_until)
       VALUES ('process', 'proc:vanished', $1, 'running', 1, 3, 'gone-worker', now() - interval '1 minute')`,
      [JSON.stringify({ submissionId: 'vanished', actorId: null })],
    );
    expect(await jobs.runUntilIdle(FAST)).toEqual({ ran: 1, released: 0 });
    const r = await row('proc:vanished');
    expect(r.status).toBe('done');
    expect(r.attempts).toBe(2);
    expect(seen).toEqual(['vanished']);
  });

  it('a second drain in the same instance returns at once instead of running beside the first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    jobs.register('comparison', async () => gate);
    await jobs.enqueue('comparison', 'cmp:gate', { comparisonId: 'g' });
    const first = jobs.runUntilIdle(FAST);
    await new Promise((r) => setTimeout(r, 200));
    expect(await jobs.runUntilIdle(FAST)).toEqual({ ran: 0, released: 0 });
    release();
    expect(await first).toEqual({ ran: 1, released: 0 });
  });
});
