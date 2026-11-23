import type { RequestHandler } from 'express';
import client from 'prom-client';

import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * Prometheus metrics (MON-02), served at GET /api/metrics behind METRICS_TOKEN (modules/health). Vendor-neutral: any
 * Prometheus-compatible scraper (Prometheus, Grafana Agent, Datadog's OpenMetrics check) can read them and alert.
 *
 * In-process counters and histograms: HTTP requests (RED), outbound calls per integration, background jobs, system
 * errors. Point-in-time gauges read from the database at scrape time (shared by every instance, so scrape one or
 * aggregate with max): job queue depth and oldest age, Gmail ingest queue depth/oldest/parked, LLM tokens and cost.
 * Labels never carry ids or personal data: routes are templates (/submissions/:id), scopes have their ids masked.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'ims_' });

const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const JOB_BUCKETS = [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800];

const httpDuration = new client.Histogram({
  name: 'ims_http_request_duration_seconds',
  help: 'API request duration by method, route template and status class',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: DURATION_BUCKETS,
  registers: [registry],
});

const outboundDuration = new client.Histogram({
  name: 'ims_outbound_request_duration_seconds',
  help: 'Calls to external systems by integration and outcome (ok, http_4xx, http_5xx, error)',
  labelNames: ['integration', 'outcome'] as const,
  buckets: DURATION_BUCKETS,
  registers: [registry],
});

const jobDuration = new client.Histogram({
  name: 'ims_job_duration_seconds',
  help: 'Background job runs by kind (process = the submission pipeline, report = Synthesis/Analysis) and outcome',
  labelNames: ['kind', 'outcome'] as const,
  buckets: JOB_BUCKETS,
  registers: [registry],
});

const systemErrors = new client.Counter({
  name: 'ims_system_errors_total',
  help: 'Errors recorded on Monitoring (recordSystemError), by scope with ids masked',
  labelNames: ['scope'] as const,
  registers: [registry],
});

const rateLimited = new client.Counter({
  name: 'ims_rate_limited_total',
  help: 'Requests refused by a rate limiter',
  labelNames: ['limiter'] as const,
  registers: [registry],
});

/** Seconds since the job loop of this instance last ran (set by jobQueue.ts); absent before it starts. */
let jobHeartbeat: () => number | null = () => null;
export function setJobHeartbeatSource(fn: () => number | null): void {
  jobHeartbeat = fn;
}
new client.Gauge({
  name: 'ims_job_loop_heartbeat_age_seconds',
  help: 'Seconds since this instance last polled the job queue; grows when the job loop is stuck',
  registers: [registry],
  collect() {
    const ms = jobHeartbeat();
    if (ms !== null) this.set(ms / 1000);
  },
});

/** A gauge set from one database query at scrape time; a failed query leaves it empty (and is logged), never throws. */
function dbGauge<L extends string>(
  name: string,
  help: string,
  labelNames: readonly L[],
  read: (g: client.Gauge<L>) => Promise<void>,
) {
  return new client.Gauge<L>({
    name,
    help,
    labelNames,
    registers: [registry],
    async collect() {
      this.reset();
      await read(this).catch((err) => logger.warn({ err, metric: name }, 'metric query failed'));
    },
  });
}

dbGauge('ims_jobs', 'Background jobs queued or running, by kind and status', ['kind', 'status'], async (g) => {
  const { rows } = await pool.query<{ kind: string; status: string; n: number }>(
    `SELECT kind, status, count(*)::int AS n FROM jobs WHERE status IN ('queued', 'running') GROUP BY kind, status`,
  );
  for (const r of rows) g.set({ kind: r.kind, status: r.status }, r.n);
});

dbGauge('ims_jobs_oldest_due_age_seconds', 'Age of the oldest due queued job, by kind', ['kind'], async (g) => {
  const { rows } = await pool.query<{ kind: string; age: number }>(
    `SELECT kind, extract(epoch FROM now() - min(run_after))::float8 AS age FROM jobs
     WHERE status='queued' AND run_after <= now() GROUP BY kind`,
  );
  for (const r of rows) g.set({ kind: r.kind }, r.age);
});

dbGauge('ims_jobs_failed_24h', 'Jobs failed for good in the last 24 hours, by kind', ['kind'], async (g) => {
  const { rows } = await pool.query<{ kind: string; n: number }>(
    `SELECT kind, count(*)::int AS n FROM jobs WHERE status='failed' AND finished_at > now() - interval '24 hours'
     GROUP BY kind`,
  );
  for (const r of rows) g.set({ kind: r.kind }, r.n);
});

