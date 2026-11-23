import type { Queryable } from '../../db/pool.js';
import type { DuplicateBasis } from '../../services/duplicates.js';
import type { SubmissionStatus } from '../../services/statusTransitions.js';

/** SQL for a submission's review state, owner, classification and duplicate link (submissions.service.ts holds the rules). */

/** Status and owner of a live submission, row-locked until the transaction ends. */
export async function lockForUpdate(db: Queryable, id: string) {
  const {
    rows: [row],
  } = await db.query<{ status: SubmissionStatus; assigned_to: string | null }>(
    'SELECT status, assigned_to FROM submissions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
    [id],
  );
  return row ?? null;
}

export async function isActiveUser(db: Queryable, userId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL', [userId]);
  return !!rowCount;
}

export async function setStatus(db: Queryable, id: string, status: SubmissionStatus): Promise<void> {
  await db.query('UPDATE submissions SET status=$2, updated_at=now() WHERE id=$1', [id, status]);
}

export async function setAssignee(db: Queryable, id: string, userId: string | null): Promise<void> {
  await db.query('UPDATE submissions SET assigned_to=$2, updated_at=now() WHERE id=$1', [id, userId]);
}

/** What a classification override reads, row-locked. */
export async function lockClassification(db: Queryable, id: string) {
  const {
    rows: [row],
  } = await db.query<{
    status: SubmissionStatus;
    classification: string | null;
    duplicate_of: string | null;
    duplicate_basis: unknown;
    held_for_classification: boolean;
  }>(
    'SELECT status, classification, duplicate_of, duplicate_basis, held_for_classification FROM submissions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
    [id],
  );
  return row ?? null;
}

/** Releases a duplicate whose classification is overridden: ignored, or back to NEW to be processed. */
export async function releaseDuplicateForClassification(
  db: Queryable,
  id: string,
  classification: string,
): Promise<void> {
  await db.query(
    `UPDATE submissions SET status = CASE WHEN $2 = 'NOT_SUBMISSION' THEN 'NOT_SUBMISSION' ELSE 'NEW' END,
       duplicate_of=NULL, duplicate_basis=NULL, updated_at=now() WHERE id=$1`,
    [id, classification],
  );
}

export async function overrideClassification(
  db: Queryable,
  id: string,
  classification: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE submissions SET classification=$2, classification_confidence=1,
       classification_reasons = classification_reasons || $3::text, updated_at=now() WHERE id=$1`,
    [id, classification, reason],
  );
}

export async function markNotSubmission(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE submissions SET status='NOT_SUBMISSION' WHERE id=$1`, [id]);
}

export async function releaseClassificationHold(db: Queryable, id: string): Promise<void> {
  await db.query('UPDATE submissions SET held_for_classification=false WHERE id=$1', [id]);
}

/** Duplicate state of a live submission, row-locked. */
export async function lockDuplicateState(db: Queryable, id: string) {
  const {
    rows: [row],
  } = await db.query<{ status: SubmissionStatus; duplicate_of: string | null; duplicate_basis: unknown }>(
    'SELECT status, duplicate_of, duplicate_basis FROM submissions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
    [id],
  );
  return row ?? null;
}

/** "Not a duplicate": back to NEW, unlinked. */
export async function clearDuplicate(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE submissions SET status='NEW', duplicate_of=NULL, duplicate_basis=NULL, updated_at=now() WHERE id=$1`,
    [id],
  );
}

export async function receivedAt(db: Queryable, submissionId: string): Promise<Date | null> {
  const {
    rows: [row],
  } = await db.query<{ received_at: Date }>(
    'SELECT e.received_at FROM submissions s JOIN emails e ON e.id=s.email_id WHERE s.id=$1',
    [submissionId],
  );
  return row?.received_at ?? null;
}

/** Copies of `id` follow it to `originalId`, so chains never form; their days-since-original are recomputed. */
export async function repointCopies(db: Queryable, id: string, originalId: string): Promise<void> {
  await db.query(
    `UPDATE submissions c SET duplicate_of=$2::uuid, updated_at=now(),
       duplicate_basis = c.duplicate_basis || jsonb_build_object('originalId', $2::text,
         'daysSinceOriginal', round(abs(extract(epoch FROM ce.received_at - oe.received_at)) / 86400)::int)
     FROM emails ce, submissions o JOIN emails oe ON oe.id=o.email_id
     WHERE c.duplicate_of=$1 AND ce.id=c.email_id AND o.id=$2::uuid`,
    [id, originalId],
  );
}

export async function markDuplicate(
  db: Queryable,
  id: string,
  originalId: string,
  basis: DuplicateBasis,
): Promise<void> {
  await db.query(
    `UPDATE submissions SET status='DUPLICATE', duplicate_of=$2, duplicate_basis=$3, updated_at=now() WHERE id=$1`,
    [id, originalId, JSON.stringify(basis)],
  );
}
