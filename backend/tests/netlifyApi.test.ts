/** API behaviour specific to RUNTIME=netlify (no DB needed): worker triggers instead of in-process work, no SSE. */
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const PUSH_TOKEN = 'push-token-for-netlify-test-0123456789';
process.env.RUNTIME = 'netlify';
process.env.WORKER_TOKEN = 'push-test-worker-token-0123456789abcdef';
process.env.GMAIL_PUSH_TOKEN = PUSH_TOKEN;

const triggerWorker = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/runtime/workerTrigger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/workerTrigger.js')>()),
  triggerWorker,
}));

let app: import('express').Express;
const pollOnce = vi.fn(async () => 0);

beforeAll(async () => {
  const { createApp } = await import('../src/app.js');
  const { defaultDeps } = await import('../src/deps.js');
  app = createApp({ gmail: { ...defaultDeps().gmail, pollOnce } });
});

describe('gmail push in netlify runtime', () => {
  it('gmail push route triggers gmail-poll worker in netlify runtime', async () => {
    await request(app).post(`/api/gmail/push?token=${PUSH_TOKEN}`).send({}).expect(204);
    expect(triggerWorker).toHaveBeenCalledWith('gmail-poll', undefined);
    expect(pollOnce).not.toHaveBeenCalled(); // the worker polls, not the API function
  });

  it('refuses a bad push token without triggering anything', async () => {
    triggerWorker.mockClear();
    await request(app).post('/api/gmail/push?token=wrong').send({}).expect(403);
    expect(triggerWorker).not.toHaveBeenCalled();
  });
});
