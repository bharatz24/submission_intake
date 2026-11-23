/**
 * Coverage summary derived from extracted fields: picks the best value per field, flags conflicts,
 * computes claims-made year / policy term, and builds a premium worksheet from rating inputs that the
 * submission itself states. No rate tables are applied: missing inputs are reported, never invented.
 */

export interface FieldRow {
  fieldName: string;
  value: string;
  confidence: number;
  evidenceQuote: string | null;
  sourceLabel: string;
}

export interface CoverageValue {
  value: string;
  confidence: number;
  sourceLabel: string;
  evidenceQuote: string | null;
  /** Other distinct values found in other sources. */
  conflicts: string[];
}

export interface WorksheetStep {
  label: string;
  input: string | null; // raw extracted text
  factor: number | null; // multiplier applied (null = not applied)
  amount: number | null; // running premium after this step
  note: string | null;
}

export interface CoverageSummary {
  values: Record<string, CoverageValue | null>;
  lists: Record<string, CoverageValue[]>;
  derived: {
    claimsMadeYear: number | null;
    claimsMadeStep: string | null;
    policyTermDays: number | null;
    limits: { perClaim: number | null; aggregate: number | null };
    retroLimits: { perClaim: number | null; aggregate: number | null };
    deductibleAmount: number | null;
  };
  worksheet: {
    steps: WorksheetStep[];
    ratedPremium: number | null;
    fees: { label: string; amount: number }[];
    totalPremium: number | null;
    missing: string[];
  };
}

const SINGLE = [
  'applicant_name',
  'npi',
  'practice_name',
  'contact_name',
  'contact_email',
  'contact_phone',
  'mailing_address',
  'years_in_practice',
  'board_certification',
  'practice_zip',
  'practice_county',
  'practice_state',
  'surgery_type',
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
  'claims_count_5yr',
  'disciplinary_actions',
  'broker_name',
  'broker_email',
] as const;
const LISTS = ['practice_location', 'specialty', 'procedures', 'claims_detail', 'policy_fees'] as const;

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

function best(rows: FieldRow[]): CoverageValue | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => b.confidence - a.confidence);
  const top = sorted[0]!;
  const conflicts = [
    ...new Set(
      sorted
        .slice(1)
        .map((r) => r.value)
        .filter((v) => norm(v) !== norm(top.value)),
    ),
  ];
  return {
    value: top.value,
    confidence: top.confidence,
    sourceLabel: top.sourceLabel,
    evidenceQuote: top.evidenceQuote,
    conflicts,
  };
}

function distinct(rows: FieldRow[]): CoverageValue[] {
  const byKey = new Map<string, FieldRow[]>();
  for (const r of rows) byKey.set(norm(r.value), [...(byKey.get(norm(r.value)) ?? []), r]);
  return [...byKey.values()].map((g) => best(g)!);
}

// ---- parsing helpers ----

export function parseMoney(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m|mm|million|thousand)?\b/i.exec(v);
  if (!m) return null;
  let n = Number(m[1]!.replace(/,/g, ''));
  const unit = m[2]?.toLowerCase();
  if (unit === 'k' || unit === 'thousand') n *= 1_000;
  if (unit === 'm' || unit === 'mm' || unit === 'million') n *= 1_000_000;
  return Number.isFinite(n) ? n : null;
}

/** "$1,000,000 / $3,000,000", "1M/3M", "$1M per claim, $3M aggregate". */
export function parseLimits(v: string | null | undefined): { perClaim: number | null; aggregate: number | null } {
  if (!v) return { perClaim: null, aggregate: null };
  const parts = [...v.matchAll(/\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|mm|m|million|thousand)?\b/gi)]
    .map((m) => parseMoney(m[0]))
    .filter((n): n is number => n !== null);
  return { perClaim: parts[0] ?? null, aggregate: parts[1] ?? null };
}

/** "10%" -> 0.10, "0.10" -> 0.10, "10" -> 0.10. */
export function parsePercent(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /(-?\d+(?:\.\d+)?)\s*(%)?/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] || n > 1 ? n / 100 : n;
}

/** "0.5", "50%", "0.5 FTE" -> 0.5. */
export function parseFactor(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /(\d+(?:\.\d+)?)\s*(%)?/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] ? n / 100 : n;
}

