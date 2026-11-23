import type { PoolClient } from 'pg';

import { CLASSIFYING_WINDOW } from '../constants.js';
import { pool } from '../db/pool.js';
import type { AssessmentRow, AuditRow, NpiRow, ReportRow, SubmissionSummaryRow, UserRow } from '../db/rows.js';
import { notFound } from '../http.js';
import { loadAutoRun } from './autoRun.js';
import { buildCoverage } from './coverage.js';
import { effectiveFields, MANUAL_FIELD_SELECT, mapManualField } from './fields.js';
import { listInjectionFlags } from './injectionFlags.js';
import { pipelineState } from './pipelineProgress.js';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
/** Characters of a document's extracted text the submission detail returns as its preview. */
const TEXT_PREVIEW_CHARS = 2000;
const person = (id: string | null, name: string | null) => (id ? { id, name: name ?? '' } : null);

export function mapUser(r: UserRow) {
  return { id: r.id, email: r.email, name: r.name, role: r.role, createdAt: iso(r.created_at) };
}

export function mapReportSummary(r: ReportRow) {
  return {
    id: r.id,
    kind: r.kind,
    version: r.version,
    status: r.status,
    contextVersion: r.context_version,
    basedOnReportId: r.based_on_report_id,
    skillName: r.skill_name,
    skillVersion: r.skill_version,
    model: r.model,
    createdBy: person(r.created_by, r.created_by_name),
    createdAt: iso(r.created_at),
    completedAt: iso(r.completed_at),
    error: r.error,
    // Automatic (no person started it) and not yet acknowledged; reviewedBy is the reviewer's name.
    needsReview: r.created_by === null && !r.reviewed_at,
    reviewedAt: iso(r.reviewed_at ?? null),
    reviewedBy: r.reviewed_at ? (r.reviewed_by_name ?? '') : null,
  };
}

/** Token usage of a report or comparison (input_tokens / output_tokens columns); null when not recorded. */
export const usageOf = (r: { input_tokens: number | null; output_tokens: number | null }) =>
  r.input_tokens === null ? null : { inputTokens: r.input_tokens, outputTokens: r.output_tokens ?? 0 };

export function mapReport(r: ReportRow) {
  return {
    ...mapReportSummary(r),
    content: r.content_json,
    markdown: r.content_markdown,
    usage: usageOf(r),
    // Evidence checked against the submission (services/grounding.ts); null = not graded.
    grounding: r.grounding ?? null,
  };
}

export function mapAssessment(r: AssessmentRow) {
  return {
    id: r.id,
    version: r.version,
    decision: r.decision,
    riskRating: r.risk_rating,
    notes: r.notes,
    analysisReportId: r.analysis_report_id,
    contextVersion: r.context_version,
    createdBy: { id: r.created_by, name: r.created_by_name ?? '' },
    createdAt: iso(r.created_at),
  };
}

export function mapAudit(r: AuditRow) {
  return {
    id: String(r.id),
    submissionId: r.submission_id,
    actorType: r.actor_type,
    actor: person(r.actor_id, r.actor_name),
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    details: r.details,
    createdAt: iso(r.created_at),
  };
}

export function mapNpi(r: NpiRow) {
  return {
    id: r.id,
    npi: r.npi,
    claimedName: r.claimed_name,
    claimedState: r.claimed_state,
    claimedSpecialty: r.claimed_specialty,
    status: r.status,
    registryName: r.registry_name,
    registryTaxonomy: r.registry_taxonomy,
    registryState: r.registry_state,
    registryStatus: r.registry_status,
    mismatches: r.mismatches,
    registryData: r.registry_data,
    verifiedAt: iso(r.verified_at),
    claimedType: r.claimed_type,
    claimedFirstName: r.claimed_first_name,
    claimedLastName: r.claimed_last_name,
    claimedEntityName: r.claimed_entity_name,
    registryType: r.registry_type,
    registryFirstName: r.registry_first_name,
    registryLastName: r.registry_last_name,
    registryEntityName: r.registry_entity_name,
    source: r.source ?? 'EXTRACTED',
    addedBy: person(r.added_by ?? null, r.added_by_name ?? null),
    note: r.note ?? null,
    autoStatus: r.auto_status ?? null,
    overrideNote: r.override_note ?? null,
    overrideBy: person(r.override_by ?? null, r.override_by_name ?? null),
    overrideAt: r.override_at ? iso(r.override_at) : null,
  };
}

export const NPI_SELECT = `SELECT n.*, u.name AS added_by_name, o.name AS override_by_name FROM npi_verifications n
  LEFT JOIN users u ON u.id=n.added_by LEFT JOIN users o ON o.id=n.override_by`;

