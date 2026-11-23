/**
 * A dropped database connection (Postgres restart or failover, pg_terminate_backend) must not kill the process
 * (QA-010): both pools log the error, replace the connection, and the app keeps answering. Real database.
 */
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, stopTestApp, testDatabaseUrl } from './helpers/apiTestDb.js';

const DB_NAME = 'ims_test_db_resilience';
process.env.DATABASE_URL = testDatabaseUrl(DB_NAME);

let app: Express;
let pool: pg.Pool;
let lockPool: pg.Pool;

beforeAll(async () => {
  ({ app, pool } = await startTestApp(DB_NAME));
  ({ lockPool } = await import('../src/db/pool.js'));
});

afterAll(async () => {
  await stopTestApp();
});

/** Ends every other session on this database, as a Postgres restart does (SQLSTATE 57P01 for each of them). */
async function terminateConnections(from: pg.PoolClient) {
  await from.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()`,
    [DB_NAME],
  );
  // The 'error' events arrive asynchronously, once each socket closes.
  await new Promise((r) => setTimeout(r, 300));
}

describe('dropped database connections', () => {
  it('keeps the process alive when idle connections are terminated, and answers again', async () => {
    // Several idle clients in both pools.
    await Promise.all([1, 2, 3].map(() => pool.query('SELECT 1')));
    await lockPool.query('SELECT 1');
    expect(pool.idleCount).toBeGreaterThan(0);

    const killer = await pool.connect();
    try {
      await terminateConnections(killer);
    } finally {
      killer.release(true);
    }

    // Still here (an unhandled 'error' event would have failed the run), and the pools open fresh connections.
    expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    expect((await lockPool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('survives a checked-out lock connection being terminated while held', async () => {
    const held = await lockPool.connect();
    const killer = await pool.connect();
    try {
      await terminateConnections(killer);
    } finally {
      killer.release(true);
    }
    // The held client is broken: its next query fails, it is discarded, and the pool carries on.
    await expect(held.query('SELECT 1')).rejects.toThrow();
    held.release(true);
    expect((await lockPool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });
});
