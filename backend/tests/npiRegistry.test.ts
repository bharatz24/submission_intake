import { describe, expect, it, vi } from 'vitest';

import { backoffMs, retryAfterMs } from '../src/services/httpRetry.js';
import { lookupNpi, type NpiCache, type NpiLookup, searchNpi } from '../src/services/npi.js';

const RECORD = {
  number: 1234567893, // the registry may send it as a number; it's read as a string
  enumeration_type: 'NPI-1',
  basic: { first_name: 'JANE', last_name: 'SMITH', status: 'A' },
  addresses: [{ address_purpose: 'LOCATION', city: 'AUSTIN', state: 'TX', postal_code: '787011234' }],
  taxonomies: [{ desc: 'Family Medicine', primary: true, state: 'TX' }],
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** fetch that answers each call from the list in turn. */
function fakeFetch(...answers: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  });
  return fn as unknown as typeof fetch & typeof fn;
}

const noSleep = vi.fn(async () => undefined);
const deps = (fetchImpl: typeof fetch) => ({ fetchImpl, cache: null, sleep: noSleep });

describe('lookupNpi', () => {
  it('returns the validated record, with the NPI as a string', async () => {
    const out = await lookupNpi('1234567893', deps(fakeFetch(json({ result_count: 1, results: [RECORD] }))));
    expect(out.found).toBe(true);
    expect(out.result?.number).toBe('1234567893');
    expect(out.result?.basic).toMatchObject({ last_name: 'SMITH' }); // fields not in the schema are kept
  });

  it('reports not found on an empty result', async () => {
    expect(await lookupNpi('1234567893', deps(fakeFetch(json({ result_count: 0, results: [] }))))).toEqual({
      found: false,
      result: null,
    });
  });

  it('retries 503, 429 and network errors, honouring Retry-After', async () => {
    noSleep.mockClear();
    const f = fakeFetch(json({}, 503), json({}, 429, { 'retry-after': '2' }), json({ results: [RECORD] }));
    expect((await lookupNpi('1234567893', deps(f))).found).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenLastCalledWith(2000);

    const g = fakeFetch(new TypeError('fetch failed'), json({ results: [] }));
    expect((await lookupNpi('1234567893', deps(g))).found).toBe(false);
    expect(g).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts, and does not retry a 400', async () => {
    const f = fakeFetch(json({}, 502), json({}, 502), json({}, 502));
    await expect(lookupNpi('1234567893', deps(f))).rejects.toThrow('NPI registry HTTP 502');
    expect(f).toHaveBeenCalledTimes(3);

    const g = fakeFetch(json({}, 400));
    await expect(lookupNpi('1234567893', deps(g))).rejects.toThrow('NPI registry HTTP 400');
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('rejects a response that does not match the schema, and surfaces registry errors', async () => {
    await expect(lookupNpi('1234567893', deps(fakeFetch(json({ results: [{ number: 'abc' }] }))))).rejects.toThrow(
      'unexpected response',
    );
    await expect(
      lookupNpi('1234567893', deps(fakeFetch(json({ Errors: [{ description: 'Invalid NPI' }] })))),
    ).rejects.toThrow('NPI registry: Invalid NPI');
  });

  it('answers from the cache when it has the NPI, and fills it otherwise', async () => {
    const store = new Map<string, NpiLookup>();
    const cache: NpiCache = { get: async (n) => store.get(n) ?? null, set: async (n, l) => void store.set(n, l) };
    const f = fakeFetch(json({ results: [RECORD] }));
    await lookupNpi('1234567893', { fetchImpl: f, cache, sleep: noSleep });
    const again = await lookupNpi('1234567893', { fetchImpl: f, cache, sleep: noSleep });
    expect(again.found).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('searchNpi', () => {
  it('retries a transient failure within a search tier', async () => {
    const f = fakeFetch(json({}, 503), json({ results: [RECORD] }));
    const out = await searchNpi({ name: 'Jane Smith, MD', zip: '78701' }, { fetchImpl: f, sleep: noSleep });
    expect(out.match?.number).toBe('1234567893');
    expect(out.widened).toBeNull();
  });
});

describe('retry timing', () => {
  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs('soon')).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });

  it('backs off exponentially with jitter, capped', () => {
    for (let i = 0; i < 20; i++) {
      const d = backoffMs(2, 500, 10_000);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(2000);
    }
    expect(backoffMs(10, 500, 10_000)).toBeLessThanOrEqual(10_000);
  });
});
