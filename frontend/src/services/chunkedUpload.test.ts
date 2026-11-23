import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mode = vi.hoisted(() => ({ upload: 'direct' as 'direct' | 'chunked' }));
vi.mock('../config/env', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config/env')>();
  return {
    ...real,
    env: {
      ...real.env,
      get uploadMode() {
        return mode.upload;
      },
    },
  };
});

const { api, ApiError, uploadFileInChunks } = await import('./api');

const MIB = 1024 * 1024;
const CHUNK = 3 * MIB;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Call = { method: string; url: string; body: unknown };
/** A fetch double for the upload routes; `failChunk` makes those chunk PUTs fail (each listed once per failure). */
function server(opts: { failChunk?: number[] } = {}) {
  const calls: Call[] = [];
  const failures = [...(opts.failChunk ?? [])];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body });
    if (method === 'POST' && url.endsWith('/uploads')) {
      const { size } = JSON.parse(String(init.body)) as { size: number };
      return json(
        { uploadId: `up-${calls.length}`, chunkBytes: CHUNK, chunkCount: Math.max(1, Math.ceil(size / CHUNK)) },
        201,
      );
    }
    const chunk = /\/chunks\/(\d+)$/.exec(url);
    if (method === 'PUT' && chunk) {
      const i = failures.indexOf(Number(chunk[1]));
      if (i >= 0) {
        failures.splice(i, 1);
        return json({ error: { code: 'BOOM', message: 'chunk store unavailable' } }, 502);
      }
      return new Response(null, { status: 204 });
    }
    return json({ id: 'sub-1' }, 201);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}
const file = (bytes: number, name = 'loss-runs.pdf') =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

beforeEach(() => {
  mode.upload = 'direct';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chunked uploads', () => {
  it('chunked mode splits a 7 MiB file into 3 chunks and posts uploadIds', async () => {
    mode.upload = 'chunked';
    const { calls } = server();
    await api.uploadSubmission({ subject: 'S', fromAddress: 'b@broker.test', bodyText: '', files: [file(7 * MIB)] });
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url.replace(/^.*\/uploads\//, ''))).toEqual([
      'up-1/chunks/0',
      'up-1/chunks/1',
      'up-1/chunks/2',
    ]);
    expect(puts.map((c) => (c.body as Blob).size)).toEqual([CHUNK, CHUNK, MIB]);
    const final = calls[calls.length - 1]!;
    expect(final.url).toMatch(/\/submissions\/upload$/);
    expect(JSON.parse(String(final.body))).toEqual({
      subject: 'S',
      fromAddress: 'b@broker.test',
      bodyText: '',
      uploadIds: ['up-1'],
    });
  });

  it('reports progress per chunk', async () => {
    server();
    const progress: number[] = [];
    await uploadFileInChunks(file(CHUNK + 5), undefined, (n) => progress.push(n));
    expect(progress).toEqual([CHUNK, CHUNK + 5]);
  });

  it('chunk failure retries once then rejects with AppError', async () => {
    const once = server({ failChunk: [1] });
    await expect(uploadFileInChunks(file(CHUNK + 5))).resolves.toBe('up-1');
    expect(once.calls.filter((c) => c.method === 'PUT').length).toBe(3); // chunk 1 sent twice
    vi.unstubAllGlobals();
    const twice = server({ failChunk: [0, 0] });
    const err = await uploadFileInChunks(file(10)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(502);
    expect(twice.calls.filter((c) => c.method === 'PUT').length).toBe(2);
  });

  it('uploadDocuments in chunked mode posts the upload ids as JSON', async () => {
    mode.upload = 'chunked';
    const { calls } = server();
    await api.uploadDocuments('sub-1', [file(10, 'a.pdf'), file(20, 'b.pdf')]);
    const final = calls[calls.length - 1]!;
    expect(final.url).toMatch(/\/submissions\/sub-1\/documents$/);
    expect(JSON.parse(String(final.body))).toEqual({ uploadIds: ['up-1', 'up-3'] });
  });

  it('direct mode still posts FormData', async () => {
    const { calls } = server();
    await api.uploadSubmission({ subject: 'S', fromAddress: 'b@broker.test', bodyText: '', files: [file(7 * MIB)] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toBeInstanceOf(FormData);
  });
});
