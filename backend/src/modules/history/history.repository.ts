import type { Queryable } from '../../db/pool.js';
import {
  ASSESSMENT_SELECT,
  AUDIT_SELECT,
  mapAssessment,
  mapAudit,
  mapReportSummary,
  REPORT_SELECT,
} from '../../services/queries.js';

/** SQL for what changed on a submission over time: context versions, report and assessment versions, the audit trail. */

export interface Page {
  page: number;
  pageSize: number;
}

export async function versions(db: Queryable, submissionId: string) {
  const [cv, reports, assessments] = await Promise.all([
    db.query(
      `SELECT c.*, u.name AS created_by_name FROM context_versions c LEFT JOIN users u ON u.id=c.created_by WHERE submission_id=$1 ORDER BY version DESC`,
      [submissionId],
    ),
    db.query(`${REPORT_SELECT} WHERE r.submission_id=$1 ORDER BY r.created_at DESC`, [submissionId]),
    db.query(`${ASSESSMENT_SELECT} WHERE a.submission_id=$1 ORDER BY a.version DESC`, [submissionId]),
  ]);
  return {
    contextVersions: cv.rows.map((c) => ({
      version: c.version,
      reason: c.reason,
      snapshotHash: c.snapshot_hash,
      createdBy: c.created_by_name,
      createdAt: new Date(c.created_at).toISOString(),
    })),
    reports: reports.rows.map(mapReportSummary),
    assessments: assessments.rows.map(mapAssessment),
  };
}

/** Audit events matching an optional action and submission, newest first, one page and the total. */
export async function auditPage(
  db: Queryable,
  filter: { action?: string | null; submissionId?: string | null },
  { page, pageSize }: Page,
) {
  // DB-07: only the filters given, so each query can use its index (audit_action_created_idx,
  // audit_submission_idx, audit_created_idx), all ordered by created_at. Ties (one transaction) fall back to id.
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filter.action) conditions.push(`a.action=$${params.push(filter.action)}`);
  if (filter.submissionId) conditions.push(`a.submission_id=$${params.push(filter.submissionId)}::uuid`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [
    {
      rows: [count],
    },
    { rows },
  ] = await Promise.all([
    db.query<{ total: number }>(`SELECT count(*)::int AS total FROM audit_events a ${where}`, params),
    db.query(
      `${AUDIT_SELECT} ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
  ]);
  return { items: rows.map(mapAudit), total: count?.total ?? 0, page, pageSize };
}
