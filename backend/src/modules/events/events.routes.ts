import type { Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { config, isNetlifyRuntime } from '../../config.js';
import { SSE_HEARTBEAT_MS, SSE_RETRY_MS, SSE_REVALIDATE_MS } from '../../constants.js';
import { pool } from '../../db/pool.js';
import { AppError, currentUser, parseBody, stillAuthorized } from '../../http.js';
import { logger } from '../../logger.js';
import {
  ensureNewEmailListener,
  type NewEmailEvent,
  newEmailsSince,
  subscribeNewEmail,
} from '../../services/notifications.js';

export const eventsRouter = Router();

// setTimeout fires at once beyond 2^31-1 ms; a longer-lived token is re-checked at that point instead.
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Open streams, by user: capped per user and in total, and ended on shutdown so server.close() is not held open. */
const open = new Map<string, Set<Response>>();
let openTotal = 0;

/**
 * Backpressure (PERF-08): a client that stops reading makes every write buffer in this process. A stream whose
 * unsent output passes SSE_MAX_BUFFERED_BYTES, or whose writes are refused (res.write false) SSE_MAX_STALLED_WRITES
 * times in a row without draining, is ended; the client reconnects with its cursor and loses nothing.
 */
export const SSE_MAX_BUFFERED_BYTES = 256 * 1024;
export const SSE_MAX_STALLED_WRITES = 5;

/** Open streams on this instance (tests, diagnostics). */
export const openStreamCount = () => openTotal;

/** End every open stream (graceful shutdown). Clients reconnect, to another instance, with their cursor. */
export function closeAllStreams(): void {
  for (const set of open.values()) for (const res of set) res.end();
}

/**
 * Server-Sent Events for the notification bell. Needs a bearer token, so browsers read it with a streamed
 * fetch rather than EventSource. `?since=<last event id>` replays Gmail emails ingested after that time.
 * The stream ends when the token expires, or when a periodic re-check finds the account disabled, its sessions revoked
 * or its role changed: the client reconnects with a fresh token, or is signed out.
 */
eventsRouter.get('/events/stream', async (req, res) => {
  // A function answers once and is frozen: a held stream would only time out. The SPA polls /events/since there.
  if (isNetlifyRuntime())
    throw new AppError('SSE_UNAVAILABLE', 503, 'Live streams are off on this deployment; use GET /api/events/since');
  const { since } = parseBody(z.object({ since: z.iso.datetime().optional() }), req.query);
  const userId = currentUser(req).id;
  // A process-wide cap too: each stream holds a socket, timers and a subscription however many users there are.
  if (openTotal >= config.SSE_MAX_TOTAL) {
    res.setHeader('Retry-After', String(Math.ceil(SSE_RETRY_MS / 1000)));
    throw new AppError('STREAMS_FULL', 503, 'Too many notification streams are open on this server; retrying shortly');
  }
  const mine = open.get(userId) ?? new Set<Response>();
  if (mine.size >= config.SSE_MAX_PER_USER) {
    throw new AppError(
      'TOO_MANY_STREAMS',
      429,
      `At most ${config.SSE_MAX_PER_USER} notification streams per user; close another tab`,
    );
  }
  // Counted at once (before any await), so parallel requests cannot all slip under the cap.
  mine.add(res);
  open.set(userId, mine);
  openTotal++;
  const cleanups: (() => void)[] = [
    () => {
      openTotal--;
      mine.delete(res);
      if (!mine.size && open.get(userId) === mine) open.delete(userId);
    },
  ];
  // res, not req: since Node 16 req 'close' can fire once the (empty) request body is read.
  res.on('close', () => {
    for (const fn of cleanups) fn();
  });
  // Before the stream says it is subscribed: an email ingested on another instance arrives by NOTIFY.
  await ensureNewEmailListener();
  if (res.destroyed) return;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Stops nginx-style proxies from buffering the stream.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let stalled = 0;
  res.on('drain', () => {
    stalled = 0;
  });
  /** Writes unless the client has stopped reading (see SSE_MAX_BUFFERED_BYTES); then the stream is ended. */
  const write = (chunk: string) => {
    if (res.writableEnded || res.destroyed) return;
    if (res.writableLength > SSE_MAX_BUFFERED_BYTES || stalled >= SSE_MAX_STALLED_WRITES) {
      logger.warn({ buffered: res.writableLength, stalled }, 'event stream client is not reading; closing it');
      res.destroy();
      return;
    }
    if (!res.write(chunk)) stalled++;
  };
  const send = (event: NewEmailEvent) => {
    write(`id: ${event.ingestedAt}\nevent: new-email\ndata: ${JSON.stringify(event)}\n\n`);
  };
  // Subscribed before the replay query, so an email ingested meanwhile is not missed (the client dedups by id).
  const unsubscribe = subscribeNewEmail(send);
  const heartbeat = setInterval(() => write(': ping\n\n'), SSE_HEARTBEAT_MS);
  // `exp` (seconds) is set by requireAuth when the token carries one.
  const exp = (req.user as { exp?: number }).exp;
  let expiry: NodeJS.Timeout | undefined;
  const scheduleExpiry = () => {
    if (!exp) return;
    const ms = exp * 1000 - Date.now();
    if (ms <= 0) {
      res.end();
      return;
    }
    expiry = setTimeout(ms > MAX_TIMER_MS ? scheduleExpiry : () => res.end(), Math.min(ms, MAX_TIMER_MS));
  };
  scheduleExpiry();
  let checking = false;
  const revalidate = setInterval(() => {
    if (checking) return;
    checking = true;
    stillAuthorized(req)
      .then(
        (ok) => {
          if (!ok) res.end();
        },
        (err) => {
          // The database is unreachable: end the stream; the client reconnects and is authenticated afresh.
          logger.warn({ err }, 'event stream re-authentication failed');
          res.end();
        },
      )
      .finally(() => {
        checking = false;
      });
  }, SSE_REVALIDATE_MS);
  cleanups.push(() => {
    clearInterval(heartbeat);
    clearInterval(revalidate);
    clearTimeout(expiry);
    unsubscribe();
  });

  // The server clock lets a client without a cursor resume from this moment after a reconnect.
  write(`retry: ${SSE_RETRY_MS}\nevent: ready\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
  if (!since) return;
  try {
    for (const event of await newEmailsSince(new Date(since))) send(event);
  } catch (err) {
    // Headers are already sent: end the stream and let the client reconnect with the same cursor.
    logger.warn({ err }, 'event replay failed');
    res.end();
  }
});

/**
 * The poll transport of the notification bell (VITE_EVENTS_TRANSPORT=poll, for hosts without long-lived streams):
 * Gmail emails ingested after `since`, oldest first, and the cursor to send next time (the last event's id, else
 * `since`). Without `since`: no events, and the database clock as the first cursor (the clock ingestion times use, so
 * a skewed function clock cannot skip an email).
 */
eventsRouter.get('/events/since', async (req, res) => {
  const { since } = parseBody(z.object({ since: z.iso.datetime().optional() }), req.query);
  if (!since) {
    const {
      rows: [r],
    } = await pool.query<{ now: Date }>('SELECT now() AS now');
    res.json({ events: [], cursor: new Date(r!.now).toISOString() });
    return;
  }
  const events = await newEmailsSince(new Date(since));
  res.json({ events, cursor: events.at(-1)?.ingestedAt ?? since });
});