/** A submission's NPI checks, newest first, as the API returns them. */
export async function listNpis(submissionId: string) {
  const { rows } = await pool.query(`${NPI_SELECT} WHERE n.submission_id=$1 ORDER BY n.verified_at DESC`, [
    submissionId,
  ]);
  return rows.map(mapNpi);
}

export const REPORT_SELECT = `SELECT r.*, u.name AS created_by_name, rv.name AS reviewed_by_name FROM reports r
  LEFT JOIN users u ON u.id=r.created_by LEFT JOIN users rv ON rv.id=r.reviewed_by`;
export const ASSESSMENT_SELECT = `SELECT a.*, u.name AS created_by_name FROM assessments a JOIN users u ON u.id=a.created_by`;
export const AUDIT_SELECT = `SELECT a.*, u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id`;

/**
 * NPI statuses from best to worst. A submission's NPI status is its best check: with several NPIs, one that
 * matches the registry verifies the submission, and the others that do not match are only a caveat.
 */
export const NPI_STATUS_RANK = ['MATCH', 'PARTIAL_MATCH', 'NOT_VERIFIED', 'ERROR', 'NOT_FOUND', 'MISMATCH'] as const;

const SUMMARY_SELECT = `
  SELECT s.*, e.subject, e.from_address, e.received_at, u.name AS assigned_name,
    (SELECT count(*)::int FROM documents d WHERE d.submission_id=s.id) AS document_count,
    (SELECT status FROM npi_verifications n WHERE n.submission_id=s.id
     ORDER BY array_position(ARRAY[${NPI_STATUS_RANK.map((x) => `'${x}'`).join(',')}], n.status), verified_at DESC LIMIT 1) AS npi_status,
    (SELECT count(*) FILTER (WHERE n.status IN ('MATCH', 'PARTIAL_MATCH'))::int FROM npi_verifications n WHERE n.submission_id=s.id) AS npi_verified_count,
    (SELECT count(*) FILTER (WHERE n.status NOT IN ('MATCH', 'PARTIAL_MATCH'))::int FROM npi_verifications n WHERE n.submission_id=s.id) AS npi_failed_count,
    (SELECT max(version) FROM reports r WHERE r.submission_id=s.id AND r.kind='SYNTHESIS' AND r.status='COMPLETED') AS latest_synthesis_version,
    (SELECT max(version) FROM reports r WHERE r.submission_id=s.id AND r.kind='ANALYSIS' AND r.status='COMPLETED') AS latest_analysis_version,
    (SELECT oe.subject FROM submissions o JOIN emails oe ON oe.id=o.email_id WHERE o.id=s.duplicate_of) AS duplicate_of_subject,
    (EXISTS (SELECT 1 FROM reports r WHERE r.submission_id=s.id AND r.status='COMPLETED' AND r.created_by IS NULL AND r.reviewed_at IS NULL)
      OR EXISTS (SELECT 1 FROM single_rating q WHERE q.submission_id=s.id AND q.created_by IS NULL AND q.reviewed_at IS NULL)) AS needs_review
  FROM submissions s JOIN emails e ON e.id=s.email_id LEFT JOIN users u ON u.id=s.assigned_to`;

function mapSummary(r: SubmissionSummaryRow) {
  return {
    id: r.id,
    subject: r.subject,
    fromAddress: r.from_address,
    receivedAt: iso(r.received_at),
    status: r.status,
    classification: r.classification,
    classificationConfidence: r.classification_confidence,
    classificationReasons: r.classification_reasons,
    applicantName: r.applicant_name,
    applicantType: r.applicant_type,
    applicantFirstName: r.applicant_first_name,
    applicantLastName: r.applicant_last_name,
    applicantEntityName: r.applicant_entity_name,
    documentCount: r.document_count,
    npiStatus: r.npi_status,
    npiVerifiedCount: r.npi_verified_count ?? 0,
    npiFailedCount: r.npi_failed_count ?? 0,
    latestSynthesisVersion: r.latest_synthesis_version,
    latestAnalysisVersion: r.latest_analysis_version,
    assignedTo: person(r.assigned_to, r.assigned_name),
    contextVersion: r.context_version,
    updatedAt: iso(r.updated_at),
    isRead: r.is_read ?? true,
    duplicateOf: r.duplicate_of ? { id: r.duplicate_of, subject: r.duplicate_of_subject ?? '' } : null,
    duplicateBasis: r.duplicate_basis ?? null,
    // Plain words for underwriters; the raw error text (for admins) is processingErrorDetail.
    processingError: r.processing_error ?? null,
    processingErrorDetail: r.processing_error_detail ?? null,
    // Classification is manual and the email was uncertain: extraction, NPI and reports wait for a person's verdict.
    heldForClassification: r.held_for_classification ?? false,
    // Imported (Settings → Import older email): classified only; extraction, NPI and reports wait for Process.
    heldForImport: r.held_for_import ?? false,
    // Steps the last run finished / failed at; POST /submissions/:id/retry continues from failedStep.
    pipeline: pipelineState(r),
    // A completed automatic report or an automatic quote nobody has acknowledged yet.
    needsReview: r.needs_review ?? false,
  };
}

