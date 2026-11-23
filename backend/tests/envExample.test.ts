import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';

import { EnvSchema } from '../src/config.js';

const text = readFileSync(new URL('../env.example', import.meta.url), 'utf8');
/** Every key in env.example, set or commented out (`# KEY=`). */
const listed = new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
const schemaKeys = Object.keys(EnvSchema.shape);

describe('env.example', () => {
  it('lists every key of EnvSchema', () => {
    expect(schemaKeys.filter((k) => !listed.has(k))).toEqual([]);
  });

  it('lists no key the server does not read', () => {
    expect([...listed].filter((k) => !schemaKeys.includes(k))).toEqual([]);
  });

  it('leaves the secrets blank, so a copied file never runs with a published value', () => {
    const env = parse(text);
    expect(env.JWT_SECRET).toBe('');
    expect(env.ENCRYPTION_KEY).toBe('');
    expect(EnvSchema.safeParse(env).success).toBe(false);
  });

  it('parses as a valid configuration once copied to .env and the secrets are filled in', () => {
    const result = EnvSchema.safeParse({
      ...parse(text),
      JWT_SECRET: randomBytes(48).toString('base64'),
      ENCRYPTION_KEY: `base64:${randomBytes(32).toString('base64')}`,
    });
    expect(result.success ? [] : result.error.issues).toEqual([]);
    expect(result.data?.GDRIVE_ROOT_FOLDER_NAME).toBe('Submission Review'); // inline comments are stripped
    expect(result.data?.OUTBOUND_ALLOWED_DOMAINS).toEqual([]);
  });
});
