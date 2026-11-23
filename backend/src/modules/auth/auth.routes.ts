import { type Request, type Response, Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';

import { config } from '../../config.js';
import type { UserRow } from '../../db/rows.js';
import type { AppDeps } from '../../deps.js';
import {
  AppError,
  authenticate,
  clearAuthCookie,
  currentUser,
  parseBody,
  requireAuth,
  ROLES,
  setAuthCookie,
  signToken,
} from '../../http.js';
import { countRateLimited } from '../../services/metrics.js';
import { PasswordSchema } from '../../services/passwordPolicy.js';
import { mapUser } from '../../services/queries.js';
import { rateLimitStore } from '../shared/rateLimitStore.js';
import { createAuthService } from './auth.service.js';

const LOGIN_WINDOW_MS = 15 * 60_000;

/** Normalized login email, or null when the body has none. */
function loginEmail(body: unknown): string | null {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() ? email.trim().toLowerCase().slice(0, 320) : null;
}

// Per IP, and per account as well. Module level: one count however many apps createApp builds, shared by every
// instance through the Postgres store (rateLimitStore.ts; in memory under tests).
const loginLimiter = rateLimit({
  ...rateLimitStore('login'),
  windowMs: LOGIN_WINDOW_MS,
  limit: config.LOGIN_RATE_LIMIT_PER_15MIN,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

/**
 * Failed sign-ins for one account (QA-011). Counted per account and IP together, so a stranger guessing someone's
 * password locks only themselves out, not the real user signing in from elsewhere. A much higher cap per account
 * from any IP still stops a brute force spread over many IPs. Only failures count, so signing in uses up nothing.
 */
export function accountLoginLimiters(perAccountAndIp: number, perAccount: number) {
  const limiter = (name: string, limit: number, key: (req: Request) => string) =>
    rateLimit({
      ...rateLimitStore(name),
      windowMs: LOGIN_WINDOW_MS,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      skip: (req) => loginEmail(req.body) === null,
      keyGenerator: key,
      handler: (_req, _res, next) => {
        countRateLimited(name);
        next(
          new AppError('TOO_MANY_ATTEMPTS', 429, 'Too many failed sign-ins for this account. Try again in 15 minutes.'),
        );
      },
    });
  return [
    limiter(
      'login-account-ip',
      perAccountAndIp,
      (req) => `account-ip:${loginEmail(req.body)}|${ipKeyGenerator(req.ip ?? '')}`,
    ),
    limiter('login-account', perAccount, (req) => `account:${loginEmail(req.body)}`),
  ];
}
const accountLoginLimiter = accountLoginLimiters(
  config.LOGIN_ACCOUNT_RATE_LIMIT_PER_15MIN,
  config.LOGIN_ACCOUNT_TOTAL_RATE_LIMIT_PER_15MIN,
);

const RegisterBody = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: PasswordSchema,
  name: z.string().trim().min(1).max(100),
  role: z.enum(ROLES).optional(),
  // SETUP_TOKEN, needed only for the first account in production (also accepted as the X-Setup-Token header).
  setupToken: z.string().max(500).optional(),
});
const SETUP_TOKEN_HEADER = 'X-Setup-Token';
// Existing passwords may be longer than today's 72-byte cap, so sign-in still accepts up to 200 characters.
const LoginBody = z.object({ email: z.string().max(320), password: z.string().max(200) });
const PasswordChangeBody = z.object({ currentPassword: z.string().max(200), newPassword: PasswordSchema });

/**
 * Header a script sends (`X-Client: cli`) to get the session token in the response body. Browsers never send it, so
 * a browser session's token lives only in the httpOnly cookie, out of reach of any script on the page.
 */
const CLIENT_HEADER = 'X-Client';
const wantsBodyToken = (req: Request) => req.get(CLIENT_HEADER)?.trim().toLowerCase() === 'cli';

/** Signs a token for a users row, sets it as the session cookie, and builds the body: the user, plus the token for scripts. */
function issueSession(req: Request, res: Response, row: UserRow): { token?: string; user: ReturnType<typeof mapUser> } {
  const user = mapUser(row);
  const token = signToken(user, row.token_version ?? 0);
  setAuthCookie(res, token);
  return wantsBodyToken(req) ? { token, user } : { user };
}

/** The signed-in user when the request carries credentials, else null (never an error). */
const optionalUser = (req: Request) =>
  req.headers.authorization || req.headers.cookie ? authenticate(req).catch(() => null) : Promise.resolve(null);

/** /api/auth: sign-up, sign-in, sign-out, the current user and their own password. */
export function authRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createAuthService(deps);

  router.get('/bootstrap', async (_req, res) => {
    const needsSetup = await service.needsSetup();
    res.json({ needsSetup, setupTokenRequired: needsSetup && service.setupTokenRequired });
  });

  router.post('/register', loginLimiter, async (req, res) => {
    const { setupToken, ...body } = parseBody(RegisterBody, req.body);
    const { user, bootstrap } = await service.register(
      body,
      await optionalUser(req),
      setupToken ?? req.get(SETUP_TOKEN_HEADER),
    );
    // The bootstrap admin is signed in; an admin creating someone else keeps their own session.
    res.status(201).json(bootstrap ? issueSession(req, res, user) : { user: mapUser(user) });
  });

  router.post('/login', loginLimiter, ...accountLoginLimiter, async (req, res) => {
    const body = parseBody(LoginBody, req.body);
    res.json(issueSession(req, res, await service.login(body.email.trim().toLowerCase(), body.password, req.ip)));
  });

  /** Works without a valid session, so a stale cookie can always be cleared. */
  router.post('/logout', async (req, res) => {
    const user = await authenticate(req).catch((err) => {
      if (err instanceof AppError && err.code === 'CSRF_HEADER_REQUIRED') throw err; // no cross-site sign-outs
      return null;
    });
    if (user) await service.logout(user.id);
    clearAuthCookie(res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    res.json(mapUser(await service.me(currentUser(req).id)));
  });

  router.post('/password', loginLimiter, requireAuth, async (req, res) => {
    const body = parseBody(PasswordChangeBody, req.body);
    res.json(
      issueSession(req, res, await service.changePassword(currentUser(req).id, body.currentPassword, body.newPassword)),
    );
  });

  return router;
}
