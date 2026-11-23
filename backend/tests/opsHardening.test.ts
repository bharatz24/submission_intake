/**
 * Production hardening against a real PostgreSQL database (TEST_DATABASE_URL host, database ims_test_c): the shared
 * Postgres rate-limit store (API-01), health/metrics before the limiter and the job-loop heartbeat (MON-02/03), 202 +
 * background admin actions (PERF-01), parked Gmail ingests (PERF-07), the SSE caps (PERF-08) and bulk job enqueue
 * (PERF-09). External systems are fakes injected through createApp(deps).
 */
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerAdmin, startTestApp, stopTestApp, testDatabaseUrl } from './helpers/apiTestDb.js';

process.env.DATABASE_URL = testDatabaseUrl('ims_test_c');
const METRICS_TOKEN = 'metrics-token-for-tests-0123456789';
process.env.METRICS_TOKEN = METRICS_TOKEN;
process.env.INGEST_MAX_ATTEMPTS = '2';
process.env.SSE_MAX_TOTAL = '1';

let app: Express;
let pool: pg.Pool;
let auth: { Authorization: string };

beforeAll(async () => {
  ({ app, pool } = await startTestApp('ims_test_c'));
  auth = await registerAdmin(app);
});
afterAll(async () => {
  await stopTestApp();
});

describe('shared rate-limit store (API-01)', () => {
  /** Two "instances": separate apps and limiters, one table. */
  async function twoInstances(limit: number, windowMs: number) {
    const { PostgresRateLimitStore } = await import('../src/modules/shared/rateLimitStore.js');
    const prefix = `t${Math.random().toString(36).slice(2, 8)}`;
    const make = () => {
      const a = express();
      a.set('trust proxy', true);
      a.use(
        rateLimit({
          store: new PostgresRateLimitStore(prefix, pool),
          windowMs,
          limit,
          standardHeaders: 'draft-8',
          legacyHeaders: false,
        }),
      );
      a.get('/', (_req, res) => {
        res.json({ ok: true });
      });
      return a;
    };
    return { a: make(), b: make(), prefix };
  }

  it('counts hits from every instance together, keyed without the raw client address', async () => {
    const { a, b, prefix } = await twoInstances(2, 60_000);
    const hit = (x: Express) => request(x).get('/').set('X-Forwarded-For', '203.0.113.50');
    expect((await hit(a)).status).toBe(200);
    expect((await hit(b)).status).toBe(200);
    expect((await hit(a)).status).toBe(429);
    expect((await hit(b)).status).toBe(429);
    // Another client is counted on its own.
    expect((await request(b).get('/').set('X-Forwarded-For', '198.51.100.1')).status).toBe(200);
    const { rows } = await pool.query('SELECT key, hits FROM rate_limit_hits WHERE starts_with(key, $1)', [
      `${prefix}:`,
    ]);
    expect(rows.map((r) => r.hits).sort()).toEqual([1, 4]);
    expect(rows.every((r) => !r.key.includes('203.0.113'))).toBe(true);
  });

  it('starts a new window once the old one ends', async () => {
    const { a } = await twoInstances(1, 300);
    const hit = () => request(a).get('/').set('X-Forwarded-For', '192.0.2.77');
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
    await new Promise((r) => setTimeout(r, 400));
    expect((await hit()).status).toBe(200);
  });
});

describe('health, readiness and metrics (MON-02, MON-03)', () => {
  it('answers health before the /api rate limiter, and other routes behind it', async () => {
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.headers.ratelimit).toBeUndefined();
    const other = await request(app).get('/api/auth/bootstrap');
    expect(other.headers.ratelimit).toBeDefined();
  });

  it('reports the job loop heartbeat on /ready once the loop runs', async () => {
    const { jobs } = await import('../src/services/jobQueue.js');
    jobs.start();
    await vi.waitFor(() => expect(jobs.heartbeatAgeMs()).not.toBeNull());
    const ready = await request(app).get('/api/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ ok: true, db: true, migrations: true, jobLoop: true });
  });

  it('serves Prometheus metrics only with the bearer token', async () => {
    expect((await request(app).get('/api/metrics')).status).toBe(401);
    expect((await request(app).get('/api/metrics').set('Authorization', 'Bearer wrong')).status).toBe(401);
    const res = await request(app).get('/api/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of [
      'ims_http_request_duration_seconds_bucket',
      'ims_ingest_queue{state="parked"}',
      'ims_ingest_queue_oldest_age_seconds',
      'ims_job_loop_heartbeat_age_seconds',
      'ims_process_cpu_user_seconds_total',
    ])
      expect(res.text).toContain(name);
    // Route templates, never ids.
    expect(res.text).toContain('route="/api/auth/bootstrap"');
  });
});

