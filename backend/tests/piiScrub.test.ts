/** PII-safe logs (spec §6): free text scrubbed before it is logged, and PII keys redacted by the logger's config. */
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { loggerOptions } from '../src/logger.js';
import { scrubText } from '../src/services/piiScrub.js';

interface LogEntry {
  [key: string]: unknown;
  err: { message: string; stack: string; type: string };
}

/** A logger with the app's options, writing JSON lines to memory. */
function memoryLogger() {
  const lines: string[] = [];
  const log = pino({ ...loggerOptions, level: 'info' }, { write: (s: string) => void lines.push(s) });
  const first = (): LogEntry => {
    const [line] = lines;
    if (!line) throw new Error('nothing was logged');
    return JSON.parse(line) as LogEntry;
  };
  return { log, first };
}

describe('scrubText', () => {
  it('removes emails, NPIs, US phone numbers and SSNs', () => {
    const out = scrubText('Dr. x jane@clinic.com NPI 1234567893 (512) 555-0100 SSN 123-45-6789');
    for (const v of ['jane@clinic.com', '1234567893', '555-0100', '(512)', '123-45-6789']) expect(out).not.toContain(v);
    expect(out).toContain('[REDACTED-EMAIL]');
    expect(out).toContain('[REDACTED-NPI]');
    expect(out).toContain('[REDACTED-PHONE]');
    expect(out).toContain('[REDACTED-SSN]');
  });

  it('catches other phone formats and keeps ordinary text', () => {
    for (const phone of ['512-555-0100', '512.555.0100', '+1 512 555 0100', '1-512-555-0100'])
      expect(scrubText(`call ${phone} now`)).toBe('call [REDACTED-PHONE] now');
    expect(scrubText('Limits 1M/3M, 12 claims in 2024, job 42')).toBe('Limits 1M/3M, 12 claims in 2024, job 42');
  });
});

describe('logger redaction', () => {
  it('redacts PII keys and keeps error details and correlation ids', () => {
    const { log, first } = memoryLogger();
    const err = new Error('boom');
    log.error(
      {
        subject: 'Jane Roe app',
        body: 'Applicant Jane Roe',
        err,
        requestId: 'r1',
        jobId: 'j1',
        name: 'Jane Roe',
        email: { from: 'jane@clinic.com', to: 'uw@acme.com', bodyText: 'x', applicantName: 'Jane Roe', name: 'kept' },
        applicantName: 'Jane Roe',
      },
      'failed',
    );
    const e = first();
    expect(e.subject).toBe('[REDACTED]');
    expect(e.body).toBe('[REDACTED]');
    expect(e.name).toBe('[REDACTED]');
    expect(e.applicantName).toBe('[REDACTED]');
    expect(e.email).toBe('[REDACTED]');
    expect(e.err.message).toBe('boom');
    expect(e.err.stack).toContain('boom');
    expect(e.err.type).toBe('Error');
    expect(e.requestId).toBe('r1');
    expect(e.jobId).toBe('j1');
    expect(JSON.stringify(e)).not.toContain('Jane Roe');
  });

  it('redacts PII keys one level down, but never a nested name', () => {
    const { log, first } = memoryLogger();
    log.warn(
      { email: undefined, ctx: { subject: 'Jane', npi: '1234567893', applicantName: 'Jane', name: 'synthesis' } },
      'x',
    );
    const e = first();
    expect(e.ctx).toEqual({
      subject: '[REDACTED]',
      npi: '[REDACTED]',
      applicantName: '[REDACTED]',
      name: 'synthesis',
    });
  });

  it('scrubs PII from logged error messages and stacks', () => {
    const { log, first } = memoryLogger();
    log.error({ err: new Error('Could not parse jane@clinic.com SSN 123-45-6789') }, 'failed');
    const e = first();
    expect(e.err.message).toBe('Could not parse [REDACTED-EMAIL] SSN [REDACTED-SSN]');
    expect(e.err.stack).not.toContain('jane@clinic.com');
  });

  it('scrubs PII from pg error detail, where and hint, and keeps the schema names', () => {
    const { log, first } = memoryLogger();
    const err = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
      code: '23505',
      detail: 'Key (email)=(jane@clinic.com) already exists.',
      where: 'SQL function "f" statement 1, value 555-123-4567',
      hint: 'Check NPI 1234567893',
      table: 'users',
      constraint: 'users_email_key',
    });
    log.error({ err }, 'insert failed');
    const e = first().err as unknown as Record<string, unknown>;
    const line = JSON.stringify(e);
    expect(line).not.toContain('jane@clinic.com');
    expect(line).not.toContain('555-123-4567');
    expect(line).not.toContain('1234567893');
    expect(e.detail).toBe('Key (email)=([REDACTED-EMAIL]) already exists.');
    expect(e).toMatchObject({ code: '23505', table: 'users', constraint: 'users_email_key' });
  });

  it('keeps a network error address and port, and redacts every other address and filename', () => {
    const { log, first } = memoryLogger();
    const err = Object.assign(new Error('connect ECONNREFUSED'), { address: '127.0.0.1', port: 5432 });
    log.error(
      { err, address: '1 Main St', filename: 'Jane_Roe_app.pdf', ctx: { address: '2 Main St', filename: 'x.pdf' } },
      'failed',
    );
    const e = first();
    expect(e.err).toMatchObject({ address: '127.0.0.1', port: 5432 });
    expect(e.address).toBe('[REDACTED]');
    expect(e.filename).toBe('[REDACTED]');
    expect(e.ctx).toEqual({ address: '[REDACTED]', filename: '[REDACTED]' });
  });
});