/** Inbox tabs. The status decides the tab, since it is also what gates processing. */
export const VIEWS = ['submissions', 'ignored', 'duplicates', 'errors'] as const;
export type View = (typeof VIEWS)[number];
// Not on any tab until it has a verdict, or it would show under Submissions and then jump to Ignored. Jobs do not
// survive a restart, so an email stuck here reappears under Submissions rather than staying out of sight.
const CLASSIFYING = `(s.status = 'NEW' AND s.classification IS NULL AND s.updated_at > now() - interval '${CLASSIFYING_WINDOW}')`;
const VIEW_WHERE: Record<View, string> = {
  submissions: `s.status NOT IN ('NOT_SUBMISSION','DUPLICATE','ERROR') AND NOT ${CLASSIFYING}`,
  ignored: `s.status = 'NOT_SUBMISSION'`,
  duplicates: `s.status = 'DUPLICATE'`,
  // Processing failed: retried by hand from the Errors tab (POST /submissions/:id/reprocess, /submissions/errors/retry-all).
  errors: `s.status = 'ERROR'`,
};

/** Search over subject, sender and applicant: the same match the inbox list uses. */
export function searchWhere(q: string | undefined, params: unknown[]): string | null {
  if (!q) return null;
  params.push(`%${q}%`);
  return `(e.subject ILIKE $${params.length} OR e.from_address ILIKE $${params.length} OR s.applicant_name ILIKE $${params.length})`;
}

/** Inbox items the user has not opened yet, across all three tabs (not those still being classified, which no tab shows). */
export async function unreadCount(userId: string): Promise<number> {
  const {
    rows: [{ unread }],
  } = await pool.query(
    `SELECT count(*)::int AS unread FROM submissions s
     WHERE s.deleted_at IS NULL AND NOT ${CLASSIFYING} AND NOT EXISTS (SELECT 1 FROM submission_reads r WHERE r.submission_id=s.id AND r.user_id=$1)`,
    [userId],
  );
  return unread;
}

export async function markRead(userId: string, submissionId: string): Promise<void> {
  await pool.query('INSERT INTO submission_reads (user_id, submission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
    userId,
    submissionId,
  ]);
}

/** Reopen as unread for this user only. */
export async function markUnread(userId: string, submissionId: string): Promise<void> {
  await pool.query('DELETE FROM submission_reads WHERE user_id=$1 AND submission_id=$2', [userId, submissionId]);
}

/** Mark every inbox row matching `where` (built with inboxWhere/searchWhere) read for this user; returns how many were unread. */
export async function markAllRead(userId: string, where: string[], params: unknown[]): Promise<number> {
  params.push(userId);
  const { rowCount } = await pool.query(
    `INSERT INTO submission_reads (user_id, submission_id)
     SELECT $${params.length}, s.id FROM submissions s JOIN emails e ON e.id=s.email_id
      WHERE s.deleted_at IS NULL AND ${where.length ? where.join(' AND ') : 'TRUE'}
     ON CONFLICT DO NOTHING`,
    params,
  );
  return rowCount ?? 0;
}

export interface InboxFilters {
  view?: View;
  status?: string;
  classification?: string;
  strength?: string;
}

/** The tab and per-tab filters of the inbox list, as WHERE terms; delete-all uses the same ones. */
export function inboxWhere(f: InboxFilters, params: unknown[]): string[] {
  const where: string[] = [];
  if (f.view) where.push(VIEW_WHERE[f.view]);
  if (f.status) {
    params.push(f.status);
    where.push(`s.status = $${params.length}`);
  }
  if (f.classification) {
    params.push(f.classification);
    where.push(`s.classification = $${params.length}`);
  }
  if (f.strength) {
    params.push(f.strength);
    where.push(`s.duplicate_basis->>'strength' = $${params.length}`);
  }
  return where;
}