describe('admin actions in the background (PERF-01)', () => {
  it('POST /gmail/poll answers 202 and polls in the background, audited when done', async () => {
    const { createApp } = await import('../src/app.js');
    const { integrations } = await import('../src/integrations/index.js');
    const pollOnce = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 3;
    });
    const fake = createApp({ gmail: { ...integrations().gmail, pollOnce } });
    const res = await request(fake).post('/api/gmail/poll').set(auth);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true });
    // A second click while it runs starts nothing new.
    expect((await request(fake).post('/api/gmail/poll').set(auth)).body).toEqual({ started: false });
    const { drainBackground } = await import('../src/services/backgroundTasks.js');
    expect(await drainBackground(5000)).toBe(0);
    expect(pollOnce).toHaveBeenCalledTimes(1);
    expect(pollOnce).toHaveBeenCalledWith({ manual: true });
    const { rows } = await pool.query(`SELECT details FROM audit_events WHERE action='GMAIL_MANUAL_POLL'`);
    expect(rows.map((r) => r.details)).toEqual([{ processed: 3 }]);
  });

  it('"Process as submission" answers 202 and reports the new submission once stored', async () => {
    const { createApp } = await import('../src/app.js');
    const { integrations } = await import('../src/integrations/index.js');
    const { ingestSkippedEmail } = await import('../src/services/pipeline.js');
    await pool.query(
      `INSERT INTO skipped_emails (gmail_message_id, from_address, subject, received_at, confidence, method)
       VALUES ('gm-bg-1', 'broker@bg.test', 'Quote please', now(), 0.9, 'RULES')`,
    );
    const importSkippedMessage = vi.fn((id: string, actor: { id: string; name: string }) =>
      ingestSkippedEmail(
        {
          gmailMessageId: id,
          threadId: null,
          fromAddress: 'broker@bg.test',
          toAddress: 'uw@insurer.test',
          subject: 'Quote please',
          bodyText: 'Please quote this physician.',
          receivedAt: new Date(),
          attachments: [],
        },
        actor,
      ),
    );
    const fake = createApp({ gmail: { ...integrations().gmail, importSkippedMessage } });
    expect((await request(fake).get('/api/skipped-emails/gm-bg-1/process').set(auth)).body).toEqual({
      state: 'idle',
    });
    const res = await request(fake).post('/api/skipped-emails/gm-bg-1/process').set(auth);
    expect(res.status).toBe(202);
    const { drainBackground } = await import('../src/services/backgroundTasks.js');
    await drainBackground(10_000);
    const status = (await request(fake).get('/api/skipped-emails/gm-bg-1/process').set(auth)).body;
    expect(status.state).toBe('done');
    const { rows } = await pool.query(
      `SELECT s.id FROM submissions s JOIN emails e ON e.id = s.email_id WHERE e.gmail_message_id='gm-bg-1'`,
    );
    expect(status.submissionId).toBe(rows[0].id);
  });
});

describe('parked Gmail ingests (PERF-07)', () => {
  it('parks a message after INGEST_MAX_ATTEMPTS failures, keeps it listed, and a manual retry unparks it', async () => {
    const q = await import('../src/services/ingestQueue.js');
    await pool.query(`INSERT INTO gmail_ingest_queue (gmail_message_id, source) VALUES ('gm-poison', 'OAUTH')`);
    const ingest = vi.fn(async () => {
      throw new Error('cannot parse this message');
    });
    for (let i = 0; i < 2; i++) {
      await pool.query(`UPDATE gmail_ingest_queue SET next_attempt_at=now() WHERE gmail_message_id='gm-poison'`);
      await q.drainQueue(ingest);
    }
    expect(ingest).toHaveBeenCalledTimes(2);
    const {
      rows: [row],
    } = await pool.query(`SELECT attempts, parked_at FROM gmail_ingest_queue WHERE gmail_message_id='gm-poison'`);
    expect(row.attempts).toBe(2);
    expect(row.parked_at).not.toBeNull();

    // Parked: never claimed again, even when due.
    await pool.query(`UPDATE gmail_ingest_queue SET next_attempt_at=now() WHERE gmail_message_id='gm-poison'`);
    await q.drainQueue(ingest);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect((await q.listFailed()).find((m) => m.gmailMessageId === 'gm-poison')).toMatchObject({
      parked: true,
      attempts: 2,
    });
    expect((await q.queueStats()).parked).toBe(1);
    const { rows: audits } = await pool.query(
      `SELECT 1 FROM audit_events WHERE action='GMAIL_INGEST_PARKED' AND entity_id='gm-poison'`,
    );
    expect(audits).toHaveLength(1);

    // A manual retry unparks it and makes it due: it is tried once more.
    expect(await q.retryMessage('gm-poison')).toBe(true);
    await q.drainQueue(async () => 'CREATED');
    expect((await pool.query(`SELECT 1 FROM gmail_ingest_queue WHERE gmail_message_id='gm-poison'`)).rowCount).toBe(0);
  });
});

describe('notification stream caps (PERF-08)', () => {
  it('refuses a stream past SSE_MAX_TOTAL with 503', async () => {
    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    const first = new AbortController();
    try {
      const open = await fetch(`http://127.0.0.1:${port}/api/events/stream`, { headers: auth, signal: first.signal });
      expect(open.status).toBe(200);
      const second = await fetch(`http://127.0.0.1:${port}/api/events/stream`, { headers: auth });
      expect(second.status).toBe(503);
      expect((await second.json()).error.code).toBe('STREAMS_FULL');
    } finally {
      first.abort();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    const { openStreamCount } = await import('../src/modules/events/events.routes.js');
    await vi.waitFor(() => expect(openStreamCount()).toBe(0));
  });
});

describe('bulk job enqueue (PERF-09)', () => {
  it('queues many jobs in one statement and skips keys already queued', async () => {
    const { jobs } = await import('../src/services/jobQueue.js');
    await jobs.stop(1000); // nothing claims them while we look
    const items = ['a', 'b', 'c'].map((k) => ({
      key: `comparison:bulk-${k}`,
      payload: { comparisonId: `bulk-${k}` },
    }));
    expect((await jobs.enqueueMany('comparison', items)).sort()).toEqual(items.map((i) => i.key));
    expect(await jobs.enqueueMany('comparison', items)).toEqual([]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE 'comparison:bulk-%'`);
    expect(rows[0].n).toBe(3);
    await pool.query(`DELETE FROM jobs WHERE dedupe_key LIKE 'comparison:bulk-%'`);
  });
});
