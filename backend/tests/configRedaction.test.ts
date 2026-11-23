/** The startup log of the configuration (config.ts redactedConfig): secrets never reach it. */
import { describe, expect, it } from 'vitest';

import { redactedConfig } from '../src/config.js';

describe('redactedConfig', () => {
  it('masks secrets and the database password, and keeps the rest', () => {
    const out = redactedConfig({
      PORT: 3002,
      JWT_SECRET: 'x'.repeat(40),
      ENCRYPTION_KEY: 'k'.repeat(40),
      GOOGLE_CLIENT_SECRET: 's',
      GOOGLE_REFRESH_TOKEN: 'r',
      SUBMISSION_INTAKE_TOKEN: 't',
      SOME_NEW_API_KEY: 'n',
      ENCRYPTION_KEYS_PREVIOUS: 'old',
      GOOGLE_TOKEN_URI: 'https://oauth2.googleapis.com/token',
      LLM_DAILY_TOKEN_BUDGET: 100,
      DATABASE_URL: 'postgres://ims:hunter2@db:5432/ims',
      GMAIL_MCP_TOKEN: undefined,
    });
    expect(out).toEqual({
      PORT: 3002,
      JWT_SECRET: '[set]',
      ENCRYPTION_KEY: '[set]',
      GOOGLE_CLIENT_SECRET: '[set]',
      GOOGLE_REFRESH_TOKEN: '[set]',
      SUBMISSION_INTAKE_TOKEN: '[set]',
      SOME_NEW_API_KEY: '[set]',
      ENCRYPTION_KEYS_PREVIOUS: '[set]',
      GOOGLE_TOKEN_URI: 'https://oauth2.googleapis.com/token',
      LLM_DAILY_TOKEN_BUDGET: 100,
      DATABASE_URL: 'postgres://ims:[REDACTED]@db:5432/ims',
    });
  });

  it('never prints a secret value from the real configuration', () => {
    const text = JSON.stringify(redactedConfig());
    for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) {
      const value = process.env[key];
      if (value) expect(text).not.toContain(value);
    }
  });
});
