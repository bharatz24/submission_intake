import type { Queryable } from '../../db/pool.js';
import type { SubmissionStatus } from '../../services/statusTransitions.js';

/** SQL for re-running and resuming the pipeline, and for processing outside the portal. */

/** A full re-run reads every document again and starts with no progress (the run clears it too; cleared here so it shows at once). */
export async function resetForRerun(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE documents SET extraction_status='PENDING' WHERE submission_id=$1`, [id]);
  await db.query(`UPDATE submissions SET pipeline_progress='{}'::jsonb WHERE id=$1`, [id]);
}

export async function progressOf(db: Queryable, id: string) {
  const {
    rows: [row],
  } = await db.query<{ status: SubmissionStatus; pipeline_progress: unknown }>(
    'SELECT status, pipeline_progress FROM submissions WHERE id=$1 AND deleted_at IS NULL',
    [id],
  );
  return row ?? null;
}

export async function failedSubmissions(db: Queryable) {
  const { rows } = await db.query<{ id: string; pipeline_progress: unknown }>(
    `SELECT id, pipeline_progress FROM submissions WHERE status='ERROR' AND deleted_at IS NULL`,
  );
  return rows;
}

/** Imported emails still waiting for Process; ignored and duplicate ones are not processed. */
const HELD_FOR_IMPORT = `held_for_import AND deleted_at IS NULL AND status NOT IN ('NOT_SUBMISSION','DUPLICATE')`;

export async function heldForImport(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM submissions WHERE ${HELD_FOR_IMPORT} ORDER BY created_at`,
  );
  return rows.map((r) => r.id);
}

export async function countHeldForImport(db: Queryable): Promise<number> {
  const {
    rows: [r],
  } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM submissions WHERE ${HELD_FOR_IMPORT}`);
  return r?.n ?? 0;
}

/** Locks an imported email held for Process; null when it is not (or no longer) held. */
export async function lockHeldForImport(db: Queryable, id: string): Promise<{ id: string } | null> {
  const {
    rows: [row],
  } = await db.query<{ id: string }>(`SELECT id FROM submissions WHERE id=$1 AND ${HELD_FOR_IMPORT} FOR UPDATE`, [id]);
  return row ?? null;
}

/** Released for processing: shown as processing at once, before a worker takes the job. */
export async function releaseImportHold(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE submissions SET held_for_import=false, status='PROCESSING', updated_at=now() WHERE id=$1`, [
    id,
  ]);
}

export async function lockStatus(db: Queryable, id: string) {
  const {
    rows: [row],
  } = await db.query<{ status: SubmissionStatus }>(
    'SELECT status FROM submissions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
    [id],
  );
  return row ?? null;
}

export async function markProcessing(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE submissions SET status='PROCESSING', updated_at=now() WHERE id=$1`, [id]);
}

export async function pendingDocuments(db: Queryable, id: string): Promise<number> {
  const {
    rows: [r],
  } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM documents WHERE submission_id=$1 AND extraction_status='PENDING'`,
    [id],
  );
  return r?.n ?? 0;
}

/** The error of the last failed job with this key, if any. */
export async function lastJobError(db: Queryable, dedupeKey: string): Promise<string | null> {
  const {
    rows: [last],
  } = await db.query<{ last_error: string | null }>(
    `SELECT last_error FROM jobs WHERE dedupe_key=$1 AND status='failed' ORDER BY created_at DESC LIMIT 1`,
    [dedupeKey],
  );
  return last?.last_error ?? null;
}

/** The email and the text of every document. */
export async function textExport(db: Queryable, id: string) {
  const {
    rows: [sub],
  } = await db.query(
    `SELECT e.from_address, e.to_address, e.cc_address, e.subject, e.body_text FROM submissions s JOIN emails e ON e.id=s.email_id WHERE s.id=$1`,
    [id],
  );
  const { rows: docs } = await db.query(
    'SELECT id, filename, extraction_status, ocr_used, extracted_text FROM documents WHERE submission_id=$1 ORDER BY created_at',
    [id],
  );
  return {
    id,
    from: sub.from_address,
    to: sub.to_address,
    cc: sub.cc_address ?? null,
    subject: sub.subject,
    body: sub.body_text,
    documents: docs.map((d) => ({
      id: d.id,
      filename: d.filename,
      status: d.extraction_status,
      ocrUsed: d.ocr_used,
      text: d.extracted_text ?? '',
    })),
  };
}

/**
 * Bulk "Retry all" (PERF-09): one chunk of failed submissions after `afterId` (id order, so a row left failed because
 * its run was already queued is not read again), locked so two bulk retries never take the same rows.
 */
export async function failedChunk(db: Queryable, afterId: string | null, limit: number) {
  const { rows } = await db.query<{ id: string; pipeline_progress: unknown }>(
    `SELECT id, pipeline_progress FROM submissions
     WHERE status='ERROR' AND deleted_at IS NULL AND ($1::uuid IS NULL OR id > $1::uuid)
     ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [afterId, limit],
  );
  return rows;
}

/** Failed submissions resumed: shown as processing at once, their error and failed step cleared (as retryProcessing). */
export async function markRetrying(db: Queryable, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.query(
    `UPDATE submissions SET status=CASE WHEN status='ERROR' THEN 'PROCESSING' ELSE status END,
       processing_error=NULL, processing_error_detail=NULL,
       pipeline_progress=pipeline_progress || '{"failedStep": null, "autoRetrying": false}'::jsonb, updated_at=now()
     WHERE id = ANY($1::uuid[])`,
    [ids],
  );
}

/** Bulk "Process all imported": one locked chunk of imported emails held for Process, oldest first. */
export async function heldChunk(db: Queryable, limit: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM submissions WHERE ${HELD_FOR_IMPORT} ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows.map((r) => r.id);
}

/** releaseImportHold for many. */
export async function releaseImportHolds(db: Queryable, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.query(
    `UPDATE submissions SET held_for_import=false, status='PROCESSING', updated_at=now() WHERE id = ANY($1::uuid[])`,
    [ids],
  );
}
