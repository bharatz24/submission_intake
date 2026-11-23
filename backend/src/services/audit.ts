import { pool, type Queryable } from '../db/pool.js';
import { onSystemError } from './alerts.js';
import { scrubText } from './piiScrub.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  submissionId?: string | null;
  actorId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * audit_events is append-only and outlives the retention purge, so its details must never hold applicant data
 * (DB-01): callers store references (field names, ids, counts, lengths, statuses), not values. sanitizeAuditDetails is
 * the safety net under that rule, applied to every event:
 * - keys that by name carry applicant content (field values, file names, email subjects, duplicate evidence words)
 *   are dropped; an array under one of them becomes `<key>Count`.
 * - an `npi` becomes `npiLast4`.
 * - every other string is passed through scrubText (emails, phones, NPIs, SSNs, labelled dates of birth), except
 *   staff emails under `email` (KEEP_VERBATIM).
 * Exported for tests and for the redaction migration's documentation (030_audit_phi_redaction.sql strips the same keys).
 */
export const AUDIT_PHI_KEYS: ReadonlySet<string> = new Set([
  'value',
  'filename',
  'filenames',
  'subject',
  'originalSubject',
  'sharedAttachments',
  'addedWords',
  'removedWords',
  'explanation',
  'evidenceQuote',
  'bodyText',
  'claimedName',
  'claimedState',
  'claimedSpecialty',
]);
/** `attachments` is a count in most events but a list of file names in some: only the list form is dropped. */
const PHI_LIST_KEYS: ReadonlySet<string> = new Set(['attachments']);
/** Kept as they are: staff emails (user accounts, the connected mailbox) under this exact key. */
const KEEP_VERBATIM: ReadonlySet<string> = new Set(['email']);
const MAX_DEPTH = 6;

function sanitizeValue(value: unknown, key: string | null, depth: number): unknown {
  if (typeof value === 'string') return key !== null && KEEP_VERBATIM.has(key) ? value : scrubText(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, null, depth + 1));
  return sanitizeAuditDetails(value as Record<string, unknown>, depth + 1);
}

export function sanitizeAuditDetails(details: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (k === 'npi' && typeof v === 'string') {
      // The applicant's NPI identifies them: its last four digits are enough to tell checks apart in the trail.
      out.npiLast4 = v.replace(/\D/g, '').slice(-4);
      continue;
    }
    if (AUDIT_PHI_KEYS.has(k) || (PHI_LIST_KEYS.has(k) && Array.isArray(v))) {
      if (Array.isArray(v)) out[`${k}Count`] = v.length;
      continue;
    }
    out[k] = sanitizeValue(v, k, depth);
  }
  return out;
}

/** An error as audit details may hold it: the message only (no stack), PII scrubbed, capped. */
export function auditErrorText(err: unknown): string {
  return scrubText(err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** Append an audit event. Actor null => SYSTEM. Details are sanitized (sanitizeAuditDetails) before they are stored. */
export async function audit(input: AuditInput, db: Queryable = pool): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (submission_id, actor_type, actor_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.submissionId ?? null,
      input.actorId ? 'USER' : 'SYSTEM',
      input.actorId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(sanitizeAuditDetails(input.details ?? {})),
    ],
  );
}

/** Several audit events in one INSERT (same sanitizing as audit()). */
export async function auditMany(inputs: AuditInput[], db: Queryable = pool): Promise<void> {
  if (!inputs.length) return;
  const rows = inputs.map((i) => ({
    submission_id: i.submissionId ?? null,
    actor_type: i.actorId ? 'USER' : 'SYSTEM',
    actor_id: i.actorId ?? null,
    action: i.action,
    entity_type: i.entityType,
    entity_id: i.entityId ?? null,
    details: sanitizeAuditDetails(i.details ?? {}),
  }));
  await db.query(
    `INSERT INTO audit_events (submission_id, actor_type, actor_id, action, entity_type, entity_id, details)
     SELECT r.submission_id, r.actor_type, r.actor_id, r.action, r.entity_type, r.entity_id, COALESCE(r.details, '{}'::jsonb)
     FROM jsonb_to_recordset($1::jsonb) AS r(submission_id uuid, actor_type text, actor_id uuid, action text,
          entity_type text, entity_id text, details jsonb)`,
    [JSON.stringify(rows)],
  );
}

export async function recordSystemError(scope: string, err: unknown): Promise<void> {
  // Shown on Monitoring and kept: personal data an error text quotes from a submission is scrubbed first.
  const message = scrubText(err instanceof Error ? err.message : String(err));
  await pool
    .query('INSERT INTO system_errors (scope, message) VALUES ($1, $2)', [scope, message.slice(0, 2000)])
    .catch(() => undefined);
  // Metrics and the optional external alert webhook (alerts.ts); never awaited, never throws.
  void onSystemError(scope, message);
}
