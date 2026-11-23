// New-email events from GET /api/events/stream, shared across tabs.
// One tab (the leader, picked with the Web Locks API) holds the connection and relays events to the others over a
// BroadcastChannel: the app stays under the browser's per-origin connection limit and desktop notifications are
// shown once. When the leader closes, its lock is released and another tab takes over from the stored cursor.
// With VITE_EVENTS_TRANSPORT=poll (hosts without long-lived streams) the leader instead asks GET /api/events/since
// every EVENTS_POLL_INTERVAL_MS, with the same cursor; everything else is unchanged.
import { env, type EventsTransport } from '../config/env';
import { CURSOR_REFRESH_MS, EVENTS_POLL_INTERVAL_MS, SILENCE_TIMEOUT_MS, SSE_WATCHDOG_MS } from '../constants';
import { API_BASE, CSRF_HEADERS } from '../services/api';
import { logger } from './logger';
import {
  type ConnectionStatus,
  cursorKey,
  type NewEmailEvent,
  readJson,
  reconnectDelay,
  type StoredCursor,
  usableCursor,
  withJitter,
  writeJson,
} from './notifications';
import { createSseParser, type SseMessage } from './sse';

export interface EmailEventsOptions {
  userId: string;
  /** `leader` is true in the tab that received the event from the server (the one that may notify the desktop). */
  onEvent: (event: NewEmailEvent, ctx: { leader: boolean }) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Default: the build's VITE_EVENTS_TRANSPORT. */
  transport?: EventsTransport;
}

type ChannelMessage =
  | { type: 'event'; event: NewEmailEvent }
  | { type: 'status'; status: ConnectionStatus }
  | { type: 'status-request' };

/** Starts listening; returns a function that stops (disconnects, gives up leadership, closes the channel). */
export function startEmailEvents(opts: EmailEventsOptions): () => void {
  const stop = new AbortController();
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`email-events:${opts.userId}`) : null;
  let leader = false;
  let status: ConnectionStatus = 'connecting';

  const setStatus = (s: ConnectionStatus) => {
    status = s;
    opts.onStatus(s);
    if (leader) channel?.postMessage({ type: 'status', status: s } satisfies ChannelMessage);
  };

  if (channel) {
    channel.onmessage = (m: MessageEvent<ChannelMessage>) => {
      const msg = m.data;
      if (msg.type === 'event' && !leader) opts.onEvent(msg.event, { leader: false });
      else if (msg.type === 'status' && !leader) {
        status = msg.status;
        opts.onStatus(msg.status);
      } else if (msg.type === 'status-request' && leader)
        channel.postMessage({ type: 'status', status } satisfies ChannelMessage);
    };
    channel.postMessage({ type: 'status-request' } satisfies ChannelMessage);
  }
  opts.onStatus('connecting');

  const lead = () => {
    leader = true;
    const relay = (event: NewEmailEvent) => channel?.postMessage({ type: 'event', event } satisfies ChannelMessage);
    const transport = opts.transport ?? env.eventsTransport;
    return (transport === 'poll' ? poll : connect)(opts, stop.signal, setStatus, relay);
  };

  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks && channel) {
    // Held until this tab stops or closes; waiting tabs are followers until then.
    locks.request(`email-events-leader:${opts.userId}`, { signal: stop.signal }, lead).catch(() => {
      /* aborted on stop */
    });
  } else {
    // No Web Locks or BroadcastChannel: every tab keeps its own connection.
    void lead();
  }

  return () => {
    stop.abort();
    channel?.close();
  };
}

