import type { Queryable } from '../../db/pool.js';

/** SQL for a submission's NPI checks (npi_verifications). */

export interface VerificationRow {
  npi: string;
  source: 'EXTRACTED' | 'MANUAL';
  status: string;
  auto_status: string | null;
  override_note: string | null;
}

export async function getVerification(
  db: Queryable,
  submissionId: string,
  verificationId: string,
): Promise<VerificationRow | null> {
  const {
    rows: [v],
  } = await db.query<VerificationRow>(
    'SELECT npi, source, status, auto_status, override_note FROM npi_verifications WHERE id=$1 AND submission_id=$2',
    [verificationId, submissionId],
  );
  return v ?? null;
}

/** Where an existing check of this NPI came from, so re-verifying keeps it. */
export async function sourceOf(
  db: Queryable,
  submissionId: string,
  npi: string,
): Promise<VerificationRow['source'] | null> {
  const {
    rows: [v],
  } = await db.query<{ source: VerificationRow['source'] }>(
    'SELECT source FROM npi_verifications WHERE submission_id=$1 AND npi=$2',
    [submissionId, npi],
  );
  return v?.source ?? null;
}

export async function deleteVerification(db: Queryable, verificationId: string): Promise<void> {
  await db.query('DELETE FROM npi_verifications WHERE id=$1', [verificationId]);
}

/** The automatic result is kept in auto_status, so the decision can be undone. */
export async function setOverride(
  db: Queryable,
  verificationId: string,
  status: string,
  note: string,
  actorId: string,
): Promise<void> {
  await db.query(
    `UPDATE npi_verifications SET auto_status=COALESCE(auto_status, status), status=$2, override_note=$3, override_by=$4, override_at=now() WHERE id=$1`,
    [verificationId, status, note, actorId],
  );
}

export async function clearOverride(db: Queryable, verificationId: string): Promise<void> {
  await db.query(
    'UPDATE npi_verifications SET status=auto_status, auto_status=NULL, override_note=NULL, override_by=NULL, override_at=NULL WHERE id=$1',
    [verificationId],
  );
}
