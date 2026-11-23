/** Worker trigger (runtime/workerTrigger.ts): authenticated POST to the background function; failures swallowed. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const TOKEN = 'trigger-test-worker-token-0123456789abcdef';
process.env.RUNTIME = 'netlify';
process.env.WORKER_TOKEN = TOKEN;

let mod: typeof import('../src/runtime/workerTrigger.js');
beforeAll(async () => {
  mod = await import('../src/runtime/workerTrigger.js');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('triggerWorker', () => {
  it('POSTs the task to the worker function with the worker token', async () => {
    vi.stubEnv('URL', 'https://review.example.org');
    vi.stubEnv('CONTEXT', 'production');
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    await mod.triggerWorker('ims2-sync', { actor: { id: 'u1', name: 'Ann' } }, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://review.example.org/.netlify/functions/worker-background');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-worker-token')).toBe(TOKEN);
    expect(JSON.parse(String(init?.body))).toEqual({ task: 'ims2-sync', actor: { id: 'u1', name: 'Ann' } });
  });

  it('a deploy preview triggers its own deploy, not the production site', () => {
    expect(mod.workerBaseUrl({ CONTEXT: 'branch-deploy', URL: 'https://prod', DEPLOY_URL: 'https://abc--site' })).toBe(
      'https://abc--site',
    );
    expect(mod.workerBaseUrl({ CONTEXT: 'production', URL: 'https://prod', DEPLOY_URL: 'https://abc--site' })).toBe(
      'https://prod',
    );
  });

  it('swallows network errors and refusals', async () => {
    vi.stubEnv('URL', 'https://review.example.org');
    await expect(
      mod.triggerWorker('jobs', {}, async () => {
        throw new Error('ECONNRESET');
      }),
    ).resolves.toBeUndefined();
    await expect(
      mod.triggerWorker('jobs', {}, async () => new Response(null, { status: 401 })),
    ).resolves.toBeUndefined();
  });

  it('does nothing without a site URL', async () => {
    vi.stubEnv('URL', '');
    vi.stubEnv('DEPLOY_URL', '');
    const fetchFn = vi.fn<typeof fetch>();
    await mod.triggerWorker('jobs', {}, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('recognises task names', () => {
    expect(mod.isWorkerTask('gmail-poll')).toBe(true);
    expect(mod.isWorkerTask('rm -rf')).toBe(false);
    expect(mod.isWorkerTask(undefined)).toBe(false);
  });
});
