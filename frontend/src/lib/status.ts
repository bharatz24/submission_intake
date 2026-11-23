// Pure helpers mapping domain enums to labels and MUI palette colors.
import { CONFIDENCE_THRESHOLDS, SUBMISSION_CHANCE_WARNING } from '../constants';
import type {
  Classification,
  Decision,
  DuplicateBasis,
  ExtractionStatus,
  LlmCallStatus,
  NameType,
  NpiStatus,
  Recommendation,
  ReportStatus,
  RiskRating,
  SubmissionStatus,
  SubmissionSummary,
} from '../types';

export type ChipColor = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info';

// Stored values whose UI label differs from the value itself.
const LABELS: Record<string, string> = {
  NOT_SUBMISSION: 'Ignored', // kept as NOT_SUBMISSION in the DB, the API and the skills
  DUPLICATE: 'Duplicate',
};

// Compact labels for tight table columns; the chip's tooltip keeps the full label.
const SHORT_LABELS: Record<string, string> = {
  READY_FOR_REVIEW: 'Ready',
  REVIEW_REQUIRED: 'Review',
  PARTIAL_MATCH: 'Partial',
  NOT_VERIFIED: 'Unverified',
};

export const shortLabel = (value: string | null | undefined) => (value && SHORT_LABELS[value]) || humanize(value);

export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  if (LABELS[value]) return LABELS[value];
  return value
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export function submissionStatusColor(s: SubmissionStatus): ChipColor {
  switch (s) {
    case 'NEW':
      return 'info';
    case 'PROCESSING':
      return 'secondary';
    case 'READY_FOR_REVIEW':
      return 'primary';
    case 'IN_REVIEW':
      return 'warning';
    case 'COMPLETED':
      return 'success';
    case 'NOT_SUBMISSION':
      return 'default';
    case 'DUPLICATE':
      return 'default';
    case 'ERROR':
      return 'error';
    default:
      return 'default';
  }
}

/** Why an email was held back as a duplicate, in a few words. */
export function duplicateBasisLabel(b: DuplicateBasis | null | undefined): string {
  if (!b) return '—';
  const similar = b.similarity !== null ? `, ${formatPercent(b.similarity)} similar text` : '';
  switch (b.rule) {
    case 'R1':
      return 'Same message';
    case 'R2':
      return 'Identical content';
    case 'R3':
      return `Same attachments${similar}`;
    case 'R4':
      return 'Same subject, a few words changed';
    case 'R5':
      return 'Attachments already received';
    case 'R7':
      return 'Same text, different subject';
    case 'R8':
      return 'Earlier text with a note added';
    case 'MANUAL':
      return b.reason ? `Marked by hand: ${b.reason}` : 'Marked by hand';
    default:
      return humanize(b.rule);
  }
}

/**
 * The one classification reason that best explains an ignored email: a manual override, else a repeat of an
 * ignored email, else Claude's first reason, else the strongest negative rule signal. Prefixes are dropped.
 */
export function mainClassificationReason(reasons: string[] | null | undefined): string | null {
  if (!reasons?.length) return null;
  const weight = (r: string) => Number(/^([+-]?\d+):/.exec(r)?.[1] ?? 0);
  const strongestNegative = [...reasons].filter((r) => weight(r) < 0).sort((a, b) => weight(a) - weight(b))[0];
  const pick =
    [...reasons].reverse().find((r) => r.startsWith('Manual override')) ??
    reasons.find((r) => r.startsWith('Repeat of an ignored email')) ??
    reasons.find((r) => r.startsWith('LLM:')) ??
    strongestNegative ??
    reasons[0];
  return pick?.replace(/^(?:LLM:|[+-]?\d+:)\s*/, '') ?? null;
}

export function classificationColor(c: Classification | null): ChipColor {
  switch (c) {
    case 'SUBMISSION':
      return 'success';
    case 'NOT_SUBMISSION':
      return 'default';
    case 'REVIEW_REQUIRED':
      return 'warning';
    default:
      return 'default';
  }
}