export function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(v);
  const us = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
  const d = iso
    ? new Date(Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!))
    : us
      ? new Date(Date.UTC(+us[3]!, +us[1]! - 1, +us[2]!))
      : new Date(`${v} UTC`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const NO_RETRO = /\b(none|n\/a|no retro|no prior acts|not applicable|same as effective)\b/i;

/**
 * Claims-made year = full years between retro date and effective date + 1.
 * Retro "None" (or equal to effective) is year 1; year 5+ is mature.
 */
export function claimsMadeYear(effective: string | null | undefined, retro: string | null | undefined): number | null {
  const eff = parseDate(effective);
  if (!eff) return null;
  if (!retro || NO_RETRO.test(retro)) return retro ? 1 : null;
  const r = parseDate(retro);
  if (!r) return null;
  if (r > eff) return 1;
  let years = eff.getUTCFullYear() - r.getUTCFullYear();
  if (
    eff.getUTCMonth() < r.getUTCMonth() ||
    (eff.getUTCMonth() === r.getUTCMonth() && eff.getUTCDate() < r.getUTCDate())
  )
    years--;
  return years + 1;
}

export function buildCoverage(rows: FieldRow[]): CoverageSummary {
  const by = (name: string) => rows.filter((r) => r.fieldName === name);
  const values = Object.fromEntries(SINGLE.map((n) => [n, best(by(n))])) as Record<string, CoverageValue | null>;
  const lists = Object.fromEntries(LISTS.map((n) => [n, distinct(by(n))])) as Record<string, CoverageValue[]>;
  const v = (n: string) => values[n]?.value ?? null;

  const year = claimsMadeYear(v('effective_date'), v('retroactive_date'));
  const eff = parseDate(v('effective_date'));
  const exp = parseDate(v('expiration_date'));

  // ---- premium worksheet ----
  const missing: string[] = [];
  const steps: WorksheetStep[] = [];
  const base = parseMoney(v('base_premium'));
  let running: number | null = base;
  steps.push({
    label: 'Base premium',
    input: v('base_premium'),
    factor: null,
    amount: base,
    note: base === null ? 'Not stated in submission' : null,
  });
  if (base === null) missing.push('base_premium');

  const factorStep = (label: string, field: string, f: number | null, note?: string) => {
    if (f === null) {
      steps.push({ label, input: v(field), factor: null, amount: running, note: note ?? 'Not stated; not applied' });
      return;
    }
    running = running === null ? null : running * f;
    steps.push({ label, input: v(field), factor: f, amount: running, note: note ?? null });
  };
  factorStep(
    'Claims-made step factor',
    'claims_made_factor',
    parseFactor(v('claims_made_factor')),
    year ? `Claims-made year ${year}${year >= 5 ? ' (mature)' : ''}` : undefined,
  );
  factorStep('Increased limits factor', 'limit_factor', parseFactor(v('limit_factor')));
  factorStep('FTE factor', 'fte_factor', parseFactor(v('fte_factor')));
  const dedCredit = parsePercent(v('deductible_credit'));
  factorStep(
    'Deductible credit',
    'deductible_credit',
    dedCredit === null ? null : 1 - dedCredit,
    dedCredit === null && v('deductible') ? `Deductible ${v('deductible')} stated but no credit %` : undefined,
  );
  const credit = parsePercent(v('schedule_credit')) ?? 0;
  const debit = parsePercent(v('schedule_debit')) ?? 0;
  const hasSchedule = values.schedule_credit || values.schedule_debit;
  factorStep(
    'Schedule credit / debit',
    values.schedule_credit ? 'schedule_credit' : 'schedule_debit',
    hasSchedule ? 1 + debit - credit : null,
    hasSchedule
      ? `${debit ? `+${(debit * 100).toFixed(1)}% debit` : ''}${debit && credit ? ' ' : ''}${credit ? `−${(credit * 100).toFixed(1)}% credit` : ''}`
      : undefined,
  );
  if (!values.fte_factor) missing.push('fte_factor');

  const ratedPremium = running === null ? null : Math.round(running * 100) / 100;
  const fees = (lists.policy_fees ?? [])
    .map((f) => ({
      label:
        f.value
          .replace(/\$?\s*[\d,]+(\.\d+)?/, '')
          .replace(/[:\-–]\s*$/, '')
          .trim() || 'Fee',
      amount: parseMoney(f.value),
    }))
    .filter((f): f is { label: string; amount: number } => f.amount !== null);
  const totalPremium =
    ratedPremium === null ? null : Math.round((ratedPremium + fees.reduce((a, f) => a + f.amount, 0)) * 100) / 100;

  return {
    values,
    lists,
    derived: {
      claimsMadeYear: year,
      claimsMadeStep: year === null ? null : year >= 5 ? `Year ${year} (mature)` : `Year ${year} of 5`,
      policyTermDays: eff && exp ? Math.round((exp.getTime() - eff.getTime()) / 86_400_000) : null,
      limits: parseLimits(v('requested_limits')),
      retroLimits: parseLimits(v('retro_limit')),
      deductibleAmount: parseMoney(v('deductible')),
    },
    worksheet: { steps, ratedPremium, fees, totalPremium, missing },
  };
}
