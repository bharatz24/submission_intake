/**
 * Setup shared by API suites that run the real app against their own throwaway database (TEST_DATABASE_URL host,
 * database `name`). Call `testDatabaseUrl` at module scope and assign it to process.env.DATABASE_URL before anything
 * imports src/config.ts; mock Claude/NPI/Drive in the test file itself (vi.mock is hoisted per file).
 */
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';

import { DEFAULT_TEST_DATABASE_URL } from './globalSetup.js';

// globalSetup.ts has already refused a non-test database name and an unreachable server (TEST-05).
const BASE = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

export const testDatabaseUrl = (name: string) => BASE.replace(/\/[^/]+$/, `/${name}`);

/** Drop and recreate `name`, migrate it, and build the app. */
export async function startTestApp(name: string): Promise<{ app: Express; pool: pg.Pool }> {
  const admin = new pg.Client({ connectionString: BASE.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  await (await import('../../src/db/migrate.js')).migrate();
  const { pool } = await import('../../src/db/pool.js');
  return { app: (await import('../../src/app.js')).createApp(), pool };
}

/** Workers and the LISTEN connection first, so nothing touches the pool after it ends. */
export async function stopTestApp(): Promise<void> {
  await (await import('../../src/services/jobQueue.js')).jobs.stop(5000);
  await (await import('../../src/services/pgListen.js')).closeListener();
  await (await import('../../src/db/pool.js')).closePools();
}

/** Registers the first user (an ADMIN) and returns a bearer header for them. */
export async function registerAdmin(app: Express): Promise<{ Authorization: string }> {
  await request(app)
    .post('/api/auth/register')
    .send({ email: 'admin@example.com', password: 'correct-horse-battery', name: 'Ada Admin' });
  const { token } = (
    await request(app)
      .post('/api/auth/login')
      .set({ 'X-Client': 'cli' })
      .send({ email: 'admin@example.com', password: 'correct-horse-battery' })
  ).body;
  return { Authorization: `Bearer ${token}` };
}

/** A user inserted directly (logins are rate limited) and a bearer header for them. */
export async function makeUser(
  pool: pg.Pool,
  email: string,
  role: 'ADMIN' | 'UNDERWRITER' | 'VIEWER',
): Promise<{ id: string; name: string; auth: { Authorization: string } }> {
  const { signToken } = await import('../../src/http.js');
  const name = email.split('@')[0] ?? email;
  const {
    rows: [u],
  } = await pool.query(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,'x',$3) RETURNING id, token_version`,
    [email, name, role],
  );
  return {
    id: u.id,
    name,
    auth: { Authorization: `Bearer ${signToken({ id: u.id, email, name, role }, u.token_version)}` },
  };
}

/** Polls `fn` until `ok` holds, failing with the last value after `ms`. */
export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout; last value: ${JSON.stringify(v).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Uploads an email (optionally with one text attachment) and waits until processing has finished. */
export async function uploadAndProcess(
  app: Express,
  auth: { Authorization: string },
  email: { subject: string; bodyText: string; attachment?: { name: string; text: string } },
): Promise<{ id: string; status: string; [key: string]: unknown }> {
  let req = request(app)
    .post('/api/submissions/upload')
    .set(auth)
    .field('subject', email.subject)
    .field('fromAddress', 'broker@acme.com')
    .field('bodyText', email.bodyText);
  if (email.attachment) req = req.attach('files', Buffer.from(email.attachment.text), email.attachment.name);
  const res = await req;
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return waitFor(
    async () => (await request(app).get(`/api/submissions/${res.body.id}`).set(auth)).body,
    (b) => b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR',
  );
}
