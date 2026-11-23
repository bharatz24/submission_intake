// Fields table: extracted and manual values together. A manual value supersedes every extracted value with its name.
import type { ExtractedField, ManualField } from '../types';

/** Name suggestions for "Add field" (mirrors FIELD_NAMES in backend services/fieldExtraction.ts). Any name is accepted. */
export const FIELD_SUGGESTIONS = [
  'applicant_name',
  'npi',
  'practice_name',
  'contact_name',
  'contact_email',
  'contact_phone',
  'mailing_address',
  'years_in_practice',
  'board_certification',
  'practice_location',
  'practice_zip',
  'practice_county',
  'practice_state',
  'specialty',
  'surgery_type',
  'procedures',
  'patient_volume',
  'coverage_type',
  'effective_date',
  'expiration_date',
  'retroactive_date',
  'requested_limits',
  'retro_limit',
  'defense_costs',
  'deductible',
  'prior_carrier',
  'expiring_premium',
  'base_premium',
  'claims_made_factor',
  'limit_factor',
  'fte_factor',
  'deductible_credit',
  'schedule_credit',
  'schedule_debit',
  'policy_fees',
  'claims_count_5yr',
  'claims_detail',
  'disciplinary_actions',
  'transaction_type',
  'application_form',
  'application_date',
  'claims_count_10yr',
  'loss_run_valuation',
  'prior_coverage_period',
  'prior_limits',
  'provider_type',
  'license',
  'medical_education',
  'training_completion_date',
  'hours_per_week',
  'group_size',
  'entity_ownership',
  'third_party_facility',
  'medical_directorship',
  'risk_management_cme',
  'erp_request',
  'broker_name',
  'broker_email',
] as const;

/** Fields an underwriter needs before quoting; RequiredInfoCard shows which are missing. */
export const REQUIRED_FIELDS = [
  'applicant_name',
  'npi',
  'specialty',
  'practice_state',
  'effective_date',
  'requested_limits',
  'prior_carrier',
  'claims_count_5yr',
] as const;

/** "Practice State" → "practice_state", as the server stores it. */
export const normalizeFieldName = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
export const isValidFieldName = (s: string) => /^[a-z][a-z0-9_]{0,63}$/.test(normalizeFieldName(s));
export const fieldLabel = (name: string) =>
  name
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .replace(/\bnpi\b/i, 'NPI');

export type FieldRow =
  | { kind: 'manual'; fieldName: string; field: ManualField }
  | { kind: 'extracted'; fieldName: string; field: ExtractedField; superseded: boolean };

/** One list sorted by field name; within a name, manual rows come first and extracted rows are marked superseded. */
export function mergeFields(extracted: ExtractedField[], manual: ManualField[]): FieldRow[] {
  const manualNames = new Set(manual.map((m) => m.fieldName));
  const rows: FieldRow[] = [
    ...manual.map((field) => ({ kind: 'manual' as const, fieldName: field.fieldName, field })),
    ...extracted.map((field) => ({
      kind: 'extracted' as const,
      fieldName: field.fieldName,
      field,
      superseded: manualNames.has(field.fieldName),
    })),
  ];
  return rows.sort(
    (a, b) => a.fieldName.localeCompare(b.fieldName) || (a.kind === b.kind ? 0 : a.kind === 'manual' ? -1 : 1),
  );
}

/** The value in effect for a field: the newest manual entry, else the most confident extracted value. */
export function effectiveValue(
  name: string,
  extracted: ExtractedField[],
  manual: ManualField[],
): { value: string; manual: boolean } | null {
  const m = manual.filter((f) => f.fieldName === name).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (m) return { value: m.value, manual: true };
  const e = extracted.filter((f) => f.fieldName === name).sort((a, b) => b.confidence - a.confidence)[0];
  return e ? { value: e.value, manual: false } : null;
}
