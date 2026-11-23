import { withTransaction } from '../../db/pool.js';
import { audit } from '../../services/audit.js';

/** SQL for deleting inbox rows; the list and read-state queries are shared with the detail view (services/queries.ts). */

/** Emails still being processed are never deleted, so no job finishes on a hidden submission. */
const NOT_BUSY = `s.status NOT IN ('NEW','PROCESSING')`;

/**
 * Delete (hide) the inbox rows matching `where`, plus any copies held as duplicates of them, so no duplicate points at
 * a hidden original. Rows stay for the audit trail and Gmail never imports them again; see migration 017.
 */
export async function deleteSubmissions(
  actorId: string,
  where: string[],
  params: unknown[],
  details: Record<string, unknown>,
): Promise<number> {
  params.push(actorId);
  const actor = `$${params.length}`;
  return withTransaction(async (db) => {
    const { rows } = await db.query<{ id: string; copy_of: string | null }>(
      `WITH picked AS (
         SELECT s.id FROM submissions s JOIN emails e ON e.id=s.email_id
          WHERE s.deleted_at IS NULL AND ${NOT_BUSY} AND ${where.join(' AND ')} FOR UPDATE OF s),
       copies AS (
         SELECT c.id, c.duplicate_of FROM submissions c
          WHERE c.duplicate_of IN (SELECT id FROM picked) AND c.status='DUPLICATE' AND c.deleted_at IS NULL
            AND c.id NOT IN (SELECT id FROM picked))
       UPDATE submissions u SET deleted_at=now(), deleted_by=${actor}
         FROM (SELECT id, NULL::uuid AS copy_of FROM picked UNION ALL SELECT id, duplicate_of FROM copies) t
        WHERE u.id=t.id
       RETURNING u.id, t.copy_of`,
      params,
    );
    for (const r of rows) {
      await audit(
        {
          action: 'SUBMISSION_DELETED',
          entityType: 'submission',
          entityId: r.id,
          submissionId: r.id,
          actorId,
          details: r.copy_of ? { ...details, copyOf: r.copy_of } : details,
        },
        db,
      );
    }
    return rows.length;
  });
}
