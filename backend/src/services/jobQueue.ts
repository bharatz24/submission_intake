import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { config, isNetlifyRuntime } from '../config.js';
import {
  JOB_BACKOFF_BASE_S,
  JOB_BACKOFF_MAX_S,
  JOB_PRUNE_EVERY_MS,
  WORKER_DRAIN_TICK_MS,
  WORKER_IDLE_GRACE_MS,
} from '../constants.js';
import { pool, type Queryable } from '../db/pool.js';
import { logger } from '../logger.js';
import { currentRequestId, withLogContext } from '../requestContext.js';
import { triggerWorker } from '../runtime/workerTrigger.js';
import { recordSystemError } from './audit.js';
import { sleep } from './httpRetry.js';
import { withJobSignal } from './jobContext.js';
import { observeJob, setJobHeartbeatSource } from './metrics.js';
import { listen, notify } from './pgListen.js';
import type { ExternalResults } from './pipeline.js';

/**
 * Durable job queue on the `jobs` table (migrations/001_schema.sql). A job is a kind + JSON payload run by the
 * handler registered for that kind, so any instance can run it. Workers claim with FOR UPDATE SKIP LOCKED and
 * hold a lease they renew while running; a job whose lease lapses (its process died) is claimed again.
 * Errors retry with exponential backoff up to max_attempts, then the job is failed and a system error recorded.
 * Per dedupe key at most one job is queued (enqueue returns false when one is) and one runs: a job enqueued while
 * its key runs waits for that run to finish, so a re-run asked for mid-run is neither lost nor run concurrently.
 * A handler gets an AbortSignal that fires if its lease is lost to another worker; long handlers may stop on it.
 * RUNTIME=netlify has no long-running process: enqueue triggers the background worker function, which drains the
 * table with runUntilIdle (no poll timer, no LISTEN) within the function's time limit.
 */

export interface JobPayloads {
  process: {
    submissionId: string;
    actorId: string | null;
    skipClassification?: boolean;
    byPerson?: boolean;
    resume?: boolean;
    /** Classification and fields produced outside the portal (POST /external-results). */
    external?: ExternalResults;
  };
  /** documentIds: those documents (an upload), else every PENDING one. bumpContext false: a re-read, not new evidence. */
  extract: { submissionId: string; documentIds?: string[]; actorId: string | null; bumpContext?: boolean };
  report: { reportId: string; submissionId: string; actorId: string | null; thenAnalysis?: boolean };
  comparison: { comparisonId: string };
  'auto-quote': { reportId: string; submissionId: string };
  chat: { messageId: string };
  'email-draft': { draftId: string };
}
export type JobKind = keyof JobPayloads;

interface HandlerOptions {
  maxAttempts?: number;
  /** false: an error fails the job at once (the handler recorded the failure itself); only a lapsed lease retries. */
  retryOnError?: boolean;
  /** First retry delay in seconds, doubled per attempt (default JOB_BACKOFF_BASE_S). */
  backoffBaseS?: number;
}
/** Which attempt of its job a handler runs: 1 on the first run, higher after an error retry or a lapsed lease. */
export interface JobAttempt {
  attempt: number;
  maxAttempts: number;
}
type Run = (payload: any, signal: AbortSignal, job: JobAttempt) => Promise<void>;
interface Handler {
  run: Run;
  maxAttempts: number;
  retryOnError: boolean;
  backoffBaseS: number;
}

interface JobRow {
  id: string;
  kind: JobKind;
  dedupe_key: string;
  payload: any;
  attempts: number;
  max_attempts: number;
}

const CHANNEL = 'jobs_enqueued';

/** Payload key carrying the id of the HTTP request that queued the job; removed before the handler sees the payload. */
const ORIGIN_KEY = '_requestId';
const withOrigin = (payload: object) => {
  const requestId = currentRequestId();
  return requestId ? { ...payload, [ORIGIN_KEY]: requestId } : payload;
};

class JobQueue {
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private handlers = new Map<JobKind, Handler>();
  private active = new Map<string, Promise<void>>();
  /** Lease of each running job, so a drain's hard stop can abort the handlers it hands back. */
  private leases = new Map<string, AbortController>();
  /** A runUntilIdle call is in progress in this instance. */
  private draining = false;
  private started = false;
  private stopping = false;
  private pumping = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private unlisten: (() => void) | null = null;
  private lastPrune = 0;
  /** When the loop last finished a pump (claim pass); 0 before it starts. */
  private lastBeat = 0;

  constructor(private concurrency: number) {}

