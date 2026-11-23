import { EventEmitter } from 'node:events';

import { NOTIFICATION_REPLAY_LIMIT, NOTIFY_MAX_PAYLOAD_BYTES } from '../constants.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { listen, notify } from './pgListen.js';
export { NOTIFICATION_REPLAY_LIMIT } from '../constants.js';

/**
 * New-email events for the notification bell (GET /api/events/stream). Published with Postgres NOTIFY, so a
 * client on any API instance hears an email ingested by another; each instance fans out to its own streams.
 * Only Gmail ingestion publishes; manual uploads never notify.
 */
export interface NewEmailEvent {
  submissionId: string;
  subject: string;
  fromAddress: string;
  receivedAt: string;
  /** Ingest time (ISO, millisecond precision): the SSE event id and the replay cursor. */
  ingestedAt: string;
  status: string;
}

const bus = new EventEmitter();
// One listener per open stream; the default limit of 10 would warn under normal use.
bus.setMaxListeners(0);

const CHANNEL = 'new_email';

export async function publishNewEmail(event: NewEmailEvent): Promise<void> {
  const json = JSON.stringify(event);
  try {
    await notify(
      CHANNEL,
      Buffer.byteLength(json) <= NOTIFY_MAX_PAYLOAD_BYTES ? json : JSON.stringify({ submissionId: event.submissionId }),
    );
  } catch (err) {
    // Clients on other instances catch up from their replay cursor on the next reconnect.
    logger.warn({ err }, 'new-email NOTIFY failed; notifying this instance only');
    bus.emit('new-email', event);
  }
}

let listening: Promise<unknown> | null = null;

/** Resolves once this instance hears new-email notifications, so a stream can say it is subscribed. */
export function ensureNewEmailListener(): Promise<unknown> {
  listening ??= listen(CHANNEL, (payload) => {
    let event: Partial<NewEmailEvent>;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.ingestedAt) bus.emit('new-email', event as NewEmailEvent);
    else if (event.submissionId) {
      void newEmailEvent(event.submissionId)
        .then((e) => e && bus.emit('new-email', e))
        .catch((err) => logger.warn({ err }, 'new-email event read failed'));
    }
  }).catch((err) => {
    listening = null;
    throw err;
  });
  return listening;
}

export function subscribeNewEmail(listener: (event: NewEmailEvent) => void): () => void {
  bus.on('new-email', listener);
  return () => {
    bus.off('new-email', listener);
  };
}

// Gmail ingestion runs without a user (actor SYSTEM); uploads, including Gmail-connector intake, have one.
const GMAIL_INGESTED = `EXISTS (SELECT 1 FROM audit_events a WHERE a.submission_id=s.id AND a.action='EMAIL_RECEIVED' AND a.actor_type='SYSTEM')`;
// Truncated to milliseconds so the cursor a client sends back (a JS ISO string) compares exactly.
const INGESTED_AT = `date_trunc('milliseconds', s.created_at)`;

/** Gmail emails ingested after `since`, oldest first, at most NOTIFICATION_REPLAY_LIMIT (the most recent ones). */
export async function newEmailsSince(since: Date): Promise<NewEmailEvent[]> {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT s.id, s.status, e.subject, e.from_address, e.received_at, ${INGESTED_AT} AS ingested_at
       FROM submissions s JOIN emails e ON e.id=s.email_id
       WHERE ${INGESTED_AT} > $1 AND e.gmail_message_id IS NOT NULL AND ${GMAIL_INGESTED}
       ORDER BY s.created_at DESC LIMIT $2) recent
     ORDER BY ingested_at`,
    [since, NOTIFICATION_REPLAY_LIMIT],
  );
  return rows.map(toEvent);
}

/** The event for one submission, read after its ingest committed. */
export async function newEmailEvent(submissionId: string): Promise<NewEmailEvent | null> {
  const {
    rows: [r],
  } = await pool.query(
    `SELECT s.id, s.status, e.subject, e.from_address, e.received_at, ${INGESTED_AT} AS ingested_at
     FROM submissions s JOIN emails e ON e.id=s.email_id WHERE s.id=$1`,
    [submissionId],
  );
  return r ? toEvent(r) : null;
}

function toEvent(r: any): NewEmailEvent {
  return {
    submissionId: r.id,
    subject: r.subject,
    fromAddress: r.from_address,
    receivedAt: new Date(r.received_at).toISOString(),
    ingestedAt: new Date(r.ingested_at).toISOString(),
    status: r.status,
  };
}
