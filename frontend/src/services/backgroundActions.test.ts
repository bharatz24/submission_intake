// PERF-01: long admin actions answer 202 and run on the server; the api functions wait for the outcome.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, waitForBackground } from './api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** fetch answering by "METHOD path suffix", each a queue of bodies (the last one repeats). */
function stubFetch(routes: Record<string, unknown[]>) {
  const seen: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = Object.keys(routes).find((k) => {
      const [m, suffix] = k.split(' ') as [string, string];
      return m === method && url.endsWith(suffix);
    });
    if (!key) throw new Error(`unexpected ${method} ${url}`);
    seen.push(key);
    const queue = routes[key] ?? [];
    const body = queue.length > 1 ? queue.shift() : queue[0];
    return json(body, method === 'POST' ? 202 : 200);
  });
  vi.stubGlobal('fetch', fetchMock);
  return seen;
}

describe('background actions (202 + status)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('IMS 2 sync resolves with the sync stored after it started, not an older one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const old = { at: '2026-11-18T09:00:00.000Z', by: 'A', pages: 1, seen: 0, updated: 0, linked: 0, rejected: 0 };
    const fresh = { ...old, at: '2026-11-18T10:00:05.000Z', linked: 2 };
    const seen = stubFetch({
      'POST /ims2-queue/sync': [{ started: true, since: '2026-11-18T10:00:00.000Z' }],
      'GET /ims2-queue/sync': [
        { lastSync: old, running: true },
        { lastSync: fresh, running: false },
      ],
    });
    const result = api.ims2QueueSync();
    await vi.runAllTimersAsync();
    expect(await result).toEqual(fresh);
    expect(seen).toEqual(['POST /ims2-queue/sync', 'GET /ims2-queue/sync', 'GET /ims2-queue/sync']);
  });

  it('"Process as submission" resolves with the new submission once the server has stored it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    stubFetch({
      'POST /skipped-emails/m1/process': [{ started: true }],
      'GET /skipped-emails/m1/process': [{ state: 'running' }, { state: 'done', submissionId: 's-9' }],
    });
    const result = api.processSkippedEmail('m1');
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ submissionId: 's-9' });
  });

  it('"Process as submission" rejects with the server error code when the run failed', async () => {
    stubFetch({
      'POST /skipped-emails/m2/process': [{ started: true }],
      'GET /skipped-emails/m2/process': [
        { state: 'failed', error: { code: 'GMAIL_MESSAGE_GONE', status: 410, message: 'gone' } },
      ],
    });
    const err = await api.processSkippedEmail('m2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 410, code: 'GMAIL_MESSAGE_GONE' });
  });

  it('ZIP data import resolves with the run that ended after it started, or its error', async () => {
    stubFetch({
      'POST /geo/import': [{ started: true, since: '2026-11-18T10:00:00.000Z' }],
      'GET /geo/import': [
        { running: false, last: { at: '2026-11-18T10:01:00.000Z', by: 'A', result: null, error: 'download failed' } },
      ],
    });
    await expect(api.importGeo()).rejects.toMatchObject({ code: 'GEO_IMPORT_FAILED', message: 'download failed' });
  });

  it('gives up waiting after the timeout, saying the work still runs', async () => {
    const err = await waitForBackground(async () => undefined, { intervalMs: 1, timeoutMs: 5 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'STILL_RUNNING' });
  });
});
