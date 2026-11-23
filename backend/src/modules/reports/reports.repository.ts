import type { Queryable } from '../../db/pool.js';
import { COMPARISON_SELECT, mapComparison, mapComparisonSummary } from '../../services/comparisons.js';
import { mapReport, mapReportSummary, REPORT_SELECT } from '../../services/queries.js';

/** SQL for reading reports and comparisons; starting one is services/reports.ts and services/comparisons.ts. */

type Kind = 'SYNTHESIS' | 'ANALYSIS';

/** Reports and comparisons of a deleted (hidden) submission are gone with it. */
const liveOf = (submissionColumn: string) =>
  `EXISTS (SELECT 1 FROM submissions ls WHERE ls.id=${submissionColumn} AND ls.deleted_at IS NULL)`;

export async function reportSummary(db: Queryable, reportId: string) {
  const {
    rows: [r],
  } = await db.query(`${REPORT_SELECT} WHERE r.id=$1`, [reportId]);
  return mapReportSummary(r);
}

export async function listReports(db: Queryable, submissionId: string, kind: Kind | null) {
  const { rows } = await db.query(
    `${REPORT_SELECT} WHERE r.submission_id=$1 AND ($2::text IS NULL OR r.kind=$2) ORDER BY r.created_at DESC`,
    [submissionId, kind],
  );
  return rows.map(mapReportSummary);
}

export async function getLiveReport(db: Queryable, reportId: string) {
  const {
    rows: [r],
  } = await db.query(`${REPORT_SELECT} WHERE r.id=$1 AND ${liveOf('r.submission_id')}`, [reportId]);
  return r ? mapReport(r) : null;
}

/**
 * Acknowledge an automatic report (created_by NULL). The first reviewer is kept: a later call changes nothing.
 * Returns null when the report is not this submission's, else whether this call recorded the review.
 */
export async function markReportReviewed(
  db: Queryable,
  submissionId: string,
  reportId: string,
  userId: string,
): Promise<{ kind: Kind; version: number; reviewed: boolean } | 'NOT_COMPLETED' | null> {
  const {
    rows: [r],
  } = await db.query<{ kind: Kind; version: number; status: string; created_by: string | null }>(
    'SELECT kind, version, status, created_by FROM reports WHERE id=$1 AND submission_id=$2 FOR UPDATE',
    [reportId, submissionId],
  );
  if (!r) return null;
  // An automatic report still running (or failed) has nothing to acknowledge yet.
  if (r.created_by === null && r.status !== 'COMPLETED') return 'NOT_COMPLETED';
  const { rowCount } = await db.query(
    'UPDATE reports SET reviewed_at=now(), reviewed_by=$2 WHERE id=$1 AND created_by IS NULL AND reviewed_at IS NULL',
    [reportId, userId],
  );
  return { kind: r.kind, version: r.version, reviewed: rowCount === 1 };
}

export async function comparisonSummary(db: Queryable, comparisonId: string) {
  const {
    rows: [c],
  } = await db.query(`${COMPARISON_SELECT} WHERE c.id=$1`, [comparisonId]);
  return mapComparisonSummary(c);
}

export async function listComparisons(db: Queryable, submissionId: string, kind: Kind | null) {
  const { rows } = await db.query(
    `${COMPARISON_SELECT} WHERE c.submission_id=$1 AND ($2::text IS NULL OR c.kind=$2) ORDER BY c.created_at DESC`,
    [submissionId, kind],
  );
  return rows.map(mapComparisonSummary);
}

export async function getLiveComparison(db: Queryable, comparisonId: string) {
  const {
    rows: [c],
  } = await db.query(`${COMPARISON_SELECT} WHERE c.id=$1 AND ${liveOf('c.submission_id')}`, [comparisonId]);
  return c ? mapComparison(c) : null;
}
