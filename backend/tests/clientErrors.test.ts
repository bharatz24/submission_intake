/** POST /api/client-errors: browser error reports reach the log, validated, with the URL reduced to its path. */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => [] as { level: string; obj: Record<string, any>; msg: string }[]);
vi.mock('../src/logger.js', async (orig) => {
  const real = await orig<typeof import('../src/logger.js')>();
  const capture = (level: string) => (obj: Record<string, any>, msg: string) => {
    logged.push({ level, obj, msg });
  };
  return {
    ...real,
    logger: {
      ...real.logger,
      error: capture('error'),
      warn: capture('warn'),
      info: () => undefined,
      debug: () => undefined,
    },
  };
});

const { clientErrorsRouter } = await import('../src/modules/clientErrors/clientErrors.routes.js');
const { errorHandler } = await import('../src/errorHandler.js');
const app = express().use(express.json()).use('/api', clientErrorsRouter).use(errorHandler);

describe('POST /api/client-errors', () => {
  beforeEach(() => {
    logged.length = 0;
  });

  it('logs a report without a session, keeping only the path of the URL', async () => {
    const res = await request(app).post('/api/client-errors').send({
      message: 'Cannot read properties of undefined',
      source: 'error-boundary',
      stack: 'at X',
      url: 'https://app.example/submissions/1?token=secret',
    });
    expect(res.status).toBe(204);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      level: 'error',
      msg: 'client error',
      obj: { userId: null, clientError: { source: 'error-boundary', url: '/submissions/1' } },
    });
    expect(JSON.stringify(logged[0])).not.toContain('secret');
  });

  it('scrubs PII from the message and stacks before logging', async () => {
    await request(app)
      .post('/api/client-errors')
      .send({
        message: 'No submission for jane@clinic.com (NPI 1234567893)',
        stack: 'Error: jane@clinic.com\n    at X',
        componentStack: 'at Card (555) 555-0100',
      })
      .expect(204);
    const text = JSON.stringify(logged[0]);
    for (const v of ['jane@clinic.com', '1234567893', '555-0100']) expect(text).not.toContain(v);
    expect(logged[0]!.obj.clientError.message).toBe('No submission for [REDACTED-EMAIL] (NPI [REDACTED-NPI])');
  });

  it('logs warnings at warn level', async () => {
    await request(app).post('/api/client-errors').send({ level: 'warn', message: 'stream reconnecting' }).expect(204);
    expect(logged[0]).toMatchObject({ level: 'warn', msg: 'client warning' });
  });

  it('refuses a report without a message, or one too long', async () => {
    expect((await request(app).post('/api/client-errors').send({ source: 'x' })).status).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/client-errors')
          .send({ message: 'x'.repeat(2001) })
      ).status,
    ).toBe(400);
    expect(logged).toHaveLength(0);
  });
});
