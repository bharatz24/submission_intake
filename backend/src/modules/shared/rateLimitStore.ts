import { createHash } from 'node:crypto';

import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';

import { config } from '../../config.js';
import { pool, type Queryable } from '../../db/pool.js';
import { logger } from '../../logger.js';

/** Expired rows are swept at most this often per store (on an increment; no timer to stop at shutdown). */
const SWEEP_EVERY_MS = 60_000;

/**
 * express-rate-limit store on the `rate_limit_hits` table (migration 028), so every API instance shares one count per
 * client and a deploy does not reset it (API-01). One atomic upsert per hit: a key whose window has ended starts a new
 * window at 1, otherwise its count goes up by one. Keys are prefixed per limiter, so one table serves them all.
 */
export class PostgresRateLimitStore implements Store {
  /** Shared counts: a hit on one instance counts on every other. */
  readonly localKeys = false;
  private windowMs = 60_000;
  private lastSweep = 0;

  constructor(
    readonly prefix: string,
    private readonly db: Queryable = pool,
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  /** Hashed: client keys can hold an email address or an IP, which the table never needs to store. */
  private k(key: string) {
    return `${this.prefix}:${createHash('sha256').update(key).digest('base64url')}`;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const {
      rows: [r],
    } = await this.db.query<{ hits: number; reset_at: Date }>(
      'SELECT hits, reset_at FROM rate_limit_hits WHERE key=$1 AND reset_at > now()',
      [this.k(key)],
    );
    return r ? { totalHits: r.hits, resetTime: new Date(r.reset_at) } : undefined;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    this.sweepSoon();
    const {
      rows: [r],
    } = await this.db.query<{ hits: number; reset_at: Date }>(
      `INSERT INTO rate_limit_hits AS h (key, hits, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2::float8 / 1000))
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN h.reset_at <= now() THEN 1 ELSE h.hits + 1 END,
         reset_at = CASE WHEN h.reset_at <= now() THEN EXCLUDED.reset_at ELSE h.reset_at END
       RETURNING hits, reset_at`,
      [this.k(key), this.windowMs],
    );
    if (!r) throw new Error('rate-limit upsert returned no row');
    return { totalHits: r.hits, resetTime: new Date(r.reset_at) };
  }

  async decrement(key: string): Promise<void> {
    await this.db.query('UPDATE rate_limit_hits SET hits = greatest(hits - 1, 0) WHERE key=$1 AND reset_at > now()', [
      this.k(key),
    ]);
  }

  async resetKey(key: string): Promise<void> {
    await this.db.query('DELETE FROM rate_limit_hits WHERE key=$1', [this.k(key)]);
  }

  async resetAll(): Promise<void> {
    await this.db.query('DELETE FROM rate_limit_hits WHERE starts_with(key, $1)', [`${this.prefix}:`]);
  }

  /** Deletes ended windows of every limiter (any store may do it; the DELETE is idempotent). */
  private sweepSoon(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    void this.db
      .query(`DELETE FROM rate_limit_hits WHERE reset_at < now() - interval '1 minute'`)
      .catch((err) => logger.warn({ err }, 'rate-limit sweep failed'));
  }
}

/** Which store limiters use: RATE_LIMIT_STORE, else postgres except under NODE_ENV=test (in-memory there). */
export const sharedRateLimits = () =>
  (config.RATE_LIMIT_STORE ?? (config.NODE_ENV === 'test' ? 'memory' : 'postgres')) === 'postgres';

/**
 * Options to spread into a rateLimit() call: a shared Postgres store named `prefix` (one store per limiter, as
 * express-rate-limit requires), or nothing (its default per-process memory store). A database error lets the request
 * through (passOnStoreError) and is logged, so an outage of the counter table never takes the API down with it.
 */
export function rateLimitStore(prefix: string, db?: Queryable): Partial<Pick<Options, 'store' | 'passOnStoreError'>> {
  if (!sharedRateLimits()) return {};
  return { store: new PostgresRateLimitStore(prefix, db), passOnStoreError: true };
}
