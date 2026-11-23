import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { config, isNetlifyRuntime } from './config.js';
import { JSON_BODY_LIMIT } from './constants.js';
import { type AppDeps, defaultDeps } from './deps.js';
import { errorHandler } from './errorHandler.js';
import { hideErrorDetail, requireAuth } from './http.js';
import { errSerializer, httpSerializers, logger } from './logger.js';
import { assessmentsRouter } from './modules/assessments/assessments.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { clientErrorsRouter } from './modules/clientErrors/clientErrors.routes.js';
import { conversationsRouter } from './modules/conversations/conversations.routes.js';
import { documentsRouter } from './modules/documents/documents.routes.js';
import { eventsRouter } from './modules/events/events.routes.js';
import { fieldsRouter } from './modules/fields/fields.routes.js';
import { gmailPublicRouter, gmailRouter } from './modules/gmail/gmail.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { historyRouter } from './modules/history/history.routes.js';
import { ims2Router } from './modules/ims2/ims2.routes.js';
import { inboxRouter } from './modules/inbox/inbox.routes.js';
import { intakeRouter } from './modules/intake/intake.routes.js';
import { monitoringRouter } from './modules/monitoring/monitoring.routes.js';
import { npiRouter } from './modules/npi/npi.routes.js';
import { processingRouter } from './modules/processing/processing.routes.js';
import { ratingRouter } from './modules/rating/rating.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { rateLimitStore } from './modules/shared/rateLimitStore.js';
import { skillsRouter } from './modules/skills/skills.routes.js';
import { submissionsRouter } from './modules/submissions/submissions.routes.js';
import { uploadsRouter } from './modules/uploads/uploads.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { withLogContext } from './requestContext.js';
import { countRateLimited, httpMetrics } from './services/metrics.js';

/**
 * The Express app without listening (server.ts listens). Every route lives in a module under src/modules (route →
 * service → repository) built from `deps`, which replaces any of the defaults (database pool, clock, the Drive, Gmail,
 * IMS 2 and NPI clients), so a test can run the real routes against fakes without mocking modules.
 */
export function createApp(overrides: Partial<AppDeps> = {}) {
  const deps: AppDeps = { ...defaultDeps(), ...overrides };
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  // A new id per request (a client-sent one is not trusted): returned as X-Request-Id, in every error body, and on
  // every log line written while the request runs (logger mixin), so a user's reference finds its log lines.
  app.use((req, res, next) => {
    const requestId = randomUUID();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    withLogContext({ requestId }, next);
  });
  app.use(helmet());
  // credentials: the browser sends the session cookie (http.ts) when the frontend is served from another origin.
  app.use(
    cors({
      origin: config.FRONTEND_ORIGIN,
      credentials: true,
      exposedHeaders: ['Content-Disposition', 'X-Request-Id'],
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(httpMetrics);
  if (config.NODE_ENV !== 'test')
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => req.id,
        // The err serializer scrubs PII from error messages and stacks, as on every other log line.
        serializers: { ...httpSerializers, err: errSerializer },
        autoLogging: { ignore: (req) => ['/api/health', '/api/ready', '/api/metrics'].includes(req.url ?? '') },
      }),
    );
  // Health, readiness and metrics before the rate limiter (MON-03): probes and scrapes from one address must never be
  // throttled into a false outage.
  app.use('/api', healthRouter(deps));
  app.use(
    '/api',
    rateLimit({
      // Counted in Postgres, shared by every instance (API-01; memory under tests).
      ...rateLimitStore('api', deps.db),
      windowMs: 60_000,
      limit: config.API_RATE_LIMIT_PER_MIN,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res, _next, options) => {
        countRateLimited('api');
        res.status(options.statusCode).send(options.message);
      },
    }),
  );

  // Public: Google's OAuth redirect and Pub/Sub push, browser error reports, sign-in.
  app.use('/api', gmailPublicRouter(deps));
  app.use('/api', clientErrorsRouter);
  app.use('/api/auth', authRouter(deps));

  // Everything else needs a session. The raw processing error is for those allowed to see it (http.ts hideErrorDetail).
  app.use('/api', requireAuth, hideErrorDetail);
  app.use('/api', eventsRouter);
  app.use('/api', usersRouter(deps));
  app.use('/api', settingsRouter(deps));
  app.use('/api', gmailRouter(deps));
  app.use('/api', intakeRouter(deps));
  app.use('/api', monitoringRouter(deps));
  app.use('/api', skillsRouter(deps));
  app.use('/api', historyRouter(deps));
  // The inbox before the submissions module: /submissions/unread-count and /submissions/:view/... before /submissions/:id.
  app.use('/api', inboxRouter(deps));
  // Chunked uploads only where a request body is capped (Netlify functions); a server takes multipart directly.
  if (isNetlifyRuntime()) app.use('/api', uploadsRouter(deps));
  app.use('/api', submissionsRouter(deps));
  app.use('/api', processingRouter(deps));
  app.use('/api', documentsRouter(deps));
  app.use('/api', npiRouter(deps));
  app.use('/api', fieldsRouter(deps));
  app.use('/api', reportsRouter(deps));
  app.use('/api', assessmentsRouter(deps));
  app.use('/api', conversationsRouter(deps));
  app.use('/api', ratingRouter(deps));
  app.use('/api', ims2Router(deps));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
  });
  app.use(errorHandler);
  return app;
}
