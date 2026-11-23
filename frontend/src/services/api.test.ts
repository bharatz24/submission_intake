import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, buildQuery, errorMessage, parseApiError } from './api';

describe('parseApiError', () => {
  it('parses the contract error shape', () => {
    const err = parseApiError(422, {
      error: { code: 'VALIDATION', message: 'notes is required', details: { field: 'notes' } },
    });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('notes is required');
    expect(err.details).toEqual({ field: 'notes' });
  });

  it('falls back for non-contract bodies', () => {
    expect(parseApiError(502, '<html>Bad gateway</html>', 'Bad Gateway').message).toMatch(
      /server had a problem \(502 Bad Gateway\)\. Wait a few minutes/,
    );
    expect(parseApiError(404, null).code).toBe('HTTP_404');
    expect(parseApiError(400, 'plain text problem').message).toBe('plain text problem');
    expect(parseApiError(0, null).message).toMatch(/could not be reached.*retry/);
  });
});

describe('errorMessage', () => {
  it('says what happened and what to do, never raw upstream or browser text', () => {
    expect(errorMessage(new ApiError(502, 'X', '529 {"type":"error","error":{"type":"overloaded_error"}}'))).toMatch(
      /^Claude is overloaded/,
    );
    expect(errorMessage(new ApiError(400, 'X', 'Pick a limit [aggregate]'))).toBe('Pick a limit [aggregate]');
    expect(errorMessage(new TypeError('Failed to fetch'))).toMatch(/could not be reached/);
    expect(errorMessage(new TypeError("Cannot read properties of undefined (reading 'x')"))).toMatch(
      /^Something went wrong\. Retry/,
    );
    expect(errorMessage(new Error('The browser blocked the Google sign-in window.'))).toBe(
      'The browser blocked the Google sign-in window.',
    );
    expect(errorMessage('boom')).toMatch(/^Something went wrong/);
  });

  it('fills a default message when the error object lacks one', () => {
    const err = parseApiError(401, { error: { code: 'UNAUTHORIZED' } });
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toMatch(/session has expired/);
  });
});

describe('buildQuery', () => {
  it('drops empty values and encodes the rest', () => {
    expect(buildQuery({ status: 'NEW', classification: '', q: 'dr smith', page: 1, x: undefined, y: null })).toBe(
      '?status=NEW&q=dr+smith&page=1',
    );
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ view: 'duplicates', strength: 'POSSIBLE', status: '', page: 2 })).toBe(
      '?view=duplicates&strength=POSSIBLE&page=2',
    );
  });
});

describe('path segments', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('encodes ids so a crafted value stays inside its segment', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    // Only the URL matters here; the empty body fails the response check (FE-04) after the request went out.
    await api.getSubmission('../users/x?y=1').catch(() => undefined);
    await api.updateField('a/b', 'c#d', { value: 'v' });
    const urls = (fetchMock.mock.calls as unknown as [string][]).map((c) => c[0]);
    expect(urls[0]).toMatch(/\/submissions\/\.\.%2Fusers%2Fx%3Fy%3D1$/);
    expect(urls[1]).toMatch(/\/submissions\/a%2Fb\/fields\/c%23d$/);
  });
});

describe('request timeout', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives up on a read that never answers, with a message saying so', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('signal timed out', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);
    const err = await api.getSubmission('abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(errorMessage(err)).toMatch(/took too long to answer.*retry/);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
  });
});
