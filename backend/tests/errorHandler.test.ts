/** The error middleware (errorHandler.ts): fixed client messages for parser/upload failures, and started responses. */
import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as LoggerModule from '../src/logger.js';

const logged = vi.hoisted(() => [] as { level: string; obj: Record<string, unknown>; msg: string }[]);
vi.mock('../src/logger.js', async (orig) => {
  const real = await orig<typeof LoggerModule>();
  const capture = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    logged.push({ level, obj, msg });
  };
  return {
    ...real,
    logger: { ...real.logger, error: capture('error'), warn: capture('warn'), info: () => undefined },
  };
});
vi.mock('../src/services/audit.js', () => ({ recordSystemError: async () => undefined }));

const { errorHandler } = await import('../src/errorHandler.js');
const { limitedUpload } = await import('../src/http.js');

const app = express()
  .use(express.json())
  .post('/json', (_req, res) => {
    res.json({ ok: true });
  })
  .get('/multer', () => {
    throw new multer.MulterError('LIMIT_FIELD_KEY', 'secret-field');
  })
  .post(
    '/upload',
    limitedUpload('files', () => ({ maxFileMb: 1, maxFiles: 2 })),
    (_req, res) => {
      res.json({ ok: true });
    },
  )
  .get('/stream', (_req, res, next) => {
    res.write('partial');
    next(new Error('failed mid-stream'));
  })
  .use(errorHandler);

describe('errorHandler', () => {
  beforeEach(() => {
    logged.length = 0;
  });

  it('answers a multer error with a fixed message and its reason code', async () => {
    const res = await request(app).get('/multer');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_UPLOAD',
      message: 'The upload was rejected',
      details: { reason: 'LIMIT_FIELD_KEY', field: 'secret-field' },
    });
  });

  it('does not echo a body-parser message', async () => {
    const res = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json; charset=x-not-a-charset')
      .send('{"a":1}');
    expect(res.status).toBe(415);
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'The request body could not be read' });
    expect(JSON.stringify(res.body)).not.toContain('x-not-a-charset');
    expect(logged.some((l) => l.msg === 'client request rejected')).toBe(true);
  });

  it('does not echo a multipart parser message, and logs it instead', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('--x\r\nContent-Disposition: form-data; name="files"; filename="secret-name.pdf"\r\n');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_UPLOAD',
      message: 'The upload could not be read. Send the files again.',
    });
    expect(logged.some((l) => l.msg === 'unreadable multipart upload')).toBe(true);
  });

  it('leaves a response that already started to Express instead of writing JSON after it', async () => {
    const res = await request(app)
      .get('/stream')
      .buffer(true)
      .parse((r, cb) => {
        let text = '';
        r.on('data', (c: Buffer) => (text += c.toString()));
        r.on('end', () => cb(null, text));
        r.on('error', () => cb(null, text));
      })
      .catch((e: unknown) => e);
    // The connection is closed (an aborted transfer) or ends with what was written; never an error envelope.
    const body = (res as { body?: unknown }).body;
    if (typeof body === 'string') expect(body).not.toContain('"error"');
    expect(logged.some((l) => l.msg === 'error after the response started')).toBe(true);
  });
});
