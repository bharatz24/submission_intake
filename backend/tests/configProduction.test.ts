/** Production-only configuration rules (config.ts ConfigSchema): placeholder/weak secrets, key form, https URLs. */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';

import { ConfigSchema, isPublicHttpsUrl, weakSecretReason } from '../src/config.js';

const JWT = randomBytes(48).toString('base64');
const KEY = `base64:${randomBytes(32).toString('base64')}`;
/** A complete, acceptable production environment; each test spoils one value. */
const PROD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://ims:pw@db:5432/ims',
  JWT_SECRET: JWT,
  ENCRYPTION_KEY: KEY,
  FRONTEND_ORIGIN: 'https://review.example.org',
  GOOGLE_REDIRECT_URI: 'https://review.example.org/api/gmail/oauth/callback',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'refresh',
};

/** The keys the parse complained about, and every message (to check no secret value is echoed). */
function problems(env: Record<string, string | undefined>) {
  const r = ConfigSchema.safeParse(env);
  const issues = r.success ? [] : r.error.issues;
  return { keys: issues.map((i) => String(i.path[0])), text: JSON.stringify(issues) };
}

describe('production configuration', () => {
  it('accepts a complete production environment', () => {
    expect(problems(PROD).keys).toEqual([]);
  });

  it('refuses the old env.example placeholders without printing them', () => {
    const placeholder = 'change-me-at-least-32-characters-long-random-value';
    const { keys, text } = problems({ ...PROD, JWT_SECRET: placeholder, ENCRYPTION_KEY: placeholder });
    expect(keys).toEqual(expect.arrayContaining(['JWT_SECRET', 'ENCRYPTION_KEY']));
    expect(text).not.toContain(placeholder);
  });

  it('refuses the shipped env.example as is, even with the URLs and database filled in', () => {
    const example = parse(readFileSync(new URL('../env.example', import.meta.url), 'utf8'));
    const { keys } = problems({
      ...example,
      ...PROD,
      JWT_SECRET: example.JWT_SECRET,
      ENCRYPTION_KEY: example.ENCRYPTION_KEY,
    });
    expect(keys).toEqual(expect.arrayContaining(['JWT_SECRET', 'ENCRYPTION_KEY']));
  });

  it('refuses repetitive secrets, an all-zero key, and the same value for both', () => {
    expect(problems({ ...PROD, JWT_SECRET: 'a'.repeat(64) }).keys).toEqual(['JWT_SECRET']);
    expect(problems({ ...PROD, JWT_SECRET: 'abc123'.repeat(8) }).keys).toEqual(['JWT_SECRET']);
    expect(problems({ ...PROD, ENCRYPTION_KEY: `base64:${Buffer.alloc(32).toString('base64')}` }).keys).toEqual([
      'ENCRYPTION_KEY',
    ]);
    expect(problems({ ...PROD, JWT_SECRET: KEY }).keys).toEqual(['ENCRYPTION_KEY']);
  });

  it('requires the base64 key form, while a passphrase may stay in ENCRYPTION_KEYS_PREVIOUS for rotation', () => {
    const passphrase = randomBytes(30).toString('hex');
    expect(problems({ ...PROD, ENCRYPTION_KEY: passphrase }).keys).toEqual(['ENCRYPTION_KEY']);
    expect(problems({ ...PROD, ENCRYPTION_KEYS_PREVIOUS: passphrase }).keys).toEqual([]);
  });

  it('requires https, non-localhost FRONTEND_ORIGIN and GOOGLE_REDIRECT_URI (the defaults are refused)', () => {
    const { FRONTEND_ORIGIN: _o, GOOGLE_REDIRECT_URI: _r, ...withoutUrls } = PROD;
    expect(problems(withoutUrls).keys).toEqual(['FRONTEND_ORIGIN', 'GOOGLE_REDIRECT_URI']);
    expect(problems({ ...PROD, FRONTEND_ORIGIN: 'http://review.example.org' }).keys).toEqual(['FRONTEND_ORIGIN']);
    expect(problems({ ...PROD, GOOGLE_REDIRECT_URI: 'https://localhost/cb' }).keys).toEqual(['GOOGLE_REDIRECT_URI']);
  });

  it('leaves development and test as they were', () => {
    const dev = {
      ...PROD,
      NODE_ENV: 'development',
      DATABASE_URL: undefined,
      FRONTEND_ORIGIN: undefined,
      GOOGLE_REDIRECT_URI: undefined,
      JWT_SECRET: 'dev-secret-dev-secret-dev-secret-dev',
      ENCRYPTION_KEY: 'dev-passphrase-dev-passphrase-dev-passphrase',
    };
    expect(problems(dev).keys).toEqual([]);
    expect(problems({ ...dev, NODE_ENV: 'test' }).keys).toEqual([]);
  });

  it('validates SETUP_TOKEN length when set, and treats blank as unset', () => {
    expect(problems({ ...PROD, SETUP_TOKEN: 'short' }).keys).toEqual(['SETUP_TOKEN']);
    expect(ConfigSchema.parse({ ...PROD, SETUP_TOKEN: '  ' }).SETUP_TOKEN).toBeUndefined();
    expect(problems({ ...PROD, SETUP_TOKEN: randomBytes(24).toString('base64url') }).keys).toEqual([]);
  });
});

describe('secret and URL helpers', () => {
  it('weakSecretReason never returns the value', () => {
    const v = 'change-me-please-0123456789abcdefghij';
    expect(weakSecretReason(v)).not.toContain(v);
    expect(weakSecretReason(JWT)).toBeNull();
  });

  it('isPublicHttpsUrl', () => {
    expect(isPublicHttpsUrl('https://app.example.org')).toBe(true);
    for (const u of [
      'http://app.example.org',
      'https://127.0.0.1',
      'https://[::1]:8443',
      'not a url',
      'https://a.localhost',
    ])
      expect(isPublicHttpsUrl(u)).toBe(false);
  });
});
