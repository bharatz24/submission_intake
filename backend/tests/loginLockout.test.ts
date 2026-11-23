import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { errorHandler } from '../src/errorHandler.js';
import { accountLoginLimiters } from '../src/modules/auth/auth.routes.js';

/** A login route that fails unless the password is "right", behind the account limiters (3 per IP, 5 in total). */
function app() {
  const a = express();
  a.set('trust proxy', true);
  a.use(express.json());
  a.post('/login', ...accountLoginLimiters(3, 5), (req, res) => {
    res.status(req.body.password === 'right' ? 200 : 401).end();
  });
  a.use(errorHandler);
  return a;
}
const attempt = (a: express.Express, ip: string, password = 'wrong', email = 'victim@x.test') =>
  request(a).post('/login').set('X-Forwarded-For', ip).send({ email, password });

describe('failed sign-in limits (QA-011)', () => {
  it('locks out the IP guessing, not the real user signing in from elsewhere', async () => {
    const a = app();
    for (let i = 0; i < 3; i++) expect((await attempt(a, '203.0.113.9')).status).toBe(401);
    const blocked = await attempt(a, '203.0.113.9');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect((await attempt(a, '198.51.100.7', 'right')).status).toBe(200);
    // Other accounts from the guessing IP are counted on their own.
    expect((await attempt(a, '203.0.113.9', 'wrong', 'other@x.test')).status).toBe(401);
  });

  it('still stops a guess spread over many IPs at the per-account total', async () => {
    const a = app();
    for (let i = 0; i < 5; i++) expect((await attempt(a, `192.0.2.${i}`)).status).toBe(401);
    expect((await attempt(a, '192.0.2.200')).status).toBe(429);
  });
});
