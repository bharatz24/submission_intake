import { pool, type Queryable, withTransaction } from '../db/pool.js';
import { audit } from './audit.js';
import { sha256 } from './crypto.js';
import { effectiveFields } from './fields.js';

/** Hash of everything the AI stages read: email, documents, effective (manual-first) fields, NPI results. */
export async function computeSnapshotHash(submissionId: string, db: Queryable = pool): Promise<string> {
  const [sub, docs, fields, npis] = await Promise.all([
    db.query('SELECT email_id, classification FROM submissions WHERE id=$1', [submissionId]),
    db.query('SELECT sha256, extraction_status FROM documents WHERE submission_id=$1 ORDER BY sha256', [submissionId]),
    effectiveFields(submissionId, db),
    db.query(
      'SELECT npi, status, mismatches, override_note FROM npi_verifications WHERE submission_id=$1 ORDER BY npi, verified_at',
      [submissionId],
    ),
  ]);
  // The reason is left out when there is none, so submissions without a decision keep their existing hash.
  const npiKey = npis.rows.map(({ override_note, ...n }) => (override_note ? { ...n, override_note } : n));
  const fieldKey = fields
    .map((f) => [f.fieldName, f.value, f.sourceLabel, f.evidenceQuote ?? ''])
    .sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
  return sha256(JSON.stringify([sub.rows, docs.rows, fieldKey, npiKey]));
}

/**
 * Record a new context version when the submission's evidence changed. Returns the
 * current version number (unchanged if the snapshot hash is identical).
 * Read-max-then-insert is serialized per submission by a transaction-scoped advisory lock, so two concurrent bumps
 * never both pick the same next version: on the pool it runs in its own transaction; a passed client must be in one.
 */
export async function bumpContextVersion(
  submissionId: string,
  reason: string,
  actorId: string | null,
  db: Queryable = pool,
): Promise<number> {
  // Own transaction: the hash is read on the pool (its queries run in parallel; this transaction has written nothing).
  if (db === pool) return withTransaction((client) => bumpLocked(submissionId, reason, actorId, client, pool));
  return bumpLocked(submissionId, reason, actorId, db, db);
}

async function bumpLocked(
  submissionId: string,
  reason: string,
  actorId: string | null,
  db: Queryable,
  hashDb: Queryable,
): Promise<number> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`context_version:${submissionId}`]);
  const hash = await computeSnapshotHash(submissionId, hashDb);
  const { rows } = await db.query<{ version: number; snapshot_hash: string }>(
    'SELECT version, snapshot_hash FROM context_versions WHERE submission_id=$1 ORDER BY version DESC LIMIT 1',
    [submissionId],
  );
  if (rows[0]?.snapshot_hash === hash) return rows[0].version;
  const version = (rows[0]?.version ?? 0) + 1;
  await db.query(
    'INSERT INTO context_versions (submission_id, version, reason, snapshot_hash, created_by) VALUES ($1,$2,$3,$4,$5)',
    [submissionId, version, reason, hash, actorId],
  );
  await db.query('UPDATE submissions SET context_version=$2, updated_at=now() WHERE id=$1', [submissionId, version]);
  await audit(
    {
      action: 'CONTEXT_VERSION_CREATED',
      entityType: 'submission',
      entityId: submissionId,
      submissionId,
      actorId,
      details: { version, reason, snapshotHash: hash },
    },
    db,
  );
  return version;
}
