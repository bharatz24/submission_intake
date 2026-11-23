// DB-free tests of token verification, cookies, CSRF and log redaction (the DB-backed flow is in api.test.ts).
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { AUTH_COOKIE, authenticate, readCookie, signToken, verifyAccessToken } from '../src/http.js';
import { redactQuery, redactUrl } from '../src/logger.js';
import { checkSetupToken } from '../src/modules/auth/auth.service.js';
import { safeEqual } from '../src/services/crypto.js';
import { signOAuthState, verifyOAuthState } from '../src/services/gmail.js';

const secret = process.env.JWT_SECRET!;
const user = { id: '00000000-0000-4000-8000-0000000000aa', email: 'a@example.com', name: 'A', role: 'ADMIN' as const };
const fakeReq = (init: { method?: string; headers?: Record<string, string> }) =>
  ({ method: init.method ?? 'GET', headers: init.headers ?? {} }) as unknown as import('express').Request;

describe('login tokens', () => {
  it('round-trips a login token with its version and expiry', () => {
    const claims = verifyAccessToken(signToken(user, 3));
    expect(claims).toMatchObject({ sub: user.id, role: 'ADMIN', tv: 3 });
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('rejects the Gmail OAuth state token, and the state check rejects a login token', () => {
    const state = signOAuthState(user.id);
    expect(verifyOAuthState(state)).toBe(user.id);
    expect(() => verifyAccessToken(state)).toThrow();
    expect(() => verifyOAuthState(signToken(user))).toThrow();
    // Even the old-style state (signed with JWT_SECRET itself) is not a login token.
    expect(() => verifyAccessToken(jwt.sign({ sub: user.id, purpose: 'gmail-oauth' }, secret))).toThrow();
  });

  it('rejects tokens without the audience, type, version or a valid role, and other algorithms', () => {
    const opts = { issuer: 'ims-submission-review', audience: 'ims-api', expiresIn: '1h' } as const;
    expect(() => verifyAccessToken(jwt.sign({ sub: user.id, role: 'ADMIN', tv: 0, typ: 'access' }, secret))).toThrow();
    expect(() => verifyAccessToken(jwt.sign({ sub: user.id, role: 'ADMIN', tv: 0 }, secret, opts))).toThrow();
    expect(() => verifyAccessToken(jwt.sign({ sub: user.id, role: 'ADMIN', typ: 'access' }, secret, opts))).toThrow();
    expect(() =>
      verifyAccessToken(jwt.sign({ sub: user.id, role: 'ROOT', tv: 0, typ: 'access' }, secret, opts)),
    ).toThrow();
    expect(() =>
      verifyAccessToken(
        jwt.sign({ sub: user.id, role: 'ADMIN', tv: 0, typ: 'access' }, secret, { ...opts, algorithm: 'HS512' }),
      ),
    ).toThrow();
    expect(verifyAccessToken(jwt.sign({ sub: user.id, role: 'ADMIN', tv: 0, typ: 'access' }, secret, opts)).sub).toBe(
      user.id,
    );
  });
});

describe('authenticate (before any database lookup)', () => {
  it('needs a token', async () => {
    await expect(authenticate(fakeReq({}))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an OAuth state token sent as a bearer token', async () => {
    await expect(
      authenticate(fakeReq({ headers: { authorization: `Bearer ${signOAuthState(user.id)}` } })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('requires the CSRF header on a cookie-authenticated POST', async () => {
    const cookie = `other=1; ${AUTH_COOKIE}=${signToken(user)}`;
    await expect(authenticate(fakeReq({ method: 'POST', headers: { cookie } }))).rejects.toMatchObject({
      status: 403,
      code: 'CSRF_HEADER_REQUIRED',
    });
  });
});

describe('readCookie', () => {
  it('finds one cookie among several', () => {
    expect(readCookie('a=1; ims_session=abc.def; b=2', 'ims_session')).toBe('abc.def');
    expect(readCookie('xims_session=1', 'ims_session')).toBeNull();
    expect(readCookie(undefined, 'ims_session')).toBeNull();
  });
});

describe('log redaction', () => {
  it('redacts secrets in query strings and leaves the rest', () => {
    expect(redactUrl('/api/gmail/push?token=s3cret')).toBe('/api/gmail/push?token=[REDACTED]');
    expect(redactUrl('/api/gmail/oauth/callback?state=abc&code=xyz&scope=gmail')).toBe(
      '/api/gmail/oauth/callback?state=[REDACTED]&code=[REDACTED]&scope=gmail',
    );
    expect(redactUrl('/api/submissions?page=2')).toBe('/api/submissions?page=2');
    expect(redactUrl('/api/health')).toBe('/api/health');
    expect(redactQuery({ token: 'x', page: '1' })).toEqual({ token: '[REDACTED]', page: '1' });
  });
});

describe('safeEqual', () => {
  it('compares strings of any length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('first-user setup token (SEC-08)', () => {
  const TOKEN = 'setup-token-0123456789abcdef';

  it('is not asked for outside production', () => {
    expect(() => checkSetupToken(undefined, { requireToken: false, setupToken: undefined })).not.toThrow();
  });

  it('in production, refuses the bootstrap until SETUP_TOKEN is configured', () => {
    expect(() => checkSetupToken(TOKEN, { requireToken: true, setupToken: undefined })).toThrow(
      expect.objectContaining({ status: 503, code: 'SETUP_TOKEN_NOT_CONFIGURED' }),
    );
  });

  it('in production, needs the exact token', () => {
    const guard = { requireToken: true, setupToken: TOKEN };
    for (const given of [undefined, '', 'wrong', `${TOKEN}x`])
      expect(() => checkSetupToken(given, guard)).toThrow(
        expect.objectContaining({ status: 403, code: 'SETUP_TOKEN_INVALID' }),
      );
    expect(() => checkSetupToken(TOKEN, guard)).not.toThrow();
  });
});
