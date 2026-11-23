import type { Queryable } from '../../db/pool.js';
import type { AssessmentRow } from '../../db/rows.js';
import { ASSESSMENT_SELECT, mapAssessment } from '../../services/queries.js';
import type { Decision, RiskRating } from './assessments.schemas.js';

/** SQL of the assessments module: no business rules here (assessments.service.ts decides). */

export async function isLiveSubmission(db: Queryable, submissionId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM submissions WHERE id=$1 AND deleted_at IS NULL', [submissionId]);
  return !!rowCount;
}

export async function listAssessments(db: Queryable, submissionId: string) {
  const { rows } = await db.query<AssessmentRow>(
    `${ASSESSMENT_SELECT} WHERE a.submission_id=$1 ORDER BY a.version DESC`,
    [submissionId],
  );
  return rows.map(mapAssessment);
}

export async function getAssessment(db: Queryable, id: string) {
  const {
    rows: [row],
  } = await db.query<AssessmentRow>(`${ASSESSMENT_SELECT} WHERE a.id=$1`, [id]);
  return row ? mapAssessment(row) : null;
}

/**
 * Mark the submission's completed automatic reports (a running or failed one has nothing to review yet) and automatic
 * quotes that nobody has acknowledged yet as reviewed by `userId`
 * (recording a decision is the review). Returns what it marked.
 */
export async function markAutomaticOutputReviewed(
  db: Queryable,
  submissionId: string,
  userId: string,
): Promise<{ reports: { id: string; kind: string; version: number }[]; quotes: { id: string; version: number }[] }> {
  const reports = await db.query<{ id: string; kind: string; version: number }>(
    `UPDATE reports SET reviewed_at=now(), reviewed_by=$2
       WHERE submission_id=$1 AND status='COMPLETED' AND created_by IS NULL AND reviewed_at IS NULL
       RETURNING id, kind, version`,
    [submissionId, userId],
  );
  const quotes = await db.query<{ id: string; version: number }>(
    `UPDATE single_rating SET reviewed_at=now(), reviewed_by=$2
       WHERE submission_id=$1 AND created_by IS NULL AND reviewed_at IS NULL RETURNING id, version`,
    [submissionId, userId],
  );
  return { reports: reports.rows, quotes: quotes.rows };
}

export async function isAnalysisOf(db: Queryable, reportId: string, submissionId: string): Promise<boolean> {
  const { rowCount } = await db.query(`SELECT 1 FROM reports WHERE id=$1 AND submission_id=$2 AND kind='ANALYSIS'`, [
    reportId,
    submissionId,
  ]);
  return !!rowCount;
}

/** The submission's status and context version, row-locked until the transaction ends. */
export async function lockSubmission(db: Queryable, submissionId: string) {
  const {
    rows: [row],
  } = await db.query<{ status: string; context_version: number }>(
    'SELECT status, context_version FROM submissions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
    [submissionId],
  );
  return row ?? null;
}

/** The premium and total of the submission's primary rating (submissions.primary_rating_id), or null when it has none. */
export async function primaryQuotePricing(db: Queryable, submissionId: string) {
  const {
    rows: [row],
  } = await db.query<{ premium: string | null; total: string | null }>(
    `SELECT r.premium, r.total FROM submissions s JOIN single_rating r ON r.id = s.primary_rating_id WHERE s.id=$1`,
    [submissionId],
  );
  return row
    ? {
        premium: row.premium === null ? null : Number(row.premium),
        total: row.total === null ? null : Number(row.total),
      }
    : null;
}

/** Whether the newest decision on the submission is exactly this one; the caller holds its row lock. */
export async function sameAsLatest(
  db: Queryable,
  a: {
    submissionId: string;
    decision: Decision;
    riskRating: RiskRating;
    notes: string;
    analysisReportId: string | null;
  },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM (SELECT * FROM assessments WHERE submission_id=$1 ORDER BY version DESC LIMIT 1) l
      WHERE l.decision=$2 AND l.risk_rating=$3 AND btrim(l.notes)=btrim($4)
        AND l.analysis_report_id IS NOT DISTINCT FROM $5::uuid`,
    [a.submissionId, a.decision, a.riskRating, a.notes, a.analysisReportId],
  );
  return !!rowCount;
}

/** Inserts the next version for the submission; the caller holds its row lock. */
export async function insertAssessment(
  db: Queryable,
  a: {
    submissionId: string;
    decision: Decision;
    riskRating: RiskRating;
    notes: string;
    analysisReportId: string | null;
    contextVersion: number;
    createdBy: string;
  },
): Promise<string> {
  const {
    rows: [row],
  } = await db.query<{ id: string }>(
    `INSERT INTO assessments (submission_id, version, decision, risk_rating, notes, analysis_report_id, context_version, created_by)
     VALUES ($1, COALESCE((SELECT max(version) FROM assessments WHERE submission_id=$1),0)+1, $2,$3,$4,$5,$6,$7) RETURNING id`,
    [a.submissionId, a.decision, a.riskRating, a.notes, a.analysisReportId, a.contextVersion, a.createdBy],
  );
  return row!.id;
}

export async function setSubmissionStatus(db: Queryable, submissionId: string, status: string): Promise<void> {
  await db.query('UPDATE submissions SET status=$2, updated_at=now() WHERE id=$1', [submissionId, status]);
}