export function npiStatusColor(s: NpiStatus | null): ChipColor {
  switch (s) {
    case 'MATCH':
      return 'success';
    case 'PARTIAL_MATCH':
      return 'warning';
    case 'MISMATCH':
      return 'error';
    case 'NOT_FOUND':
      return 'error';
    case 'NOT_VERIFIED':
      return 'warning';
    case 'ERROR':
      return 'default';
    default:
      return 'default';
  }
}

export function nameTypeLabel(t: NameType | null | undefined): string | null {
  switch (t) {
    case 'INDIVIDUAL':
      return 'Individual';
    case 'ORGANIZATION':
      return 'Organization';
    default:
      return null;
  }
}

export type ApplicantName = Pick<
  SubmissionSummary,
  'applicantName' | 'applicantType' | 'applicantFirstName' | 'applicantLastName' | 'applicantEntityName'
>;

/** Label/value pairs for the applicant name by type: first + last for individuals, entity name for organizations. */
export function applicantNameFields(
  a: ApplicantName,
  fallbackName?: string | null,
): { label: string; value: string | null }[] {
  switch (a.applicantType) {
    case 'INDIVIDUAL':
      return [
        { label: 'Applicant type', value: 'Individual' },
        { label: 'First name', value: a.applicantFirstName },
        { label: 'Last name', value: a.applicantLastName },
      ];
    case 'ORGANIZATION':
      return [
        { label: 'Applicant type', value: 'Organization' },
        { label: 'Entity name', value: a.applicantEntityName },
      ];
    default:
      return [{ label: 'Name', value: fallbackName ?? a.applicantName }];
  }
}

export function extractionStatusColor(s: ExtractionStatus): ChipColor {
  switch (s) {
    case 'EXTRACTED':
      return 'success';
    case 'OCR_EXTRACTED':
      return 'info';
    case 'PENDING':
      return 'secondary';
    case 'UNREADABLE':
      return 'warning';
    case 'UNSUPPORTED':
      return 'default';
    case 'ERROR':
      return 'error';
    default:
      return 'default';
  }
}

export function reportStatusColor(s: ReportStatus): ChipColor {
  return s === 'COMPLETED' ? 'success' : s === 'FAILED' ? 'error' : 'info';
}

export function riskColor(r: RiskRating | null | undefined): ChipColor {
  switch (r) {
    case 'LOW':
      return 'success';
    case 'MODERATE':
      return 'info';
    case 'ELEVATED':
      return 'warning';
    case 'HIGH':
      return 'error';
    default:
      return 'default';
  }
}

export function levelColor(l: 'HIGH' | 'MEDIUM' | 'LOW' | null | undefined, invert = false): ChipColor {
  // Severity: HIGH is bad (error). Confidence (invert=true): HIGH is good (success).
  if (!l) return 'default';
  if (invert) return l === 'HIGH' ? 'success' : l === 'MEDIUM' ? 'warning' : 'error';
  return l === 'HIGH' ? 'error' : l === 'MEDIUM' ? 'warning' : 'info';
}

export function recommendationColor(r: Recommendation | null | undefined): ChipColor {
  switch (r) {
    case 'PROCEED':
      return 'success';
    case 'PROCEED_WITH_CONDITIONS':
      return 'info';
    case 'REQUEST_INFORMATION':
      return 'warning';
    case 'REFER':
      return 'warning';
    case 'DECLINE':
      return 'error';
    default:
      return 'default';
  }
}

export function decisionColor(d: Decision): ChipColor {
  switch (d) {
    case 'ACCEPT':
      return 'success';
    case 'ACCEPT_WITH_CONDITIONS':
      return 'info';
    case 'REQUEST_INFORMATION':
      return 'warning';
    case 'REFER':
      return 'warning';
    case 'DECLINE':
      return 'error';
    default:
      return 'default';
  }
}

