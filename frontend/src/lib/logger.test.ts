import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../test/msw/api';
import { logger, resetLoggerForTests } from './logger';

describe('logger', () => {
  beforeEach(() => {
    resetLoggerForTests();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports errors to the server with their source, stack and request id', async () => {
    const api = mockApi({ 'POST /client-errors': () => undefined });
    logger.error('Unhandled UI error', new Error('boom'), { source: 'error-boundary', requestId: 'r-1' });
    await vi.waitFor(() => expect(api['POST /client-errors']).toHaveBeenCalledTimes(1));
    const body = api['POST /client-errors'].mock.calls[0]![0].body as Record<string, unknown>;
    expect(body).toMatchObject({
      level: 'error',
      message: 'Unhandled UI error: boom',
      source: 'error-boundary',
      requestId: 'r-1',
    });
    expect(body.stack).toContain('boom');
  });

  it('reports the same message at most once a minute', async () => {
    const api = mockApi({ 'POST /client-errors': () => undefined });
    logger.warn('stream dropped', { source: 'event-stream' });
    logger.warn('stream dropped', { source: 'event-stream' });
    await vi.waitFor(() => expect(api['POST /client-errors']).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(api['POST /client-errors']).toHaveBeenCalledTimes(1);
  });

  it('reports the page path only, never its query or hash (FE-11)', async () => {
    vi.stubGlobal('window', {
      location: { href: 'https://app.test/?q=Jane%20Doe&tab=npi#x', pathname: '/', search: '?q=Jane%20Doe' },
    });
    try {
      const api = mockApi({ 'POST /client-errors': () => undefined });
      logger.error('search failed');
      await vi.waitFor(() => expect(api['POST /client-errors']).toHaveBeenCalledTimes(1));
      const body = api['POST /client-errors'].mock.calls[0]![0].body as Record<string, unknown>;
      expect(body.url).toBe('/');
      expect(JSON.stringify(body)).not.toContain('Jane');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never throws when the report cannot be sent', () => {
    mockApi({ 'POST /client-errors': () => new Response(null, { status: 500 }) });
    expect(() => logger.error('x')).not.toThrow();
  });
});
