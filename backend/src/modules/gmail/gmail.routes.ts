import { createHash } from 'node:crypto';

import { type Response, Router } from 'express';
import { z } from 'zod';

import { config } from '../../config.js';
import { OAUTH_COOKIE_MAX_AGE_MS } from '../../constants.js';
import type { AppDeps } from '../../deps.js';
import { AppError, currentUser, parseBody, readCookie, requirePermission } from '../../http.js';
import { logger } from '../../logger.js';
import { IMPORT_DAYS_MAX, IMPORT_DAYS_MIN, POLL_INTERVAL_MAX, POLL_INTERVAL_MIN } from '../../services/appSettings.js';
import { safeEqual } from '../../services/crypto.js';
import { createGmailService } from './gmail.service.js';

// Gmail sign-in is bound to the browser that started it: GET /gmail/auth-url sets a short-lived httpOnly cookie
// holding a hash of the signed `state`, and the callback only accepts a state that matches it. So a sign-in link
// started by someone else (login CSRF: connecting the attacker's mailbox) fails in the victim's browser. SameSite=Lax:
// the callback is a top-level navigation from Google, which Lax sends the cookie on. Scoped to the callback path.
// The browser must reach the API on GOOGLE_REDIRECT_URI's host (cookies ignore the port).
const OAUTH_COOKIE = 'ims_gmail_oauth';
const oauthCookiePath = () => {
  try {
    return new URL(config.GOOGLE_REDIRECT_URI).pathname || '/';
  } catch {
    return '/';
  }
};
const stateHash = (state: string) => createHash('sha256').update(state).digest('base64url');
const oauthCookieOptions = () => ({
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: oauthCookiePath(),
});

function setOAuthStateCookie(res: Response, authorizationUrl: string): void {
  const state = new URL(authorizationUrl).searchParams.get('state');
  if (!state) throw new Error('Google authorization URL has no state');
  res.cookie(OAUTH_COOKIE, stateHash(state), { ...oauthCookieOptions(), maxAge: OAUTH_COOKIE_MAX_AGE_MS });
}

const CallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});
const PollIntervalBody = z.object({
  seconds: z
    .number()
    .int()
    .refine(
      (n) => n === 0 || (n >= POLL_INTERVAL_MIN && n <= POLL_INTERVAL_MAX),
      `Use 0 (off) or ${POLL_INTERVAL_MIN}–${POLL_INTERVAL_MAX} seconds`,
    ),
});
// Either the last `days` days, or `today: true` for everything since midnight US Eastern; never both.
const ImportBody = z.union([
  z.strictObject({ days: z.number().int().min(IMPORT_DAYS_MIN).max(IMPORT_DAYS_MAX) }),
  z.strictObject({ today: z.literal(true) }),
]);

/** Public Gmail endpoints: Google's OAuth redirect and the Pub/Sub push. */
export function gmailPublicRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createGmailService(deps);

  router.get('/gmail/oauth/callback', async (req, res) => {
    // Never a JSON error here: this page is the sign-in pop-up, which must land back on Settings to report and close.
    const parsed = CallbackQuery.safeParse(req.query);
    const q: z.infer<typeof CallbackQuery> = parsed.success ? parsed.data : { error: 'invalid_request' };
    const cookie = readCookie(req.headers.cookie, OAUTH_COOKIE);
    res.clearCookie(OAUTH_COOKIE, oauthCookieOptions());
    // popup=1 tells the settings page it is running in the sign-in pop-up, which reports back and closes.
    const fail = () => res.redirect(`${config.FRONTEND_ORIGIN}/settings?gmail=error&popup=1`);
    // Cancelled or refused on Google's consent screen (error=access_denied), or a malformed redirect.
    if (q.error || !q.code || !q.state) {
      logger.warn(
        { error: q.error ?? null, hasCode: Boolean(q.code), hasState: Boolean(q.state) },
        'gmail oauth not completed',
      );
      return fail();
    }
    if (!cookie || !safeEqual(cookie, stateHash(q.state))) {
      logger.warn('gmail oauth callback without the matching sign-in cookie (started in another browser, or expired)');
      return fail();
    }
    try {
      await deps.gmail.handleOAuthCallback(q.code, q.state);
      res.redirect(`${config.FRONTEND_ORIGIN}/settings?gmail=connected&popup=1`);
    } catch (err) {
      logger.error({ err }, 'gmail oauth failed');
      fail();
    }
  });

  // Pub/Sub push: authenticated by a shared token in the subscription URL. The notification only
  // signals "something changed"; we always fetch via history so payloads are never trusted.
  router.post('/gmail/push', async (req, res) => {
    const given = typeof req.query.token === 'string' ? req.query.token : '';
    if (!config.GMAIL_PUSH_TOKEN || !safeEqual(given, config.GMAIL_PUSH_TOKEN))
      throw new AppError('FORBIDDEN', 403, 'Bad push token');
    // Triggered before answering: on Netlify the function is frozen once it answers (immediate on a server).
    await service.pollSoon('push-triggered');
    res.status(204).end();
  });

  return router;
}

/** Settings → Gmail: connection, import settings, manual polls and imports. Mounted behind requireAuth (app.ts). */
export function gmailRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createGmailService(deps);

  router.get('/gmail/status', async (_req, res) => res.json(await deps.gmail.status()));

  router.get('/gmail/auth-url', requirePermission('gmail:manage'), async (req, res) => {
    const url = await service.authUrl(currentUser(req).id);
    setOAuthStateCookie(res, url);
    res.json({ url });
  });

  /** Starts a poll in the background (202): `started` false when one is already running. */
  router.post('/gmail/poll', requirePermission('gmail:manage'), async (req, res) => {
    const user = currentUser(req);
    res.status(202).json({ started: await service.pollNow({ id: user.id, name: user.name }) });
  });

  /** The import limits and the date automatic ingestion starts from (null until it first runs). */
  router.get('/gmail/import-settings', async (_req, res) => res.json(await service.importSettings()));

  /** Seconds between automatic Gmail checks: 0 turns polling off, otherwise POLL_INTERVAL_MIN–POLL_INTERVAL_MAX. */
  router.put('/gmail/poll-interval', requirePermission('gmail:manage'), async (req, res) => {
    const { seconds } = parseBody(PollIntervalBody, req.body);
    await service.setPollInterval(seconds, currentUser(req).id);
    res.json({ pollIntervalSeconds: seconds });
  });

  /** Past mail comes in only this way: queue every inbox email from the last `days` days (or today) not already here. */
  router.post('/gmail/import', requirePermission('gmail:manage'), async (req, res) => {
    const scope = parseBody(ImportBody, req.body);
    res.status(202).json(await service.importRecent(scope, currentUser(req).id));
  });

  router.post('/gmail/disconnect', requirePermission('gmail:manage'), async (req, res) => {
    await deps.gmail.disconnect(currentUser(req).id);
    res.json({ ok: true });
  });

  return router;
}