export async function listSubmissions(
  userId: string,
  q: InboxFilters & { q?: string; page: number; pageSize: number },
) {
  const where: string[] = ['s.deleted_at IS NULL'];
  const params: unknown[] = [];
  const search = searchWhere(q.q, params);
  if (search) where.push(search);
  // Tab counts follow the search but not the per-tab filters.
  const counts = await viewCounts(userId, [...where], [...params]);
  where.push(...inboxWhere(q, params));
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const {
    rows: [{ total }],
  } = await pool.query(
    `SELECT count(*)::int AS total FROM submissions s JOIN emails e ON e.id=s.email_id ${w}`,
    params,
  );
  params.push(userId, q.pageSize, (q.page - 1) * q.pageSize);
  const isRead = `EXISTS (SELECT 1 FROM submission_reads sr WHERE sr.submission_id=s.id AND sr.user_id=$${params.length - 2}) AS is_read`;
  const select = SUMMARY_SELECT.replace(/^\s*SELECT /, `SELECT ${isRead}, `);
  const { rows } = await pool.query(
    `${select} ${w} ORDER BY e.received_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows.map(mapSummary), total, page: q.page, pageSize: q.pageSize, ...counts };
}

async function viewCounts(userId: string, where: string[], params: unknown[]) {
  params.push(userId);
  const unread = `NOT EXISTS (SELECT 1 FROM submission_reads sr WHERE sr.submission_id=s.id AND sr.user_id=$${params.length})`;
  const cols = VIEWS.flatMap((v) => [
    `count(*) FILTER (WHERE ${VIEW_WHERE[v]})::int AS ${v}`,
    `count(*) FILTER (WHERE ${VIEW_WHERE[v]} AND ${unread})::int AS ${v}_unread`,
  ]);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const {
    rows: [r],
  } = await pool.query(
    `SELECT ${cols.join(', ')}, count(*) FILTER (WHERE ${CLASSIFYING})::int AS classifying FROM submissions s JOIN emails e ON e.id=s.email_id ${w}`,
    params,
  );
  return {
    classifying: r.classifying as number,
    counts: Object.fromEntries(VIEWS.map((v) => [v, r[v]])) as Record<View, number>,
    unread: Object.fromEntries(VIEWS.map((v) => [v, r[`${v}_unread`]])) as Record<View, number>,
  };
}

async function readSubmissionDetail(db: PoolClient, id: string) {
  const {
    rows: [s],
  } = await db.query(`${SUMMARY_SELECT} WHERE s.id=$1 AND s.deleted_at IS NULL`, [id]);
  if (!s) throw notFound('Submission');
  const email = await db.query(
    `SELECT id, gmail_message_id, thread_id, from_address, to_address, cc_address, subject, snippet, body_text, received_at
     FROM emails WHERE id=$1`,
    [s.email_id],
  );
  const docs = await db.query(
    `SELECT id, filename, mime_type, size_bytes, sha256, source, extraction_status, ocr_used, page_count, created_at,
            left(extracted_text, ${TEXT_PREVIEW_CHARS}) AS text_preview
     FROM documents WHERE submission_id=$1 ORDER BY created_at`,
    [id],
  );
  const gaps = await db.query(
    `SELECT id, filename, mime_type, size_bytes, reason, detail, created_at
     FROM attachment_gaps WHERE submission_id=$1 ORDER BY created_at`,
    [id],
  );
  const fields = await db.query(
    `SELECT id, field_name, value, confidence, evidence_quote, source_label, document_id, evidence_verified
     FROM extracted_fields WHERE submission_id=$1
       AND context_version=(SELECT max(context_version) FROM extracted_fields WHERE submission_id=$1)
     ORDER BY field_name, confidence DESC`,
    [id],
  );
  const manual = await db.query(`${MANUAL_FIELD_SELECT} WHERE m.submission_id=$1 ORDER BY m.field_name, m.created_at`, [
    id,
  ]);
  const effective = await effectiveFields(id, db);
  const npis = await db.query(`${NPI_SELECT} WHERE n.submission_id=$1 ORDER BY n.verified_at DESC`, [id]);
  const latestReport = (kind: 'SYNTHESIS' | 'ANALYSIS') =>
    db.query(`${REPORT_SUMMARY_SELECT} WHERE r.submission_id=$1 AND r.kind=$2 ORDER BY r.version DESC LIMIT 1`, [
      id,
      kind,
    ]);
  const syn = await latestReport('SYNTHESIS');
  const ana = await latestReport('ANALYSIS');
  const asmt = await db.query(`${ASSESSMENT_SELECT} WHERE a.submission_id=$1 ORDER BY a.version DESC LIMIT 1`, [id]);
  const dups = await db.query(
    `SELECT s.id, e.subject, e.received_at FROM submissions s JOIN emails e ON e.id=s.email_id
     WHERE s.duplicate_of=$1 AND s.deleted_at IS NULL ORDER BY e.received_at`,
    [id],
  );
  const injectionFlags = await listInjectionFlags(id, db);
  return { s, email, docs, gaps, fields, manual, effective, npis, syn, ana, asmt, dups, injectionFlags };
}

/** A report's summary columns (mapReportSummary), without its content: the detail view does not return it. */
const REPORT_SUMMARY_SELECT = `SELECT r.id, r.kind, r.version, r.status, r.context_version, r.based_on_report_id, r.skill_name,
    r.skill_version, r.model, r.created_by, r.created_at, r.completed_at, r.error, r.input_tokens, r.output_tokens,
    r.reviewed_at, u.name AS created_by_name, rv.name AS reviewed_by_name
  FROM reports r LEFT JOIN users u ON u.id=r.created_by LEFT JOIN users rv ON rv.id=r.reviewed_by`;

/**
 * The submission workspace. DB-09 / CQ-05: one connection, queries in turn, in one read-only REPEATABLE READ snapshot
 * (consistent across the parts, and a busy page no longer takes a dozen pool connections at once); explicit columns,
 * with documents' text cut to its 2,000-character preview in SQL rather than fetched whole.
 */
export async function getSubmissionDetail(id: string) {
  const db = await pool.connect();
  let broken: Error | undefined;
  let parts;
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    parts = await readSubmissionDetail(db, id);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch((e: Error) => {
      broken = e;
    });
    throw err;
  } finally {
    db.release(broken);
  }
  const { s, email, docs, gaps, fields, manual, effective, npis, syn, ana, asmt, dups, injectionFlags } = parts;
  const e = email.rows[0];
  const latestSynthesis = syn.rows[0] ? mapReportSummary(syn.rows[0]) : null;
  const latestAnalysis = ana.rows[0] ? mapReportSummary(ana.rows[0]) : null;
  const { autoRun, processingQueued } = await loadAutoRun(
    { id, status: s.status, contextVersion: s.context_version },
    latestSynthesis,
    latestAnalysis,
  );
  return {
    ...mapSummary(s),
    email: {
      id: e.id,
      gmailMessageId: e.gmail_message_id,
      threadId: e.thread_id,
      fromAddress: e.from_address,
      toAddress: e.to_address,
      ccAddress: e.cc_address ?? null,
      subject: e.subject,
      snippet: e.snippet,
      bodyText: e.body_text,
      receivedAt: iso(e.received_at),
    },
    documents: docs.rows.map((d) => ({
      id: d.id,
      filename: d.filename,
      mimeType: d.mime_type,
      sizeBytes: d.size_bytes,
      sha256: d.sha256,
      source: d.source,
      extractionStatus: d.extraction_status,
      ocrUsed: d.ocr_used,
      pageCount: d.page_count,
      textPreview: d.text_preview as string,
      createdAt: iso(d.created_at),
    })),
    // Attachments that could not be stored (too large, shared as a link, no content); storage IDs are never exposed.
    attachmentGaps: gaps.rows.map((g) => ({
      id: g.id,
      filename: g.filename,
      mimeType: g.mime_type,
      sizeBytes: g.size_bytes === null ? null : Number(g.size_bytes),
      reason: g.reason,
      detail: g.detail,
      createdAt: iso(g.created_at),
    })),
    extractedFields: fields.rows.map((f) => ({
      id: f.id,
      fieldName: f.field_name,
      value: f.value,
      confidence: f.confidence,
      evidenceQuote: f.evidence_quote,
      sourceLabel: f.source_label,
      documentId: f.document_id,
      evidenceVerified: f.evidence_verified ?? null,
    })),
    // Entered by people; each supersedes the extracted values with its field name (services/fields.ts).
    manualFields: manual.rows.map(mapManualField),
    coverage: buildCoverage(effective),
    npiVerifications: npis.rows.map(mapNpi),
    latestSynthesis,
    latestAnalysis,
    // The automatic Synthesis → Analysis → quote after processing, for the progress tracker.
    autoRun,
    // A processing run is queued or running. Re-run and Process only queue it, and the status turns PROCESSING when a
    // worker takes the job (a submission in review or completed keeps its status), so the tracker shows from the click.
    processingQueued,
    latestAssessment: asmt.rows[0] ? mapAssessment(asmt.rows[0]) : null,
    processingError: s.processing_error,
    duplicates: dups.rows.map((d) => ({ id: d.id, subject: d.subject, receivedAt: iso(d.received_at) })),
    // Instruction-like text found in the email or attachments (services/injectionFlags.ts); flagged, never blocked.
    injectionFlags,
  };
}
