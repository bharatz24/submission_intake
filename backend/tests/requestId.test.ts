import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { logContext, withLogContext } from '../src/requestContext.js';

const { createApp } = await import('../src/app.js');

describe('request correlation', () => {
  it('returns X-Request-Id and the same requestId in the error envelope', async () => {
    const res = await request(createApp()).get('/api/submissions');
    expect(res.status).toBe(401);
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.error.requestId).toBe(id);
  });

  it('gives every request its own id, ignoring a client-sent one', async () => {
    const app = createApp();
    const a = await request(app).get('/api/submissions').set('X-Request-Id', 'forged');
    const b = await request(app).get('/api/submissions');
    expect(a.headers['x-request-id']).not.toBe('forged');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('nests log context, inner keys winning', async () => {
    await withLogContext({ requestId: 'r1' }, async () => {
      await withLogContext({ jobId: '7' }, async () => {
        expect(logContext()).toEqual({ requestId: 'r1', jobId: '7' });
      });
    });
    expect(logContext()).toEqual({});
  });
});
