import type { Queryable } from '../../db/pool.js';
import type { IntakeStatus } from '../../services/ims2IntakeQueue.js';

/** SQL for the IMS 2 intake hand-off (ims2_intake_queue), the removed direct hand-off's rows, and the sync cursor. */

export type QueueState = 'SENDING' | 'QUEUED' | 'LINKED' | 'REJECTED' | 'ERROR' | 'FAILED';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a SELECT q.* row, mapped field by field in the service
export type QueueRow = Record<string, any>;

const ROW_SELECT = `SELECT q.*, u.name AS sent_by_name FROM ims2_intake_queue q JOIN users u ON u.id = q.sent_by`;

export async function loadRow(db: Queryable, submissionId: string): Promise<QueueRow | null> {
  const {
    rows: [r],
  } = await db.query(`${ROW_SELECT} WHERE q.submission_id=$1`, [submissionId]);
  return r ?? null;
}

export async function lockRow(db: Queryable, submissionId: string): Promise<QueueRow | null> {
  const {
    rows: [r],
  } = await db.query('SELECT * FROM ims2_intake_queue WHERE submission_id=$1 FOR UPDATE', [submissionId]);
  return r ?? null;
}

export async function latestDecision(db: Queryable, submissionId: string): Promise<string | null> {
  const {
    rows: [a],
  } = await db.query<{ decision: string }>(
    'SELECT decision FROM assessments WHERE submission_id=$1 ORDER BY version DESC LIMIT 1',
    [submissionId],
  );
  return a?.decision ?? null;
}

/** What the removed direct hand-off left in ims2_handoffs (kept for its history). */
export async function legacyHandoff(db: Queryable, submissionId: string) {
  const {
    rows: [h],
  } = await db.query<{ state: string; ims_url: string | null; ims_submission_number: string | null }>(
    'SELECT state, ims_url, ims_submission_number FROM ims2_handoffs WHERE submission_id=$1',
    [submissionId],
  );
  return h ?? null;
}

