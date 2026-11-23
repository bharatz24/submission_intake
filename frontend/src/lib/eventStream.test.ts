// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { interpretStreamMessage, startEmailEvents } from './eventStream';
import type { ConnectionStatus, NewEmailEvent } from './notifications';
import type { SseMessage } from './sse';

/** fetch calls that opened the event stream (not the logger's error reports). */
const streamCalls = (f: { mock: { calls: unknown[][] } }) =>
  f.mock.calls.filter((c) => !String(c[0]).endsWith('/client-errors'));

const msg = (event: string, data: string, id: string | null = null): SseMessage => ({ id, event, data, retry: null });
const email: NewEmailEvent = {
  submissionId: 's1',
  subject: 'Quote',
  fromAddress: 'pat@brokerage.test',
  receivedAt: '2026-10-30T10:00:00.000Z',
  ingestedAt: '2026-10-30T10:00:00.000Z',
  status: 'NEW',
};

describe('interpretStreamMessage', () => {
  it('reads ready and new-email events', () => {
    expect(interpretStreamMessage(msg('ready', '{"now":"2026-10-30T10:00:00.000Z"}'))).toEqual({
      kind: 'ready',
      now: '2026-10-30T10:00:00.000Z',
    });
    expect(interpretStreamMessage(msg('new-email', JSON.stringify(email), 'c1'))).toEqual({
      kind: 'event',
      event: email,
      id: 'c1',
    });
    expect(interpretStreamMessage(msg('heartbeat', ''))).toEqual({ kind: 'ignored' });
  });

  it('never throws on malformed data and keeps the id so the cursor can advance', () => {
    expect(interpretStreamMessage(msg('new-email', '{not json', 'c2'))).toEqual({ kind: 'malformed', id: 'c2' });
    expect(interpretStreamMessage(msg('new-email', 'null', 'c3'))).toEqual({ kind: 'malformed', id: 'c3' });
    expect(interpretStreamMessage(msg('ready', '{oops'))).toEqual({ kind: 'ready', now: null });
  });
});

/** A fetch Response whose body streams the given SSE text and then stays open until aborted. */
function streamResponse(text: string, signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('startEmailEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('skips a malformed event, delivers the next one and advances the cursor past both', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(
        streamResponse(
          'event: ready\ndata: {"now":"2026-10-30T09:00:00.000Z"}\n\n' +
            'id: c1\nevent: new-email\ndata: {broken\n\n' +
            `id: c2\nevent: new-email\ndata: ${JSON.stringify(email)}\n\n`,
          init.signal!,
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const events: NewEmailEvent[] = [];
    const statuses: ConnectionStatus[] = [];
    const stop = startEmailEvents({ userId: 'u1', onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    stop();
    expect(events[0]).toEqual(email);
    expect(statuses).toContain('live');
    expect(statuses).not.toContain('reconnecting');
    // One stream connection; the skipped event is also reported to the server (logger → POST /client-errors).
    expect(streamCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('emailEventsCursor:u1')!).id).toBe('c2');
  });

  it('stops on 403 instead of retrying forever', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(() => Promise.resolve(new Response('forbidden', { status: 403 })));
    vi.stubGlobal('fetch', fetchMock);
    const statuses: ConnectionStatus[] = [];
    const stop = startEmailEvents({ userId: 'u2', onEvent: () => {}, onStatus: (s) => statuses.push(s) });
    await vi.waitFor(() => expect(statuses[statuses.length - 1]).toBe('offline'));
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(streamCalls(fetchMock)).toHaveLength(1);
    expect((fetchMock.mock.calls as unknown[][]).some((c) => String(c[0]).endsWith('/client-errors'))).toBe(true);
  });
});

describe('startEmailEvents (poll transport)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  const second: NewEmailEvent = { ...email, submissionId: 's2', ingestedAt: '2026-10-30T10:05:00.000Z' };

  it('poll mode delivers events to onEvent once per event across two polls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.stubGlobal('BroadcastChannel', undefined);
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => json({ events: [email], cursor: email.ingestedAt }))
      .mockImplementationOnce(() => json({ events: [second], cursor: second.ingestedAt }))
      .mockImplementation(() => json({ events: [], cursor: second.ingestedAt }));
    vi.stubGlobal('fetch', fetchMock);
    const events: NewEmailEvent[] = [];
    const stop = startEmailEvents({
      userId: 'p1',
      transport: 'poll',
      onEvent: (e) => events.push(e),
      onStatus: () => {},
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(15_000);
    stop();
    expect(events.map((e) => e.submissionId)).toEqual(['s1', 's2']);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toMatch(/\/events\/since$/); // no cursor yet: the server answers with its clock
    expect(urls[1]).toContain(`since=${encodeURIComponent(email.ingestedAt)}`);
    expect(urls[2]).toContain(`since=${encodeURIComponent(second.ingestedAt)}`);
    expect(JSON.parse(localStorage.getItem('emailEventsCursor:p1')!).id).toBe(second.ingestedAt);
  });

  it("poll mode reports onStatus('live')", async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json({ events: [], cursor: '2026-10-30T10:00:00.000Z' })),
    );
    const statuses: ConnectionStatus[] = [];
    const stop = startEmailEvents({
      userId: 'p2',
      transport: 'poll',
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });
    await vi.waitFor(() => expect(statuses).toContain('live'));
    stop();
    expect(statuses[0]).toBe('connecting');
  });

  it('poll mode stops on 401 instead of polling a signed-out session', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const fetchMock = vi.fn(() => Promise.resolve(new Response('', { status: 401 })));
    vi.stubGlobal('fetch', fetchMock);
    const statuses: ConnectionStatus[] = [];
    const stop = startEmailEvents({
      userId: 'p3',
      transport: 'poll',
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });
    await vi.waitFor(() => expect(statuses[statuses.length - 1]).toBe('offline'));
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sse mode unchanged: it opens the stream endpoint', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(streamResponse('event: ready\ndata: {"now":"2026-10-30T09:00:00.000Z"}\n\n', init.signal!)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const statuses: ConnectionStatus[] = [];
    const stop = startEmailEvents({
      userId: 'p4',
      transport: 'sse',
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });
    await vi.waitFor(() => expect(statuses).toContain('live'));
    stop();
    expect(String(streamCalls(fetchMock)[0]?.[0])).toMatch(/\/events\/stream$/);
  });
});
