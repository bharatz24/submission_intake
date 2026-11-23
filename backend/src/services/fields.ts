import { randomUUID } from 'node:crypto';

import { pool, type Queryable } from '../db/pool.js';
import { auditMany } from './audit.js';
import { structureName } from './npi.js';

/** Label manual values carry wherever evidence is shown (reports, coverage, NPI claims). */
export const MANUAL_SOURCE = 'manual entry';

export interface EffectiveField {
  fieldName: string;
  value: string;
  confidence: number;
  evidenceQuote: string | null;
  sourceLabel: string;
  documentId: string | null;
  manual: boolean;
  /** Filename of the document a manual value was taken from. */
  supportingDocument: string | null;
  /** Whether the evidence quote was found in its source (services/evidence.ts); null when not checked. */
  evidenceVerified: boolean | null;
}

/**
 * The submission's evidence fields: manual entries first, then extracted values (latest context version) for
 * every field without a manual entry. A manual value supersedes all extracted values with its field name.
 * Everything that reads evidence (reports, coverage, NPI claims, snapshot hash) goes through here.
 */
export async function effectiveFields(submissionId: string, db: Queryable = pool): Promise<EffectiveField[]> {
  // In turn, not in parallel: `db` may be a single client (a transaction, the detail view's snapshot).
  const manual = await db.query(
    `SELECT m.field_name, m.value, m.note, m.document_id, d.filename FROM manual_fields m LEFT JOIN documents d ON d.id=m.document_id
     WHERE m.submission_id=$1 ORDER BY m.field_name, m.created_at`,
    [submissionId],
  );
  const extracted = await db.query(
    `SELECT field_name, value, confidence, evidence_quote, source_label, document_id, evidence_verified FROM extracted_fields
     WHERE submission_id=$1 AND context_version=(SELECT max(context_version) FROM extracted_fields WHERE submission_id=$1)
     ORDER BY field_name, confidence DESC`,
    [submissionId],
  );
  const overridden = new Set(manual.rows.map((m) => m.field_name as string));
  return [
    // Confidence 1: a person stated it, so it outranks any extracted value in pickBest.
    ...manual.rows.map((m) => ({
      fieldName: m.field_name,
      value: m.value,
      confidence: 1,
      evidenceQuote: m.note ?? null,
      sourceLabel: MANUAL_SOURCE,
      supportingDocument: m.filename ?? null,
      documentId: m.document_id ?? null,
      manual: true,
      evidenceVerified: null,
    })),
    ...extracted.rows
      .filter((f) => !overridden.has(f.field_name))
      .map((f) => ({
        fieldName: f.field_name,
        value: f.value,
        confidence: Number(f.confidence),
        evidenceQuote: f.evidence_quote,
        sourceLabel: f.source_label,
        documentId: f.document_id,
        manual: false,
        supportingDocument: null,
        evidenceVerified: f.evidence_verified ?? null,
      })),
  ];
}

export function pickBest(
  fields: { fieldName: string; value: string; confidence: number }[],
  name: string,
): string | null {
  return fields.filter((f) => f.fieldName === name).sort((a, b) => b.confidence - a.confidence)[0]?.value ?? null;
}

/** Every distinct value stated for a field, best first; repeats differing only in case or spacing count once. */
export function distinctValues(
  fields: { fieldName: string; value: string; confidence: number }[],
  name: string,
): string[] {
  const seen = new Set<string>();
  return fields
    .filter((f) => f.fieldName === name)
    .sort((a, b) => b.confidence - a.confidence)
    .map((f) => f.value.trim())
    .filter((v) => {
      const key = v.toLowerCase().replace(/\s+/g, ' ');
      if (!v || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Inbox applicant name from the best value, manual entries first. Left as is when no field names the applicant. */
export async function refreshApplicantName(submissionId: string, db: Queryable = pool): Promise<void> {
  const name = pickBest(await effectiveFields(submissionId, db), 'applicant_name');
  if (!name) return;
  const n = structureName(name);
  await db.query(
    `UPDATE submissions SET applicant_name=$2, applicant_type=$3, applicant_first_name=$4, applicant_last_name=$5, applicant_entity_name=$6
     WHERE id=$1`,
    [submissionId, name, n.type, n.firstName, n.lastName, n.entityName],
  );
}

export function mapManualField(r: any) {
  return {
    id: r.id,
    fieldName: r.field_name,
    value: r.value,
    note: r.note,
    documentId: r.document_id ?? null,
    createdBy: r.created_by ? { id: r.created_by, name: r.created_by_name ?? '' } : null,
    updatedBy: r.updated_by ? { id: r.updated_by, name: r.updated_by_name ?? '' } : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export const MANUAL_FIELD_SELECT = `SELECT m.*, cu.name AS created_by_name, uu.name AS updated_by_name
  FROM manual_fields m LEFT JOIN users cu ON cu.id=m.created_by LEFT JOIN users uu ON uu.id=m.updated_by`;

export async function addManualFields(
  db: Queryable,
  submissionId: string,
  fields: { fieldName: string; value: string; note?: string | null; documentId?: string | null }[],
  actorId: string,
): Promise<string[]> {
  if (!fields.length) return [];
  // Ids made here so the rows and their audit events are written in one statement each, in the order given.
  const rows = fields.map((f) => ({
    id: randomUUID(),
    field_name: f.fieldName,
    value: f.value,
    note: f.note ?? null,
    document_id: f.documentId ?? null,
  }));
  await db.query(
    `INSERT INTO manual_fields (id, submission_id, field_name, value, note, document_id, created_by)
     SELECT r.id, $1, r.field_name, r.value, r.note, r.document_id, $2
     FROM jsonb_to_recordset($3::jsonb) AS r(id uuid, field_name text, value text, note text, document_id uuid)`,
    [submissionId, actorId, JSON.stringify(rows)],
  );
  // References only: the value and note are applicant data and audit_events is never purged (DB-01).
  await auditMany(
    rows.map((r) => ({
      action: 'MANUAL_FIELD_ADDED',
      entityType: 'manual_field',
      entityId: r.id,
      submissionId,
      actorId,
      details: manualFieldRef(r.field_name, r.value, r.note, r.document_id),
    })),
    db,
  );
  return rows.map((r) => r.id);
}

/** What the audit trail records of a manual value: its field, length, whether it has a note, and its document. */
export function manualFieldRef(fieldName: string, value: string, note: string | null, documentId: string | null) {
  return { fieldName, valueLength: value.length, hasNote: Boolean(note), documentId };
}
