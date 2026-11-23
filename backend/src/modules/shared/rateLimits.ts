import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

import { config } from '../../config.js';
import { AppError, currentUser } from '../../http.js';
import { countRateLimited } from '../../services/metrics.js';
import { rateLimitStore } from './rateLimitStore.js';

/** Per-user hourly limit; `limit` 0 turns it off. Answers in the API's JSON error shape. Counted across instances. */
const perUserHourly = (name: string, limit: number, code: string, message: string): RequestHandler =>
  rateLimit({
    ...rateLimitStore(name),
    windowMs: 60 * 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => limit === 0,
    keyGenerator: (req) => currentUser(req).id,
    handler: (_req, _res, next) => {
      countRateLimited(name);
      next(new AppError(code, 429, message));
    },
  });

/**
 * AI routes that start Claude calls (synthesis, analysis, comparisons, chat, email drafts). One counter shared by all of
 * them, so the limit is per user across every module. LLM_DAILY_TOKEN_BUDGET caps everyone together.
 */
export const aiLimiter = perUserHourly(
  'ai',
  config.LLM_USER_HOURLY_LIMIT,
  'LLM_RATE_LIMITED',
  `You have reached the limit of ${config.LLM_USER_HOURLY_LIMIT} AI requests per hour; try again later.`,
);

/** Outbound emails (reply, reply all, forward). */
export const sendLimiter = perUserHourly(
  'send',
  config.OUTBOUND_SEND_LIMIT_PER_HOUR,
  'SEND_RATE_LIMITED',
  `You have reached the limit of ${config.OUTBOUND_SEND_LIMIT_PER_HOUR} emails per hour; try again later.`,
);
