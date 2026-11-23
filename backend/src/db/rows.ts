/**
 * Row shapes of the SELECTs the API maps to JSON (services/queries.ts and the user routes), so a mapper reads named,
 * typed columns instead of `any` (typescript-standards skill). node-postgres returns timestamps as Date and bigint
 * ids as strings; columns a query may not select are optional.
 */

import type { Grounding } from '../services/grounding.js';

export type Timestamp = Date | string;

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'UNDERWRITER' | 'VIEWER';
  created_at: Timestamp;
  token_version?: number;
  disabled_at?: Timestamp | null;
  password_changed_at?: Timestamp | null;
}

/** A users row with its password hash: read only where a password is checked (modules/auth). */
export interface UserAuthRow extends UserRow {
  password_hash: string;
}

export interface ReportRow {
  id: string;
  kind: 'SYNTHESIS' | 'ANALYSIS';
  version: number;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  context_version: number;
  based_on_report_id: string | null;
  skill_name: string;
  skill_version: string;
  model: string;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Timestamp;
  completed_at: Timestamp | null;
  error: string | null;
  content_json?: unknown;
  content_markdown?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  grounding?: Grounding | null;
  reviewed_at?: Timestamp | null;
  reviewed_by_name?: string | null;
}

export interface AssessmentRow {
  id: string;
  version: number;
  decision: string;
  risk_rating: string;
  notes: string;
  analysis_report_id: string | null;
  context_version: number;
  /** ASSESSMENT_SELECT joins users with an inner join: an assessment always has its author. */
  created_by: string;
  created_by_name: string;
  created_at: Timestamp;
}

export interface AuditRow {
  id: string | number;
  submission_id: string | null;
  actor_type: 'USER' | 'SYSTEM';
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: unknown;
  created_at: Timestamp;
}

export interface NpiRow {
  id: string;
  npi: string | null;
  claimed_name: string | null;
  claimed_state: string | null;
  claimed_specialty: string | null;
  status: string;
  registry_name: string | null;
  registry_taxonomy: string | null;
  registry_state: string | null;
  registry_status: string | null;
  mismatches: string[] | null;
  registry_data: unknown;
  verified_at: Timestamp;
  claimed_type: string | null;
  claimed_first_name: string | null;
  claimed_last_name: string | null;
  claimed_entity_name: string | null;
  registry_type: string | null;
  registry_first_name: string | null;
  registry_last_name: string | null;
  registry_entity_name: string | null;
  source?: string | null;
  added_by?: string | null;
  added_by_name?: string | null;
  note?: string | null;
  auto_status?: string | null;
  override_note?: string | null;
  override_by?: string | null;
  override_by_name?: string | null;
  override_at?: Timestamp | null;
}

/** SUMMARY_SELECT: a submission with its email and the inbox counts. */
export interface SubmissionSummaryRow {
  id: string;
  subject: string;
  from_address: string;
  received_at: Timestamp;
  status: string;
  classification: string | null;
  classification_confidence: number | null;
  classification_reasons: string[] | null;
  applicant_name: string | null;
  applicant_type: string | null;
  applicant_first_name: string | null;
  applicant_last_name: string | null;
  applicant_entity_name: string | null;
  document_count: number;
  npi_status: string | null;
  npi_verified_count?: number | null;
  npi_failed_count?: number | null;
  latest_synthesis_version: number | null;
  latest_analysis_version: number | null;
  assigned_to: string | null;
  assigned_name: string | null;
  context_version: number;
  updated_at: Timestamp;
  is_read?: boolean | null;
  duplicate_of: string | null;
  duplicate_of_subject?: string | null;
  duplicate_basis?: unknown;
  processing_error?: string | null;
  processing_error_detail?: string | null;
  held_for_classification?: boolean | null;
  held_for_import?: boolean | null;
  needs_review?: boolean | null;
  pipeline_progress?: unknown;
}

/** A `GROUP BY key` count query: `SELECT <key>, count(*)::int AS n`. */
export type CountRow = { n: number } & Record<string, unknown>;