  /**
   * Milliseconds since this instance's job loop last polled the queue (MON-03): null when it is not running here.
   * The loop polls every JOB_POLL_INTERVAL_MS, so an age far beyond that means it is stuck.
   */
  heartbeatAgeMs(): number | null {
    if (!this.started || this.stopping) return null;
    return this.lastBeat ? Date.now() - this.lastBeat : 0;
  }

  register<K extends JobKind>(
    kind: K,
    run: (payload: JobPayloads[K], signal: AbortSignal, job: JobAttempt) => Promise<void>,
    opts: HandlerOptions = {},
  ): void {
    this.handlers.set(kind, {
      run,
      maxAttempts: opts.maxAttempts ?? 3,
      retryOnError: opts.retryOnError ?? true,
      backoffBaseS: opts.backoffBaseS ?? JOB_BACKOFF_BASE_S,
    });
  }

  /**
   * Queue a job unless one with `key` is already waiting to run. Pass `db` to enqueue inside a transaction
   * (the job then exists exactly when the rows it works on do). Returns whether a job was created.
   */
  async enqueue<K extends JobKind>(
    kind: K,
    key: string,
    payload: JobPayloads[K],
    opts: { db?: Queryable; maxAttempts?: number } = {},
  ): Promise<boolean> {
    const maxAttempts = opts.maxAttempts ?? this.handlers.get(kind)?.maxAttempts ?? 3;
    const { rowCount } = await (opts.db ?? pool).query(
      `INSERT INTO jobs (kind, dedupe_key, payload, max_attempts) VALUES ($1, $2, $3, $4)
       ON CONFLICT (dedupe_key) WHERE status = 'queued' DO NOTHING`,
      [kind, key, JSON.stringify(withOrigin(payload)), maxAttempts],
    );
    if (!rowCount) return false;
    // Inside a transaction, NOTIFY is delivered on commit; other instances wake at once, this one pumps now
    // (and again on its own NOTIFY, harmlessly, should the commit come later).
    await (opts.db ?? pool).query('SELECT pg_notify($1, $2)', [CHANNEL, kind]);
    await this.kick();
    return true;
  }

  /**
   * Queue many jobs of one kind in one statement (bulk actions, PERF-09), each unless its key is already queued.
   * Returns the keys that got a job. Pass `db` to enqueue inside a transaction.
   */
  async enqueueMany<K extends JobKind>(
    kind: K,
    items: { key: string; payload: JobPayloads[K] }[],
    opts: { db?: Queryable; maxAttempts?: number } = {},
  ): Promise<string[]> {
    if (!items.length) return [];
    const maxAttempts = opts.maxAttempts ?? this.handlers.get(kind)?.maxAttempts ?? 3;
    const db = opts.db ?? pool;
    const { rows } = await db.query<{ dedupe_key: string }>(
      `INSERT INTO jobs (kind, dedupe_key, payload, max_attempts)
       SELECT $1, t.key, t.payload, $4 FROM unnest($2::text[], $3::jsonb[]) AS t(key, payload)
       ON CONFLICT (dedupe_key) WHERE status = 'queued' DO NOTHING
       RETURNING dedupe_key`,
      [kind, items.map((i) => i.key), items.map((i) => JSON.stringify(withOrigin(i.payload))), maxAttempts],
    );
    if (!rows.length) return [];
    await db.query('SELECT pg_notify($1, $2)', [CHANNEL, kind]);
    await this.kick();
    return rows.map((r) => r.dedupe_key);
  }

  /** Whether a job with `key` is queued or running. */
  async isActive(key: string, db: Queryable = pool): Promise<boolean> {
    const { rowCount } = await db.query(`SELECT 1 FROM jobs WHERE dedupe_key=$1 AND status IN ('queued', 'running')`, [
      key,
    ]);
    return Boolean(rowCount);
  }

  /** Queued + running jobs across all instances (Monitoring). */
  async depth(): Promise<number> {
    const {
      rows: [r],
    } = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued', 'running')`);
    return r.n;
  }

