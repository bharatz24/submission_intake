import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { CLIENT_ERROR_RATE_LIMIT_PER_MIN } from '../../constants.js';
import { authenticate, parseBody } from '../../http.js';
import { logger } from '../../logger.js';
import { scrubText } from '../../services/piiScrub.js';
import { rateLimitStore } from '../shared/rateLimitStore.js';

/**
 * POST /api/client-errors: the browser app reports its own failures here (a crashed screen, a failed chunk load, an
 * event stream that keeps dropping), so they reach the server logs next to the API's. Open before sign-in (the login
 * page can fail too), so it is rate-limited per IP, takes only short text fields, and never stores anything: it logs.
 * The page URL is reduced to its path (query strings can carry tokens), the message and stacks lose any personal data
 * (piiScrub.ts: an error text can quote an applicant's email, NPI or phone), and the user is attached when signed in.
 */
export const clientErrorsRouter = Router();

const ClientError = z.object({
  level: z.enum(['error', 'warn']).default('error'),
  message: z.string().trim().min(1).max(2000),
  /** Where it happened in the app: an error boundary, the event stream, a route. */
  source: z.string().trim().max(100).default('app'),
  stack: z.string().max(8000).optional(),
  componentStack: z.string().max(8000).optional(),
  url: z.string().max(2000).optional(),
  /** The API request id of the failed call the error came from, when there was one. */
  requestId: z.string().max(100).optional(),
  release: z.string().max(100).optional(),
});

const pathOnly = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(url, 'http://app.invalid').pathname;
  } catch {
    return undefined;
  }
};

clientErrorsRouter.post(
  '/client-errors',
  rateLimit({
    ...rateLimitStore('client-errors'),
    windowMs: 60_000,
    limit: CLIENT_ERROR_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
  async (req, res) => {
    const body = parseBody(ClientError, req.body);
    // Signed in or not: a report from the login page is still worth logging.
    const user = req.headers.authorization || req.headers.cookie ? await authenticate(req).catch(() => null) : null;
    const entry = {
      clientError: {
        ...body,
        message: scrubText(body.message),
        stack: body.stack === undefined ? undefined : scrubText(body.stack),
        componentStack: body.componentStack === undefined ? undefined : scrubText(body.componentStack),
        url: pathOnly(body.url),
        userAgent: req.headers['user-agent']?.slice(0, 300),
      },
      userId: user?.id ?? null,
    };
    if (body.level === 'warn') logger.warn(entry, 'client warning');
    else logger.error(entry, 'client error');
    res.status(204).end();
  },
);