/** 0..1 confidence -> color. */
export function confidenceColor(c: number | null | undefined): ChipColor {
  if (c === null || c === undefined || Number.isNaN(c)) return 'default';
  if (c >= CONFIDENCE_THRESHOLDS.success) return 'success';
  if (c >= CONFIDENCE_THRESHOLDS.warning) return 'warning';
  return 'error';
}

/**
 * Ignored emails: how likely the email was a submission after all, i.e. the classifier's confidence that it was not, inverted.
 * Above 15% (confidence under 85%) is worth a look; the backend already refuses such an Ignore when the email carries
 * submission evidence.
 */
export function submissionChance(classification: string | null, confidence: number | null | undefined): number | null {
  if (
    classification !== 'NOT_SUBMISSION' ||
    confidence === null ||
    confidence === undefined ||
    Number.isNaN(confidence)
  )
    return null;
  return Math.max(0, Math.min(1, 1 - confidence));
}

export const submissionChanceColor = (chance: number | null): ChipColor =>
  chance === null ? 'default' : chance > SUBMISSION_CHANCE_WARNING ? 'warning' : 'default';

export function formatPercent(c: number | null | undefined): string {
  if (c === null || c === undefined || Number.isNaN(c)) return '—';
  return `${Math.round(c * 100)}%`;
}

export function llmCallStatusColor(s: LlmCallStatus): ChipColor {
  return s === 'SUCCESS' ? 'success' : s === 'ERROR' ? 'error' : 'warning';
}

/** Compact token count: 950, 12.3k, 1.2M. Values that would round to "1000k" roll over to "1M". */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—';
  const compact = (v: number, unit: string) => `${v.toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (n < 1000) return String(Math.round(n));
  if (n < 999_950) return compact(n / 1000, 'k');
  return compact(n / 1_000_000, 'M');
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Every date is shown US style, mm/dd/yyyy, whatever the browser's locale.
const US_DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
const US_TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: true };

/** "10/30/2026 03:12 PM": the date and time, for narrow columns. */
export function formatShortDateTime(iso: string | null | undefined): string {
  return formatDateTime(iso);
}

/** "10/30/2026 03:12 PM". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString('en-US', US_DATE)} ${d.toLocaleTimeString('en-US', US_TIME)}`;
}

/** A calendar date ("2026-12-01", or an ISO timestamp) as "12/01/2026"; a date-only value is not shifted by time zone. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-US', US_DATE);
}

// ISO dates inside generated text (reports, email drafts, chat). Not when glued to a word, a hyphen or an underscore,
// so file names ("loss_run_2026-01-05.pdf") and ids are left alone.
const ISO_TIMESTAMP_IN_TEXT =
  /(?<![\w-])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?(?![\w-])/g;
const ISO_DATE_IN_TEXT = /(?<![\w-])(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?![\w-])/g;

/** Rewrites ISO dates in free text as mm/dd/yyyy (timestamps as mm/dd/yyyy hh:mm AM/PM). */
export function usDates(text: string): string {
  return text
    .replace(ISO_TIMESTAMP_IN_TEXT, (m) => formatDateTime(m))
    .replace(ISO_DATE_IN_TEXT, (_m, y: string, mo: string, d: string) => `${mo}/${d}/${y}`);
}

/** usDates on every string inside a JSON value (a report's content, an email draft). */
export function usDatesDeep<T>(value: T): T {
  if (typeof value === 'string') return usDates(value) as T;
  if (Array.isArray(value)) return value.map((v) => usDatesDeep(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, usDatesDeep(v)])) as T;
  }
  return value;
}

/** "12/01/2026" -> "2026-12-01"; null unless it is a real date. */
export function parseUsDate(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return d.getUTCMonth() === Number(mm) - 1 && d.getUTCDate() === Number(dd) ? `${yyyy}-${mm}-${dd}` : null;
}

export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  if (abs < 60) return diff >= 0 ? 'just now' : 'in <1m';
  if (abs < 3600) return `${Math.floor(abs / 60)}m ${suffix}`;
  if (abs < 86400) return `${Math.floor(abs / 3600)}h ${suffix}`;
  return `${Math.floor(abs / 86400)}d ${suffix}`;
}
