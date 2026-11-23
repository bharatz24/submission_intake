import type { Queryable } from '../../db/pool.js';

/** SQL for the values a person entered by hand (manual_fields). */

export interface ManualFieldRow {
  id: string;
  field_name: string;
  value: string;
  note: string | null;
  document_id: string | null;
}

export async function getField(db: Queryable, submissionId: string, fieldId: string): Promise<ManualFieldRow | null> {
  const {
    rows: [row],
  } = await db.query<ManualFieldRow>('SELECT * FROM manual_fields WHERE id=$1 AND submission_id=$2', [
    fieldId,
    submissionId,
  ]);
  return row ?? null;
}

/** How many of `ids` are documents of this submission. */
export async function countOwnDocuments(db: Queryable, submissionId: string, ids: string[]): Promise<number> {
  const { rowCount } = await db.query('SELECT 1 FROM documents WHERE id = ANY($1::uuid[]) AND submission_id=$2', [
    ids,
    submissionId,
  ]);
  return rowCount ?? 0;
}

export async function updateField(
  db: Queryable,
  fieldId: string,
  value: { value: string; note: string | null; documentId: string | null },
  actorId: string,
): Promise<void> {
  await db.query(
    'UPDATE manual_fields SET value=$2, note=$3, document_id=$4, updated_by=$5, updated_at=now() WHERE id=$1',
    [fieldId, value.value, value.note, value.documentId, actorId],
  );
}

export async function deleteField(db: Queryable, fieldId: string): Promise<void> {
  await db.query('DELETE FROM manual_fields WHERE id=$1', [fieldId]);
}
