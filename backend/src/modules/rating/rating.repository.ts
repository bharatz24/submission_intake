import type { Queryable } from '../../db/pool.js';

/** SQL for saved quotes (single_rating); pricing and rate tables are services/rating/*. */

/** The newest quote's version and inputs, to prefill the underwriter's choices. */
export async function latestQuoteInputs(db: Queryable, submissionId: string) {
  const {
    rows: [row],
  } = await db.query<{ version: number; inputs: Record<string, unknown> }>(
    'SELECT version, inputs FROM single_rating WHERE submission_id=$1 ORDER BY version DESC LIMIT 1',
    [submissionId],
  );
  return row ?? null;
}

/**
 * Acknowledge an automatic quote (created_by NULL). The first reviewer is kept: a later call changes nothing.
 * Returns null when the quote is not this submission's, else whether this call recorded the review.
 */
export async function markQuoteReviewed(
  db: Queryable,
  submissionId: string,
  quoteId: string,
  userId: string,
): Promise<{ version: number; reviewed: boolean } | null> {
  const {
    rows: [q],
  } = await db.query<{ version: number }>(
    'SELECT version FROM single_rating WHERE id=$1 AND submission_id=$2 FOR UPDATE',
    [quoteId, submissionId],
  );
  if (!q) return null;
  const { rowCount } = await db.query(
    'UPDATE single_rating SET reviewed_at=now(), reviewed_by=$2 WHERE id=$1 AND created_by IS NULL AND reviewed_at IS NULL',
    [quoteId, userId],
  );
  return { version: q.version, reviewed: rowCount === 1 };
}

export async function quoteOf(db: Queryable, submissionId: string, quoteId: string) {
  const {
    rows: [row],
  } = await db.query<{ id: string; version: number }>(
    'SELECT id, version FROM single_rating WHERE id=$1 AND submission_id=$2',
    [quoteId, submissionId],
  );
  return row ?? null;
}

/** One app_settings value (null when unset). */
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
