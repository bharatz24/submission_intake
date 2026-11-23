// Server-Sent Events parser for a streamed fetch response (EventSource cannot send the bearer token).
// Follows the WHATWG event-stream rules: fields per line, a blank line dispatches, ":" lines are comments.

export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
  retry: number | null;
}

const CR = '\r';
const LF = '\n';

/** Returns a `feed(chunk)` that accepts arbitrary text chunks and calls `onMessage` per complete event. */
export function createSseParser(onMessage: (m: SseMessage) => void): (chunk: string) => void {
  let buffer = '';
  let id: string | null = null;
  let event = '';
  let data: string[] = [];
  let retry: number | null = null;
  // A chunk ending in CR may be the first half of a CRLF; an LF opening the next chunk then belongs to it
  // (otherwise it would read as an extra blank line and dispatch a half-built event).
  let pendingCR = false;

  const dispatch = () => {
    if (data.length) onMessage({ id, event: event || 'message', data: data.join('\n'), retry });
    event = '';
    data = [];
    retry = null;
  };

  return (chunk: string) => {
    if (pendingCR && chunk.startsWith(LF)) chunk = chunk.slice(1);
    if (chunk === '') return;
    pendingCR = chunk.endsWith(CR);
    buffer += chunk;
    const lines = buffer.split(/\r\n|\r|\n/);
    // The last piece may be an incomplete line; keep it for the next chunk.
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        dispatch();
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id' && !value.includes('\0'))
        id = value; // the id persists across events, per spec
      else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
    }
  };
}
