import pg from 'pg';

import { config } from '../config.js';
import { LOCK_NAMESPACE } from '../db/advisoryLocks.js';
import { lockPool, pool } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * Cross-instance signals over Postgres LISTEN/NOTIFY: one dedicated connection per process (a pooled one would
 * drop its LISTENs when returned). Reconnects with backoff; a notification sent while disconnected is lost, so
 * every user of this treats a signal as a hint and has its own fallback (job polling, SSE replay cursor, TTL).
 */

type Handler = (payload: string) => void;
const handlers = new Map<string, Set<Handler>>();
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;
let closed = false;
let retryMs = 1000;
let retryTimer: NodeJS.Timeout | null = null;

/** Run `fn` for every NOTIFY on `channel` (any instance). Resolves once this process is listening. */
export async function listen(channel: string, fn: Handler): Promise<() => void> {
  let set = handlers.get(channel);
  const fresh = !set;
  if (!set) handlers.set(channel, (set = new Set()));
  set.add(fn);
  await connect();
  if (fresh && client)
    await client.query(`LISTEN ${quoteIdent(channel)}`).catch((err) => logger.warn({ err, channel }, 'LISTEN failed'));
  return () => {
    set!.delete(fn);
  };
}

/** NOTIFY every instance (this one included). Payloads must stay under Postgres' 8000-byte limit. */
export async function notify(channel: string, payload = ''): Promise<void> {
  await pool.query('SELECT pg_notify($1, $2)', [channel, payload]);
}

export async function closeListener(): Promise<void> {
  closed = true;
  if (retryTimer) clearTimeout(retryTimer);
  const c = client;
  client = null;
  await c?.end().catch(() => undefined);
}

function connect(): Promise<void> {
  if (closed || client) return Promise.resolve();
  connecting ??= (async () => {
    const c = new pg.Client({ connectionString: config.DATABASE_URL });
    c.on('notification', (msg) => {
      for (const fn of handlers.get(msg.channel) ?? []) {
        try {
          fn(msg.payload ?? '');
        } catch (err) {
          logger.warn({ err, channel: msg.channel }, 'notification handler failed');
        }
      }
    });
    c.on('error', (err) => {
      logger.warn({ err }, 'LISTEN connection lost; reconnecting');
      if (client === c) client = null;
      void c.end().catch(() => undefined);
      scheduleReconnect();
    });
    try {
      await c.connect();
      for (const channel of handlers.keys()) await c.query(`LISTEN ${quoteIdent(channel)}`);
      client = c;
      retryMs = 1000;
    } catch (err) {
      logger.warn({ err }, 'LISTEN connection failed; retrying');
      void c.end().catch(() => undefined);
      scheduleReconnect();
    }
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

function scheduleReconnect() {
  if (closed || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, retryMs).unref();
  retryMs = Math.min(retryMs * 2, 30_000);
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Run `fn` only if no other session (any instance) holds the advisory lock `name` (two-key, in the
 * LOCK_NAMESPACE.singleton namespace); returns null when it is held.
 * Session-level lock on one connection of the lock pool (so it never pins an application connection), released when
 * `fn` settles (or the connection dies).
 */
export async function withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const c = await lockPool.connect();
  let locked = false;
  let broken = false;
  try {
    const {
      rows: [r],
    } = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [
      LOCK_NAMESPACE.singleton,
      name,
    ]);
    locked = r!.ok;
    if (!locked) return null;
    return await fn();
  } finally {
    // A connection that could not unlock is destroyed, so the lock never lingers in the pool.
    if (locked)
      await c.query('SELECT pg_advisory_unlock($1, hashtext($2))', [LOCK_NAMESPACE.singleton, name]).catch(() => {
        broken = true;
      });
    c.release(broken);
  }
}
