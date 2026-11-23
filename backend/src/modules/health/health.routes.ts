import { Router } from 'express';

import { config } from '../../config.js';
import { pendingMigrations } from '../../db/migrate.js';
import type { AppDeps } from '../../deps.js';
import { safeEqual } from '../../services/crypto.js';
import { jobs } from '../../services/jobQueue.js';
import { registry } from '../../services/metrics.js';

/** A job loop that has not polled for this long (several poll intervals) is reported as stuck. */
const jobLoopStaleMs = () => Math.max(30_000, config.JOB_POLL_INTERVAL_MS * 5);

/**
 * GET /health, /ready and /metrics, public (no sign-in), mounted before the /api rate limiter (app.ts) so probes and
 * scrapes are never throttled.
 */
export function healthRouter({ db }: Pick<AppDeps, 'db'>): Router {
  const router = Router();

  /**
   * Liveness: the process is up and answering. No dependencies, so a database blip never makes an orchestrator restart
   * healthy instances. Point the liveness probe (and the Docker HEALTHCHECK) here.
   */
  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * Readiness: the database answers and every migration is applied. Point the load balancer's readiness check here.
   * Names nothing beyond booleans (no versions, no config). `jobLoop` (MON-03) says whether this instance's job loop
   * polled recently; it is informational (absent where the loop is not running) and does not change `ok`, since
   * taking the instance out of the load balancer would not restart a stuck loop: alert on it (or on
   * ims_job_loop_heartbeat_age_seconds) instead.
   */
  router.get('/ready', async (_req, res) => {
    const dbUp = await db.query('SELECT 1').then(
      () => true,
      () => false,
    );
    const migrations =
      dbUp &&
      (await pendingMigrations(db).then(
        (p) => p.length === 0,
        () => false,
      ));
    const ok = dbUp && migrations;
    const age = jobs.heartbeatAgeMs();
    res
      .status(ok ? 200 : 503)
      .json({ ok, db: dbUp, migrations, ...(age === null ? {} : { jobLoop: age < jobLoopStaleMs() }) });
  });

  /**
   * Prometheus exposition (MON-02, services/metrics.ts). Off (404) unless METRICS_TOKEN is set; then it needs
   * `Authorization: Bearer <METRICS_TOKEN>`.
   */
  router.get('/metrics', async (req, res) => {
    const token = config.METRICS_TOKEN;
    if (!token) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
      return;
    }
    const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!safeEqual(given, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Metrics token required', requestId: req.id } });
      return;
    }
    res.setHeader('Content-Type', registry.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(await registry.metrics());
  });

  return router;
}
