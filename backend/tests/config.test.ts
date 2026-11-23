/** RUNTIME switch (config.ts): server by default; netlify needs WORKER_TOKEN and gets small pools. */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConfigSchema, resolveConfig } from '../src/config.js';

const BASE = {
  JWT_SECRET: randomBytes(48).toString('base64'),
  ENCRYPTION_KEY: `base64:${randomBytes(32).toString('base64')}`,
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'refresh',
};
const TOKEN = randomBytes(32).toString('hex');

function parse(env: Record<string, string>) {
  return ConfigSchema.safeParse(env);
}

/** The resolved configuration, failing the test when the environment does not parse. */
function resolved(env: Record<string, string>) {
  const r = parse(env);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return resolveConfig(r.data);
}

describe('RUNTIME', () => {
  it('RUNTIME defaults to server', () => {
    const cfg = resolved(BASE);
    expect(cfg.RUNTIME).toBe('server');
    expect(cfg.DB_POOL_MAX).toBe(cfg.JOB_CONCURRENCY * 2 + 10);
    expect(cfg.DB_LOCK_POOL_MAX).toBe(cfg.JOB_CONCURRENCY + 4);
  });

  it('RUNTIME=netlify without WORKER_TOKEN fails validation', () => {
    const r = parse({ ...BASE, RUNTIME: 'netlify' });
    expect(r.error?.issues.map((i) => i.path[0])).toContain('WORKER_TOKEN');
  });

  it('refuses a WORKER_TOKEN shorter than 32 characters', () => {
    expect(parse({ ...BASE, RUNTIME: 'netlify', WORKER_TOKEN: 'short' }).success).toBe(false);
  });

  it('netlify runtime defaults DB_POOL_MAX to 3 and DB_LOCK_POOL_MAX to 2', () => {
    const cfg = resolved({ ...BASE, RUNTIME: 'netlify', WORKER_TOKEN: TOKEN });
    expect(cfg.DB_POOL_MAX).toBe(3);
    expect(cfg.DB_LOCK_POOL_MAX).toBe(2);
  });

  it('explicit DB_POOL_MAX wins in netlify runtime', () => {
    const cfg = resolved({ ...BASE, RUNTIME: 'netlify', WORKER_TOKEN: TOKEN, DB_POOL_MAX: '8', DB_LOCK_POOL_MAX: '4' });
    expect(cfg.DB_POOL_MAX).toBe(8);
    expect(cfg.DB_LOCK_POOL_MAX).toBe(4);
  });
});