describe('deep redaction (MON-04)', () => {
  it('redacts secret and PII keys two and more levels down, in arrays too, and keeps nested names', () => {
    const { log, first } = memoryLogger();
    const input = {
      job: {
        payload: { email: { from: 'jane@clinic.com' }, npi: '1234567893', name: 'synthesis', count: 2 },
        steps: [{ prompt: 'Applicant Jane Roe', token: 'sk-secret', ok: true }],
        deeper: { a: { b: { c: { applicantName: 'Jane Roe', refreshToken: 'rt-secret' } } } },
      },
    };
    log.info(input, 'x');
    const e = first() as unknown as { job: Record<string, any> };
    expect(e.job.payload).toEqual({ email: '[REDACTED]', npi: '[REDACTED]', name: 'synthesis', count: 2 });
    expect(e.job.steps).toEqual([{ prompt: '[REDACTED]', token: '[REDACTED]', ok: true }]);
    expect(e.job.deeper.a.b.c).toEqual({ applicantName: '[REDACTED]', refreshToken: '[REDACTED]' });
    const line = JSON.stringify(e);
    for (const v of ['jane@clinic.com', '1234567893', 'Jane Roe', 'sk-secret', 'rt-secret'])
      expect(line).not.toContain(v);
    // The logged object itself is untouched.
    expect(input.job.payload.npi).toBe('1234567893');
  });

  it('survives circular references and very deep objects', () => {
    const { log, first } = memoryLogger();
    const loop: Record<string, unknown> = { id: 1 };
    loop.self = loop;
    let deep: Record<string, unknown> = { email: 'jane@clinic.com' };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    log.info({ ctx: { loop, deep } }, 'x');
    expect(JSON.stringify(first())).not.toContain('jane@clinic.com');
  });
});

describe('logging Google API errors', () => {
  /**
   * A googleapis (gaxios) error: its `response` is a fetch Response whose prototype has a getter-only `data`, with
   * the parsed body set on the instance. Cloning it for redaction used to throw and crash the process (QA-001).
   */
  function gaxiosError() {
    class Body {
      get data(): unknown {
        return undefined;
      }
    }
    const response = Object.create(Body.prototype) as Record<string, unknown>;
    Object.defineProperty(response, 'data', {
      value: { error: 'invalid_client', error_description: 'Unauthorized' },
      enumerable: true,
      writable: true,
    });
    Object.assign(response, {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'content-type': 'application/json' },
      config: {
        url: 'https://oauth2.googleapis.com/token?x=1',
        method: 'POST',
        headers: { authorization: 'Bearer sekret' },
      },
    });
    class GaxiosError extends Error {}
    const err = Object.assign(new GaxiosError('invalid_client'), {
      name: 'GaxiosError',
      status: 401,
      code: '401',
      config: {
        url: 'https://oauth2.googleapis.com/token',
        method: 'POST',
        headers: { Authorization: 'Bearer sekret' },
      },
      response,
    });
    return err;
  }

  it('logs it without throwing, keeping status and code and dropping the request and response', () => {
    const { log, first } = memoryLogger();
    expect(() =>
      log.error({ err: gaxiosError(), scope: 'reconcile:drive-orphans' }, 'scheduled check failed'),
    ).not.toThrow();
    const e = first().err as unknown as Record<string, unknown>;
    expect(e).toMatchObject({ type: 'GaxiosError', message: 'invalid_client', status: 401, code: '401' });
    expect(JSON.stringify(first())).not.toContain('sekret');
    expect(e.response).toEqual({ status: 401, statusText: 'Unauthorized' });
    expect(e.config).toEqual({ method: 'POST', url: 'https://oauth2.googleapis.com/token' });
  });
});