dbGauge(
  'ims_ingest_queue',
  'Gmail messages waiting to be ingested: waiting (incl. retries), failing (attempted at least once), parked',
  ['state'],
  async (g) => {
    const {
      rows: [r],
    } = await pool.query<{ waiting: number; failing: number; parked: number }>(
      `SELECT count(*) FILTER (WHERE parked_at IS NULL)::int AS waiting,
              count(*) FILTER (WHERE parked_at IS NULL AND attempts > 0)::int AS failing,
              count(parked_at)::int AS parked
       FROM gmail_ingest_queue`,
    );
    if (!r) return;
    g.set({ state: 'waiting' }, r.waiting);
    g.set({ state: 'failing' }, r.failing);
    g.set({ state: 'parked' }, r.parked);
  },
);

dbGauge(
  'ims_ingest_queue_oldest_age_seconds',
  'Age of the oldest Gmail message not ingested yet (unparked)',
  [],
  async (g) => {
    const {
      rows: [r],
    } = await pool.query<{ age: number | null }>(
      `SELECT extract(epoch FROM now() - min(created_at))::float8 AS age FROM gmail_ingest_queue WHERE parked_at IS NULL`,
    );
    g.set(r?.age ?? 0);
  },
);

dbGauge(
  'ims_llm_tokens_24h',
  'Claude tokens in the last 24 hours by task and kind (input, output, cache_read, cache_write)',
  ['task', 'kind'],
  async (g) => {
    const { rows } = await pool.query<{ task: string; i: string; o: string; cr: string; cw: string }>(
      `SELECT task, sum(input_tokens)::text AS i, sum(output_tokens)::text AS o, sum(cache_read_tokens)::text AS cr,
              sum(cache_write_tokens)::text AS cw
       FROM llm_calls WHERE created_at > now() - interval '24 hours' GROUP BY task`,
    );
    for (const r of rows) {
      g.set({ task: r.task, kind: 'input' }, Number(r.i));
      g.set({ task: r.task, kind: 'output' }, Number(r.o));
      g.set({ task: r.task, kind: 'cache_read' }, Number(r.cr));
      g.set({ task: r.task, kind: 'cache_write' }, Number(r.cw));
    }
  },
);

dbGauge('ims_llm_cost_usd_24h', 'Estimated Claude cost (USD) in the last 24 hours by task', ['task'], async (g) => {
  const { rows } = await pool.query<{ task: string; cost: string | null }>(
    `SELECT task, sum(cost_usd)::text AS cost FROM llm_calls WHERE created_at > now() - interval '24 hours' GROUP BY task`,
  );
  for (const r of rows) g.set({ task: r.task }, Number(r.cost ?? 0));
});

dbGauge('ims_llm_calls_24h', 'Claude calls in the last 24 hours by task and status', ['task', 'status'], async (g) => {
  const { rows } = await pool.query<{ task: string; status: string; n: number }>(
    `SELECT task, status, count(*)::int AS n FROM llm_calls WHERE created_at > now() - interval '24 hours'
     GROUP BY task, status`,
  );
  for (const r of rows) g.set({ task: r.task, status: r.status }, r.n);
});

/** Ids in a scope or path segment (uuids, Gmail ids, numbers) replaced by `:id`, so label values stay few. */
export function maskIds(s: string): string {
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\b(?=[0-9a-z]*\d)[0-9a-z]{12,}\b/gi, ':id')
    .replace(/\b\d+\b/g, ':id');
}

/** HTTP RED middleware: one observation per finished request, labelled by the matched route template. */
export const httpMetrics: RequestHandler = (req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    // req.route is set once a router matched: baseUrl + its path is a template, never a raw id.
    const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
    end({ method: req.method, route, status: `${Math.floor(res.statusCode / 100)}xx` });
  });
  next();
};

export type OutboundOutcome = 'ok' | 'http_4xx' | 'http_5xx' | 'error';
export const outboundOutcome = (status: number | null): OutboundOutcome =>
  status === null ? 'error' : status >= 500 ? 'http_5xx' : status >= 400 ? 'http_4xx' : 'ok';

/** One call to an external system (NPI registry, IMS 2 ...); `status` null for a network error or timeout. */
export function observeOutbound(integration: string, status: number | null, seconds: number): void {
  outboundDuration.observe({ integration, outcome: outboundOutcome(status) }, seconds);
}

export function observeJob(kind: string, outcome: 'done' | 'retry' | 'failed' | 'lost', seconds: number): void {
  jobDuration.observe({ kind, outcome }, seconds);
}

export function countSystemError(scope: string): void {
  systemErrors.inc({ scope: maskIds(scope).slice(0, 100) });
}

export function countRateLimited(limiter: string): void {
  rateLimited.inc({ limiter });
}

/** Whether a request may read /api/metrics: METRICS_TOKEN set and presented as a bearer token. */
export const metricsEnabled = () => Boolean(config.METRICS_TOKEN);
