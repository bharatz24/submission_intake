import { describe, expect, it } from 'vitest';

import { createSseParser, type SseMessage } from './sse';

const collect = () => {
  const out: SseMessage[] = [];
  return { out, feed: createSseParser((m) => out.push(m)) };
};

describe('SSE parser', () => {
  it('parses named events with ids, multi-line data and retry', () => {
    const { out, feed } = collect();
    feed(
      'retry: 5000\nevent: ready\ndata: {}\n\nid: 2026-10-30T10:00:00.000Z\nevent: new-email\ndata: {"a":1,\ndata: "b":2}\n\n',
    );
    expect(out).toEqual([
      { id: null, event: 'ready', data: '{}', retry: 5000 },
      { id: '2026-10-30T10:00:00.000Z', event: 'new-email', data: '{"a":1,\n"b":2}', retry: null },
    ]);
  });

  it('reassembles events split across chunks, including CRLF line ends', () => {
    const { out, feed } = collect();
    feed('id: 1\r\nevent: new-');
    feed('email\r\nda');
    expect(out).toEqual([]);
    feed('ta: hello\r\n\r\n');
    expect(out).toEqual([{ id: '1', event: 'new-email', data: 'hello', retry: null }]);
  });

  it('ignores comments and data-less events, and keeps the last id', () => {
    const { out, feed } = collect();
    feed(': ping\n\nid: 7\n\ndata: x\n\n');
    expect(out).toEqual([{ id: '7', event: 'message', data: 'x', retry: null }]);
  });

  it('treats a CRLF split across chunks as one line end, not an extra blank line', () => {
    const { out, feed } = collect();
    feed('event: new-email\r');
    feed('\ndata: a\r');
    feed('\ndata: b\r');
    expect(out).toEqual([]);
    feed('\n\r');
    expect(out).toEqual([{ id: null, event: 'new-email', data: 'a\nb', retry: null }]);
  });
});
