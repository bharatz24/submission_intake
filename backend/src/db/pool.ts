import pg from 'pg';

import { config } from '../config.js';
import { logger } from '../logger.js';

/** libpq `options` that set per-session server limits on every connection a pool opens. */
const sessionOptions = (settings: Record<string, number>) =>
  Object.entries(settings)
    .map(([k, v]) => `-c ${k}=${v}`)
    .join(' ');

/**
 * The application pool: every query, transaction and request. A statement that runs longer than
 * DB_STATEMENT_TIMEOUT_MS is cancelled, one that waits longer than DB_LOCK_TIMEOUT_MS for a lock fails, and a session
 * left idle inside a transaction is closed, so one stuck query or a leaked client can never hold a connection (and its
 * locks) forever. A caller that cannot get a connection within DB_CONNECTION_TIMEOUT_MS (pool saturated, database
 * unreachable) gets an error, answered as 503 by errorHandler.ts, instead of waiting forever (DB-10).
 * application_name tells the two pools (and this app) apart in pg_stat_activity.
 */
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
  application_name: 'ims-submission-review',
  options: sessionOptions({
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    lock_timeout: config.DB_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: config.DB_IDLE_IN_TX_TIMEOUT_MS,
  }),
});

/**
 * A small separate pool for session-level advisory locks held for a long time (a pipeline run, the Gmail poll, the
 * migrator), so they never pin connections of the application pool. No statement_timeout or lock_timeout here:
 * `pg_advisory_lock` waits for the holder, and migrations may run long statements (the migrator sets its own
 * lock_timeout per migration). Idle-in-transaction is still bounded.
 */
export const lockPool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_LOCK_POOL_MAX,
  // No connectionTimeoutMillis: its users are bounded by JOB_CONCURRENCY and may legitimately wait for a free one.
  application_name: 'ims-submission-review-locks',
  options: sessionOptions({ idle_in_transaction_session_timeout: config.DB_IDLE_IN_TX_TIMEOUT_MS }),
});

/**
 * A dropped connection (Postgres restart or failover, an admin terminating the backend: 57P01) is emitted as an
 * 'error' event, on the pool for an idle client and on the client itself while it is checked out. An 'error' event
 * nobody listens to throws and kills the process (QA-010). Logged here instead: the pool discards the broken client
 * and opens a new one on the next query, and a query that was running on it rejects as usual.
 */
function survivesDroppedConnections(p: pg.Pool, name: string): void {
  const onError = (err: Error) => logger.warn({ err, pool: name }, 'database connection lost; it will be replaced');
  p.on('error', onError);
  p.on('connect', (client) => client.on('error', onError));
}
survivesDroppedConnections(pool, 'app');
survivesDroppedConnections(lockPool, 'lock');

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

/** Closes both pools (graceful shutdown, CLI exit, tests). */
export async function closePools(): Promise<void> {
  await Promise.all([pool.end(), lockPool.end()]);
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // A connection that could not roll back is destroyed (release(err)), never handed back to the pool mid-transaction.
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((e: Error) => {
      broken = e;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