  /** Start claiming jobs. Idempotent; enqueue starts it too, so tests and scripts need no explicit call. */
  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.timer = setInterval(() => this.wake(), config.JOB_POLL_INTERVAL_MS).unref();
    void listen(CHANNEL, () => this.wake())
      .then((off) => {
        this.unlisten = off;
      })
      .catch((err) => logger.warn({ err }, 'job LISTEN failed; polling only'));
    this.wake();
  }

  /**
   * Stop claiming, wait up to `timeoutMs` for running jobs, then hand the unfinished ones back to the queue
   * (attempt not counted) so another instance takes them now instead of after the lease lapses.
   */
  async stop(timeoutMs = config.SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unlisten?.();
    if (!this.active.size) return;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.active.values()]),
      new Promise((r) => {
        timeout = setTimeout(r, timeoutMs);
      }),
    ]);
    clearTimeout(timeout);
    const left = [...this.active.keys()];
    if (!left.length) return;
    logger.warn({ jobs: left.length }, 'releasing unfinished jobs on shutdown');
    await this.requeue(left, `interval '0'`, null, 1).catch((err) => logger.error({ err }, 'job release failed'));
    void notify(CHANNEL, 'released').catch(() => undefined);
  }

  /**
   * Have newly queued work picked up: the server runtime pumps its own loop; the Netlify runtime triggers the worker
   * function, unless this instance is that worker draining now (it claims the job itself).
   */
  private async kick(): Promise<void> {
    if (!isNetlifyRuntime()) {
      this.start();
      this.wake();
    } else if (!this.draining) {
      await triggerWorker('jobs');
    }
  }

  /**
   * Drain mode (the Netlify background worker): claim and run jobs with the usual concurrency until none is claimable
   * and none runs. Claiming stops at `claimDeadlineMs`; at `hardDeadlineMs` the jobs still running are handed back to
   * the queue (attempt not counted) and their handlers aborted, so a job never outlives the function. Never starts the
   * poll timer or LISTEN. A second call while one drains in this instance returns at once.
   */
  async runUntilIdle(opts: {
    claimDeadlineMs: number;
    hardDeadlineMs: number;
    /** Wait this long and look again before ending for want of work (default WORKER_IDLE_GRACE_MS). */
    idleGraceMs?: number;
  }): Promise<{ ran: number; released: number }> {
    if (this.draining || this.started) return { ran: 0, released: 0 };
    this.draining = true;
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    const idleGraceMs = opts.idleGraceMs ?? WORKER_IDLE_GRACE_MS;
    let ran = 0;
    let graceUsed = false;
    try {
      while (elapsed() < opts.hardDeadlineMs) {
        const claiming = elapsed() < opts.claimDeadlineMs;
        if (claiming) {
          const free = this.concurrency - this.active.size;
          if (free > 0) {
            const claimed = await this.claim(free).catch((err: unknown) => {
              logger.error({ err }, 'job claim failed');
              return [] as JobRow[];
            });
            for (const job of claimed) this.run(job);
            ran += claimed.length;
            if (claimed.length) {
              graceUsed = false;
              continue;
            }
          }
        }
        if (!this.active.size) {
          if (!claiming || graceUsed || !idleGraceMs) break;
          graceUsed = true;
          await sleep(Math.min(idleGraceMs, opts.hardDeadlineMs - elapsed()));
          continue;
        }
        // Wait for a job to finish (a slot frees, or it queued follow-on work) or the next look for new work.
        await Promise.race([
          ...this.active.values(),
          sleep(Math.max(0, Math.min(WORKER_DRAIN_TICK_MS, opts.hardDeadlineMs - elapsed()))),
        ]);
      }
      const released = await this.releaseActive();
      if (Date.now() - this.lastPrune > JOB_PRUNE_EVERY_MS)
        await this.prune().catch((err: unknown) => logger.warn({ err }, 'job prune failed'));
      return { ran, released };
    } finally {
      this.draining = false;
    }
  }

  /** Hand every job still running here back to the queue (attempt not counted) and abort its handler. */
  private async releaseActive(): Promise<number> {
    const left = [...this.active.keys()];
    if (!left.length) return 0;
    logger.warn({ jobs: left.length }, 'worker time limit near; releasing unfinished jobs');
    await this.requeue(left, `interval '0'`, null, 1).catch((err: unknown) =>
      logger.error({ err }, 'job release failed'),
    );
    for (const id of left) {
      this.leases.get(id)?.abort(new Error('Worker time limit reached; job released'));
      this.leases.delete(id);
      this.active.delete(id);
    }
    return left.length;
  }

  /** Resolves once no job of a registered kind is due or running (tests). */
  async drain(timeoutMs = 30_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      this.wake();
      const {
        rows: [r],
      } = await pool.query(
        `SELECT count(*)::int AS n FROM jobs WHERE kind = ANY($1)
           AND ((status='queued' AND run_after <= now()) OR status='running')`,
        [[...this.handlers.keys()]],
      );
      if (!r.n && !this.active.size) return;
      if (Date.now() > end) throw new Error(`jobs still pending after ${timeoutMs} ms`);
      await sleep(100);
    }
  }

  private wake(): void {
    if (!this.started || this.stopping) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    void this.pump().finally(() => {
      this.pumping = false;
    });
  }

  private async pump(): Promise<void> {
    try {
      do {
        this.again = false;
        const free = this.concurrency - this.active.size;
        if (free <= 0 || this.stopping) return;
        const claimed = await this.claim(free);
        for (const job of claimed) this.run(job);
        if (claimed.length === free) this.again = true;
      } while (this.again && !this.stopping);
      if (Date.now() - this.lastPrune > JOB_PRUNE_EVERY_MS) await this.prune();
    } catch (err) {
      logger.error({ err }, 'job claim failed');
    } finally {
      this.lastBeat = Date.now();
    }
  }

  private async claim(limit: number): Promise<JobRow[]> {
    const kinds = [...this.handlers.keys()];
    if (!kinds.length) return [];
    // One candidate per dedupe key (DISTINCT ON), so a lapsed running job and the queued re-run behind it are never
    // claimed together; a queued job waits while its key has any running row, live or lapsed (the lapsed one is
    // reclaimed first). The status test is repeated in `next` so a row changed between the two scans is not claimed.
    const { rows } = await pool.query<JobRow>(
      `WITH cand AS (
         SELECT DISTINCT ON (dedupe_key) id, run_after FROM jobs
         WHERE kind = ANY($1) AND (
           (status='queued' AND run_after <= now()
             AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.dedupe_key=jobs.dedupe_key AND r.status='running'))
           OR (status='running' AND locked_until < now()
             AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.dedupe_key=jobs.dedupe_key AND r.id<>jobs.id AND r.status='running' AND r.locked_until >= now())))
         ORDER BY dedupe_key, (status='running') DESC, run_after, id),
       next AS (
         SELECT j.id FROM jobs j JOIN cand c ON c.id=j.id
         WHERE (j.status='queued' AND j.run_after <= now()) OR (j.status='running' AND j.locked_until < now())
         ORDER BY c.run_after, c.id LIMIT $2 FOR UPDATE OF j SKIP LOCKED)
       UPDATE jobs j SET status='running', attempts=j.attempts + 1, locked_by=$3,
         locked_until=now() + make_interval(secs => $4), updated_at=now()
       FROM next WHERE j.id=next.id
       RETURNING j.id, j.kind, j.dedupe_key, j.payload, j.attempts, j.max_attempts`,
      [kinds, limit, this.workerId, config.JOB_LEASE_SECONDS],
    );
    return rows;
  }

  private run(job: JobRow): void {
    // Every log line of the run carries the job, its submission and the request that queued it (requestContext.ts).
    const { [ORIGIN_KEY]: requestId, ...payload } = (job.payload ?? {}) as Record<string, unknown>;
    job.payload = payload;
    const ctx = {
      jobId: String(job.id),
      jobKind: job.kind,
      dedupeKey: job.dedupe_key,
      attempt: job.attempts,
      ...(typeof requestId === 'string' ? { requestId } : {}),
      ...(typeof payload.submissionId === 'string' ? { submissionId: payload.submissionId } : {}),
    };
    const lease = new AbortController();
    // After a drain's hard stop releases this run, the same row may be claimed again here before this handler ends:
    // only clear the entries while they are still this run's.
    const p: Promise<void> = withLogContext(ctx, () => this.execute(job, lease)).finally(() => {
      if (this.active.get(job.id) === p) this.active.delete(job.id);
      if (this.leases.get(job.id) === lease) this.leases.delete(job.id);
      this.wake();
    });
    this.leases.set(job.id, lease);
    this.active.set(job.id, p);
  }

  private async execute(job: JobRow, lease: AbortController): Promise<void> {
    const handler = this.handlers.get(job.kind)!;
    // Claimed again after its lease lapsed once too often: the worker running it keeps dying (OOM, crash loop).
    if (job.attempts > job.max_attempts) {
      return this.fail(
        job,
        new Error(`Abandoned after ${job.max_attempts} attempts (worker stopped without finishing)`),
      );
    }
    // Renew the lease while the handler runs, so a long OCR or LLM call is never taken over by another worker.
    // A renewal that matches no row means the job was taken over anyway (lease lapsed during a stall): the handler
    // is told through its AbortSignal and this worker writes nothing more for the job, the new owner finishes it.
    const renew = setInterval(
      () => {
        void pool
          .query(
            `UPDATE jobs SET locked_until=now() + make_interval(secs => $3) WHERE id=$1 AND locked_by=$2 AND status='running'`,
            [job.id, this.workerId, config.JOB_LEASE_SECONDS],
          )
          .then(({ rowCount }) => {
            if (rowCount || lease.signal.aborted) return;
            logger.warn({ job: job.dedupe_key }, 'job lease lost to another worker; abandoning this run');
            clearInterval(renew);
            lease.abort(new Error('Job lease lost'));
          })
          .catch((err) => logger.warn({ err, job: job.dedupe_key }, 'job lease renewal failed'));
      },
      Math.max(1000, (config.JOB_LEASE_SECONDS * 1000) / 3),
    );
    renew.unref();
    const started = Date.now();
    const seconds = () => (Date.now() - started) / 1000;
    try {
      // Also reachable without passing it down: Claude calls made anywhere in the handler stop when the lease is lost.
      await withJobSignal(lease.signal, () =>
        handler.run(job.payload, lease.signal, { attempt: job.attempts, maxAttempts: job.max_attempts }),
      );
      clearInterval(renew);
      if (lease.signal.aborted) return observeJob(job.kind, 'lost', seconds());
      observeJob(job.kind, 'done', seconds());
      await pool.query(
        `UPDATE jobs SET status='done', finished_at=now(), locked_until=NULL, locked_by=NULL, updated_at=now() WHERE id=$1 AND locked_by=$2`,
        [job.id, this.workerId],
      );
    } catch (err) {
      clearInterval(renew);
      if (lease.signal.aborted) return observeJob(job.kind, 'lost', seconds());
      const retry = handler.retryOnError && job.attempts < job.max_attempts;
      observeJob(job.kind, retry ? 'retry' : 'failed', seconds());
      if (retry) {
        // Exponential, capped, with jitter (75-100 % of the step) so retries after an outage don't all fire at once.
        const delay = Math.round(
          Math.min(handler.backoffBaseS * 2 ** (job.attempts - 1), JOB_BACKOFF_MAX_S) * (0.75 + Math.random() / 4),
        );
        logger.warn(
          { err, job: job.dedupe_key, attempts: job.attempts, retryInSeconds: delay },
          'job failed; will retry',
        );
        await this.requeue([job.id], `make_interval(secs => ${delay})`, errorText(err), 0).catch((e) =>
          logger.error({ err: e }, 'job requeue failed'),
        );
      } else {
        await this.fail(job, err);
      }
    }
  }

  /**
   * Hand running jobs back to the queue after `delay` (SQL interval), giving back `refund` attempts. One whose key
   * already has a queued job is closed as done instead: that queued run redoes the same work.
   */
  private async requeue(ids: string[], delay: string, error: string | null, refund: number): Promise<void> {
    await pool.query(
      `UPDATE jobs SET status='queued', run_after=now() + ${delay}, attempts=greatest(attempts - $3::int, 0),
         last_error=COALESCE($4, last_error), locked_until=NULL, locked_by=NULL, updated_at=now()
       WHERE id = ANY($1::bigint[]) AND locked_by=$2 AND status='running'
         AND NOT EXISTS (SELECT 1 FROM jobs q WHERE q.dedupe_key=jobs.dedupe_key AND q.status='queued')`,
      [ids, this.workerId, refund, error],
    );
    await pool.query(
      `UPDATE jobs SET status='done', finished_at=now(), last_error=COALESCE($3, last_error), locked_until=NULL, locked_by=NULL, updated_at=now()
       WHERE id = ANY($1::bigint[]) AND locked_by=$2 AND status='running'`,
      [ids, this.workerId, error],
    );
  }

  private async fail(job: JobRow, err: unknown): Promise<void> {
    logger.error({ err, job: job.dedupe_key, attempts: job.attempts }, 'job failed');
    await pool
      .query(
        `UPDATE jobs SET status='failed', finished_at=now(), last_error=$3, locked_until=NULL, locked_by=NULL, updated_at=now()
       WHERE id=$1 AND locked_by=$2`,
        [job.id, this.workerId, errorText(err)],
      )
      .catch((e) => logger.error({ err: e }, 'job fail update failed'));
    await recordSystemError(`job:${job.dedupe_key}`, err).catch(() => undefined);
  }

  private async prune(): Promise<void> {
    this.lastPrune = Date.now();
    const { rowCount } = await pool.query(
      `DELETE FROM jobs WHERE status IN ('done', 'failed') AND finished_at < now() - make_interval(days => $1)`,
      [config.JOB_RETENTION_DAYS],
    );
    if (rowCount) logger.info({ pruned: rowCount }, 'pruned finished jobs');
  }
}

const errorText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(0, 4000);

export const jobs = new JobQueue(config.JOB_CONCURRENCY);
setJobHeartbeatSource(() => jobs.heartbeatAgeMs());