/** The leader's connection loop: connect, read events, reconnect with backoff. Resolves when stopped. */
async function connect(
  opts: EmailEventsOptions,
  signal: AbortSignal,
  setStatus: (s: ConnectionStatus) => void,
  relay: (e: NewEmailEvent) => void,
): Promise<void> {
  const key = cursorKey(opts.userId);
  let cursor = usableCursor(readJson<StoredCursor | null>(key, null));
  let savedAt = 0;
  const saveCursor = (id: string) => {
    cursor = id;
    savedAt = Date.now();
    writeJson(key, { id, savedAt } satisfies StoredCursor);
  };
  let attempt = 0;
  let connectedOnce = false;

  while (!signal.aborted) {
    setStatus(connectedOnce || attempt > 0 ? 'reconnecting' : 'connecting');
    // Aborted on stop, or by the watchdog when the stream goes silent: a dead server behind a proxy (or a laptop
    // waking from sleep) can leave the connection half-open with no close ever arriving.
    const attemptCtrl = new AbortController();
    const onStop = () => attemptCtrl.abort();
    signal.addEventListener('abort', onStop, { once: true });
    let lastData = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > SILENCE_TIMEOUT_MS) attemptCtrl.abort();
    }, SSE_WATCHDOG_MS);
    try {
      const res = await fetch(`${API_BASE}/events/stream${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`, {
        // The httpOnly session cookie authenticates the stream.
        headers: { ...CSRF_HEADERS, Accept: 'text/event-stream' },
        credentials: 'include',
        cache: 'no-store',
        signal: attemptCtrl.signal,
      });
      // Signed out or token expired: the API client handles the session; reconnecting would only fail again.
      if (res.status === 401) {
        setStatus('offline');
        return;
      }
      // Forbidden is not transient: stop instead of retrying forever, and say so.
      if (res.status === 403) {
        logger.warn('Email event stream refused (HTTP 403); live notifications are off for this session', {
          source: 'event-stream',
        });
        setStatus('offline');
        return;
      }
      if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);

      const feed = createSseParser((m) => {
        const msg = interpretStreamMessage(m);
        if (msg.kind === 'ready') {
          connectedOnce = true;
          attempt = 0;
          // Without a cursor yet, start from the server's clock so mail during a later reconnect is replayed.
          if (!cursor && msg.now) saveCursor(msg.now);
          setStatus('live');
        } else if (msg.kind === 'event') {
          if (msg.id) saveCursor(msg.id);
          opts.onEvent(msg.event, { leader: true });
          relay(msg.event);
        } else if (msg.kind === 'malformed') {
          // Skip it, but move past it: otherwise every reconnect would replay the same bad event forever.
          if (msg.id) saveCursor(msg.id);
          logger.warn('Skipped a malformed email event from the server', { source: 'event-stream' });
        }
      });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        lastData = Date.now();
        feed(value);
        if (cursor && Date.now() - savedAt > CURSOR_REFRESH_MS) saveCursor(cursor);
      }
      throw new Error('event stream closed');
    } catch {
      if (signal.aborted) return;
      setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting');
      await sleep(withJitter(reconnectDelay(attempt++)), signal);
    } finally {
      clearInterval(watchdog);
      signal.removeEventListener('abort', onStop);
      attemptCtrl.abort();
    }
  }
}

/** The leader's poll loop (poll transport): ask for events after the cursor, then wait. Resolves when stopped. */
async function poll(
  opts: EmailEventsOptions,
  signal: AbortSignal,
  setStatus: (s: ConnectionStatus) => void,
  relay: (e: NewEmailEvent) => void,
): Promise<void> {
  const key = cursorKey(opts.userId);
  let cursor = usableCursor(readJson<StoredCursor | null>(key, null));
  let attempt = 0;
  setStatus('connecting');
  while (!signal.aborted) {
    try {
      const res = await fetch(`${API_BASE}/events/since${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`, {
        headers: { ...CSRF_HEADERS, Accept: 'application/json' },
        credentials: 'include',
        cache: 'no-store',
        signal,
      });
      if (res.status === 401) {
        setStatus('offline');
        return;
      }
      if (res.status === 403) {
        logger.warn('Email events refused (HTTP 403); live notifications are off for this session', {
          source: 'event-stream',
        });
        setStatus('offline');
        return;
      }
      if (!res.ok) throw new Error(`events HTTP ${res.status}`);
      const body = (await res.json()) as { events?: unknown; cursor?: unknown };
      for (const event of Array.isArray(body.events) ? body.events : []) {
        const e = event as NewEmailEvent | null;
        if (!e || typeof e !== 'object' || typeof e.submissionId !== 'string') {
          logger.warn('Skipped a malformed email event from the server', { source: 'event-stream' });
          continue;
        }
        opts.onEvent(e, { leader: true });
        relay(e);
      }
      if (typeof body.cursor === 'string' && body.cursor) {
        cursor = body.cursor;
        writeJson(key, { id: cursor, savedAt: Date.now() } satisfies StoredCursor);
      }
      attempt = 0;
      setStatus('live');
      await sleep(EVENTS_POLL_INTERVAL_MS, signal);
    } catch {
      if (signal.aborted) return;
      setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting');
      await sleep(withJitter(reconnectDelay(attempt++)), signal);
    }
  }
}

export type StreamMessage =
  | { kind: 'ready'; now: string | null }
  | { kind: 'event'; event: NewEmailEvent; id: string | null }
  | { kind: 'malformed'; id: string | null }
  | { kind: 'ignored' };

/** Interprets one SSE message; never throws, so one bad event cannot break the stream (or stall its cursor). */
export function interpretStreamMessage(m: SseMessage): StreamMessage {
  if (m.event === 'ready') {
    try {
      const now = (JSON.parse(m.data || '{}') as { now?: unknown }).now;
      return { kind: 'ready', now: typeof now === 'string' && now ? now : null };
    } catch {
      return { kind: 'ready', now: null };
    }
  }
  if (m.event !== 'new-email') return { kind: 'ignored' };
  try {
    const event = JSON.parse(m.data) as NewEmailEvent | null;
    if (!event || typeof event !== 'object' || typeof event.submissionId !== 'string')
      return { kind: 'malformed', id: m.id };
    return { kind: 'event', event, id: m.id };
  } catch {
    return { kind: 'malformed', id: m.id };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