/** Claims a send: the row becomes SENDING with this version and payload. */
export async function claimSend(
  db: Queryable,
  row: {
    submissionId: string;
    intakeId: string;
    version: number;
    payload: unknown;
    payloadHash: string;
    form: unknown;
    sentBy: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO ims2_intake_queue (submission_id, intake_id, version, state, payload, payload_hash, form, sent_by, sent_at)
     VALUES ($1, $2, $3, 'SENDING', $4, $5, $6, $7, now())
     ON CONFLICT (submission_id) DO UPDATE SET version=EXCLUDED.version, state='SENDING', payload=EXCLUDED.payload,
       payload_hash=EXCLUDED.payload_hash, form=EXCLUDED.form, sent_by=EXCLUDED.sent_by, sent_at=now(), updated_at=now()`,
    [
      row.submissionId,
      row.intakeId,
      row.version,
      JSON.stringify(row.payload),
      row.payloadHash,
      JSON.stringify(row.form),
      row.sentBy,
    ],
  );
}

export async function markQueued(db: Queryable, submissionId: string, httpStatus: number): Promise<void> {
  await db.query(
    `UPDATE ims2_intake_queue SET state='QUEUED', last_http_status=$2, last_error=NULL, last_error_field=NULL, rejected_reason=NULL,
       updated_at=now() WHERE submission_id=$1`,
    [submissionId, httpStatus],
  );
}

export async function markError(
  db: Queryable,
  submissionId: string,
  e: { state: 'ERROR' | 'FAILED'; httpStatus: number | null; message: string; field: string | null },
) {
  await db.query(
    `UPDATE ims2_intake_queue SET state=$2, last_http_status=$3, last_error=$4, last_error_field=$5, updated_at=now() WHERE submission_id=$1`,
    [submissionId, e.state, e.httpStatus, e.message, e.field],
  );
}

export async function setHttpStatus(db: Queryable, submissionId: string, httpStatus: number): Promise<void> {
  await db.query('UPDATE ims2_intake_queue SET last_http_status=$2 WHERE submission_id=$1', [submissionId, httpStatus]);
}

export async function bumpVersion(
  db: Queryable,
  submissionId: string,
  version: number,
  payload: unknown,
): Promise<void> {
  await db.query('UPDATE ims2_intake_queue SET version=$2, payload=$3, updated_at=now() WHERE submission_id=$1', [
    submissionId,
    version,
    JSON.stringify(payload),
  ]);
}

/** IMS 2 never received the intake: the local state stays, with what the check found. */
export async function noteNotFound(db: Queryable, submissionId: string, error: string): Promise<void> {
  await db.query(
    'UPDATE ims2_intake_queue SET remote_status=$2, remote_checked_at=now(), updated_at=now() WHERE submission_id=$1',
    [submissionId, JSON.stringify({ notFound: true, error })],
  );
}

/**
 * Applies an IntakeStatus to the local row, idempotently: an older status than the one kept is skipped, a LINKED row
 * never moves back, a row mid-send is left to that send (unless `fromSend`), and a remote `new` does not hide the
 * error of our own latest attempt. The changed row's submission and old and new state; null when nothing changed.
 */
export async function applyStatusRow(db: Queryable, s: IntakeStatus, next: QueueState, fromSend: boolean) {
  const {
    rows: [r],
  } = await db.query<{ submission_id: string; old_state: QueueState; new_state: QueueState }>(
    `WITH prev AS (SELECT submission_id, state FROM ims2_intake_queue WHERE intake_id=$1 FOR UPDATE)
     UPDATE ims2_intake_queue q SET
       state=$2::text, version=GREATEST(q.version, $3::int),
       ims_submission_id=COALESCE($4::int, q.ims_submission_id), ims_submission_number=COALESCE($5::text, q.ims_submission_number),
       ims_insured_id=COALESCE($6::text, q.ims_insured_id), ims_url=COALESCE($7::text, q.ims_url),
       rejected_reason=CASE WHEN $2::text='REJECTED' THEN $8::text ELSE NULL END,
       last_error=CASE WHEN $2::text IN ('LINKED','REJECTED') OR prev.state='SENDING' THEN NULL ELSE q.last_error END,
       last_error_field=CASE WHEN $2::text IN ('LINKED','REJECTED') OR prev.state='SENDING' THEN NULL ELSE q.last_error_field END,
       remote_status=$9::jsonb, remote_status_changed_at=$10::timestamptz, remote_checked_at=now(), updated_at=now()
     FROM prev
     WHERE q.submission_id = prev.submission_id
       AND (prev.state <> 'SENDING' OR $11::boolean)
       AND (q.remote_status_changed_at IS NULL OR q.remote_status_changed_at <= $10::timestamptz)
       AND NOT (prev.state = 'LINKED' AND $2::text <> 'LINKED')
       AND NOT (prev.state IN ('ERROR','FAILED') AND $2::text = 'QUEUED' AND NOT $11::boolean)
     RETURNING q.submission_id, prev.state AS old_state, q.state AS new_state`,
    [
      s.intakeId,
      next,
      s.version,
      s.submissionId,
      s.submissionNumber,
      s.insuredId,
      s.url,
      s.rejectedReason,
      JSON.stringify(s),
      s.statusChangedAt,
      fromSend,
    ],
  );
  return r ?? null;
}

/** Intakes whose live state can still change in IMS 2 (workflow status, policy number). */
export async function openIntakeIds(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ intake_id: string }>(
    `SELECT intake_id FROM ims2_intake_queue WHERE state IN ('QUEUED','LINKED') ORDER BY intake_id`,
  );
  return rows.map((r) => r.intake_id);
}

export async function stateCounts(db: Queryable): Promise<Record<string, number>> {
  const { rows } = await db.query<{ state: string; n: number }>(
    `SELECT state, count(*)::int AS n FROM ims2_intake_queue GROUP BY state`,
  );
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

export async function readSetting<T>(db: Queryable, key: string): Promise<T | null> {
  const {
    rows: [r],
  } = await db.query<{ value: T }>('SELECT value FROM app_settings WHERE key=$1', [key]);
  return r?.value ?? null;
}

export async function writeSetting(db: Queryable, key: string, value: unknown, actorId: string | null): Promise<void> {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [key, JSON.stringify(value), actorId],
  );
}
