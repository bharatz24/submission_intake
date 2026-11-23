import { z } from 'zod';

import { MANUAL_FACTOR } from '../../constants.js';
import { pool } from '../../db/pool.js';
import { parseLimits } from '../coverage.js';
import { type EffectiveField, effectiveFields } from '../fields.js';
import { ZIP_LOOKUP_SOURCE } from '../zipCounty.js';
import { extractZip, lookupZip, toStateCode } from './geo.js';
import { creditTitles, SURGERY_TYPES, type SurgeryType } from './tables.js';

/**
 * Rating inputs come from the submission's evidence fields (manual entries first, see effectiveFields), with the
 * NPI registry's practice address and taxonomy as a fallback. Nothing here calls Claude: field extraction already
 * did the reading. The underwriter reviews and edits these in the quote dialog before a quote is saved.
 */

/** A real calendar day as yyyy-mm-dd ("2027-02-30" is rejected rather than rolled over or silently defaulted). */
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-mm-dd')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 1900 && y <= 2200;
  }, 'Not a real date');
const key = z.string().max(100);

/** Everything a rating needs. All optional: missing values are reported, never silently priced. Sizes are capped. */
export const ratingInputsSchema = z.object({
  label: z.string().max(200).optional(),
  state: z.string().length(2).optional(),
  city: z.string().max(100).optional(),
  zip: z
    .string()
    .regex(/^\d{5}(-\d{4})?$/)
    .optional(),
  county: z.string().max(100).optional(),
  specialities: z
    .array(
      z
        .object({
          code: z.string().max(50).optional(),
          title: z.string().max(300).optional(),
          practicePercent: z.number().min(0).max(100).optional(),
          surgeryType: z.enum(SURGERY_TYPES).optional(),
          // For a specialty no rate class matches: the factor to rate it with, and why (both shown on the quote).
          manualFactor: z
            .number()
            .min(MANUAL_FACTOR.min, `A manual factor is at least ${MANUAL_FACTOR.min}`)
            .max(MANUAL_FACTOR.max, `A manual factor is at most ${MANUAL_FACTOR.max}`)
            .optional(),
          manualReason: z.string().trim().max(500).optional(),
        })
        .superRefine((s, ctx) => {
          if (s.manualFactor === undefined) return;
          if (!s.manualReason)
            ctx.addIssue({ code: 'custom', path: ['manualReason'], message: 'Give a reason for the manual factor' });
          if (!s.title?.trim())
            ctx.addIssue({ code: 'custom', path: ['title'], message: 'A manually rated specialty needs its name' });
          if (s.code)
            ctx.addIssue({
              code: 'custom',
              path: ['code'],
              message: 'A manual factor replaces the rate class: clear the class code',
            });
        }),
    )
    .max(20)
    .optional(),
  pickHighest: z.boolean().optional(),
  limit: z
    .object({ incident: z.number().positive().max(1e9), aggregate: z.number().positive().max(1e9).optional() })
    .optional(),
  limitKey: key.optional(),
  effectiveDate: isoDay.optional(),
  /** Not stated -> effective date + 1 year. */
  expirationDate: isoDay.optional(),
  /** Not stated -> the quote is INCOMPLETE until it is confirmed (never assumed: that would price step-up year 1). */
  retroDate: isoDay.optional(),
  hoursPerWeek: z.number().min(0).max(168).optional(),
  hoursWorkedKey: key.optional(),
  scheduledCreditKeys: z.array(key).max(50).optional(),
  uwCreditPercent: z.number().min(-100).max(100).optional(),
  optionalFeeKeys: z.array(key).max(50).optional(),
  feeAmounts: z
    .record(key, z.number().min(0).max(1e7))
    .refine((r) => Object.keys(r).length <= 50, 'At most 50 fee amounts')
    .optional(),
});
export type RatingInputs = z.infer<typeof ratingInputsSchema>;

/** Inputs only an underwriter decides; a new quote dialog starts from the latest quote's values for these. */
export const UNDERWRITER_KEYS = [
  'pickHighest',
  'limitKey',
  'hoursWorkedKey',
  'scheduledCreditKeys',
  'uwCreditPercent',
  'optionalFeeKeys',
  'feeAmounts',
] as const;

export interface DerivedInputs {
  inputs: RatingInputs;
  /** Where each value came from, for the reviewer. */
  sources: Record<string, string>;
}

// ---- Parsing field values ----------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Parses mm/dd/yyyy, yyyy-mm-dd, or "January 1, 2027" (anywhere in the text) into yyyy-mm-dd. */
export function toIsoDate(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let y: number, m: number, d: number;
  let match: RegExpExecArray | null;
  if ((match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(raw))) [y, m, d] = [+match[1]!, +match[2]!, +match[3]!];
  else if ((match = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(raw))) {
    [m, d, y] = [+match[1]!, +match[2]!, +match[3]!];
    if (y < 100) y += 2000;
  } else if ((match = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(raw))) {
    m = MONTHS.indexOf(match[1]!.toLowerCase()) + 1;
    [d, y] = [+match[2]!, +match[3]!];
  } else return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (!m || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return date.toISOString().slice(0, 10);
}

const AMOUNT = String.raw`\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|mm|m|mil(?:lion)?)?\b`;
const LIMIT_RE = new RegExp(AMOUNT + String.raw`\s*(?:\/|per|x)\s*` + AMOUNT, 'i');

function toAmount(n: number, unit?: string): number {
  let v = n;
  const u = unit?.toLowerCase();
  if (u === 'k') v *= 1e3;
  else if (u?.startsWith('m')) v *= 1e6;
  else if (v < 100)
    v *= 1e6; // "1/3" means $1M/$3M
  else if (v < 10000) v *= 1e3; // "250/750" means $250K/$750K, "500/1500" $500K/$1.5M
  return Math.round(v);
}

/** "$1M/$3M", "200k/600k", "1/3", "$1,000,000 per claim, $3,000,000 aggregate". */
export function parseLimit(text: string | null | undefined): { incident: number; aggregate: number } | undefined {
  if (!text) return undefined;
  const m = LIMIT_RE.exec(text);
  if (m)
    return {
      incident: toAmount(Number(m[1]!.replace(/,/g, '')), m[2]),
      aggregate: toAmount(Number(m[3]!.replace(/,/g, '')), m[4]),
    };
  const { perClaim, aggregate } = parseLimits(text);
  if (perClaim === null || aggregate === null) return undefined;
  return { incident: toAmount(perClaim), aggregate: toAmount(aggregate) };
}

export function parseSurgeryType(text: string | null | undefined): SurgeryType | undefined {
  if (!text) return undefined;
  if (
    /\bmajor surgery\b/i.test(text) &&
    !/\b(?:no|not|without|does not perform)\s+(?:any\s+)?major surgery/i.test(text)
  ) {
    return 'Major Surgery';
  }
  if (/\bminor (?:surgery|surgical procedures?|procedures?)\b/i.test(text) && !/\bno minor surgery/i.test(text)) {
    return 'Minor Surgery';
  }
  if (/\bno surgery\b|\bnon-?surgical\b|does not perform (?:any )?surgery|\bno surgical\b/i.test(text))
    return 'No Surgery';
  return undefined;
}

/** "32", "30 hours per week", "full time". */
export function parseHoursPerWeek(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const m =
    /^\s*(\d{1,3}(?:\.\d+)?)\s*(?:hours|hrs|hr|h)?\s*(?:(?:per|\/|a|each)\s*(?:week|wk))?\s*$/i.exec(text) ??
    /(\d{1,3}(?:\.\d+)?)\s*(?:hours|hrs|hr)\s*(?:per|\/|a|each)\s*(?:week|wk)/i.exec(text);
  if (m && Number(m[1]) <= 168) return Number(m[1]);
  if (/\bfull[- ]time\b/i.test(text)) return 40;
  return undefined;
}

/** "Family Medicine (70%)", "30% Dermatology", "Internal Medicine 60%, Cardiology 40%". */
export function parseSpecialtyValue(value: string): { title: string; practicePercent?: number }[] {
  const line = value.trim();
  if (!/\d\s*%/.test(line)) return line ? [{ title: line }] : [];
  return line
    .split(/\s*(?:;|,(?![^(]*\))|\band\b)\s*/i)
    .map((p) => {
      const after = /^(.*?)[\s(\-–:]*(\d{1,3}(?:\.\d+)?)\s*%\)?$/.exec(p.trim());
      const before = /^(\d{1,3}(?:\.\d+)?)\s*%\s*(.*)$/.exec(p.trim());
      if (after) return { title: after[1]!.trim(), practicePercent: Number(after[2]) };
      if (before) return { title: before[2]!.trim(), practicePercent: Number(before[1]) };
      return { title: p.trim() };
    })
    .filter((p) => p.title.length > 1);
}

/** "123 Main St, Austin, TX 78701" -> city, state, ZIP. */
export function parseAddress(text: string): { zip?: string; city?: string; state?: string } {
  const addr =
    /([A-Z][A-Za-z.']*(?: [A-Z][A-Za-z.']*){0,3}),[ \t]*([A-Z]{2}|[A-Z][a-z]+(?: [A-Z][a-z]+)?)\.?[ \t]+(\d{5})(?:-\d{4})?\b/.exec(
      text,
    );
  if (addr && toStateCode(addr[2])) return { city: addr[1]!.trim(), state: toStateCode(addr[2]), zip: addr[3] };
  return { zip: extractZip(text) ?? undefined };
}

const NO_RETRO = /\b(none|n\/a|no retro|no prior acts|new to practice|not applicable|same as effective|inception)\b/i;
const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- Fields -> rating inputs -------------------------------------------------------------

/** Best value per field (manual entries carry confidence 1), and every distinct value for list fields. */
function fieldReader(fields: EffectiveField[]) {
  const all = (name: string) => {
    const seen = new Set<string>();
    return fields
      .filter((f) => f.fieldName === name)
      .sort((a, b) => b.confidence - a.confidence)
      .filter((f) => !seen.has(norm(f.value)) && seen.add(norm(f.value)));
  };
  return { best: (name: string) => all(name)[0], all };
}

const label = (f: EffectiveField) => `${f.fieldName} (${f.sourceLabel})`;

/** Rating inputs for a submission from its fields, then the NPI registry; date defaults applied. */
export async function deriveRatingInputs(submissionId: string): Promise<DerivedInputs> {
  const [fields, { rows: npis }] = await Promise.all([
    effectiveFields(submissionId),
    pool.query(
      `SELECT registry_data FROM npi_verifications WHERE submission_id=$1 AND registry_data IS NOT NULL
       ORDER BY (status = 'MATCH') DESC, verified_at DESC LIMIT 1`,
      [submissionId],
    ),
  ]);
  const { best, all } = fieldReader(fields);
  const inputs: RatingInputs = {};
  const sources: Record<string, string> = {};
  const set = <K extends keyof RatingInputs>(key: K, value: RatingInputs[K] | undefined, source: string) => {
    if (value === undefined || inputs[key] !== undefined) return;
    inputs[key] = value;
    sources[key] = source;
  };

  // Location: the stated state/ZIP/county, then the first practice address, then the registry practice address.
  const state = best('practice_state');
  if (state) set('state', toStateCode(state.value), label(state));
  const zip = best('practice_zip');
  if (zip) set('zip', extractZip(zip.value) ?? undefined, label(zip));
  // A county looked up from the ZIP is left to the quote, which looks it up itself and flags a multi-county ZIP.
  const county = all('practice_county').find((f) => f.sourceLabel !== ZIP_LOOKUP_SOURCE);
  if (county) set('county', county.value.replace(/\s+(county|parish)$/i, '').trim() || undefined, label(county));
  const location = all('practice_location').find((l) => {
    const a = parseAddress(l.value);
    return !inputs.state || !a.state || a.state === inputs.state;
  });
  if (location) {
    const a = parseAddress(location.value);
    set('state', a.state, label(location));
    if (a.zip && !inputs.zip) {
      const info = await lookupZip(a.zip);
      if (!info || !inputs.state || info.state === inputs.state) set('zip', a.zip, label(location));
    }
    if (!inputs.state || !a.state || a.state === inputs.state) set('city', a.city, label(location));
  }
  const registry = npis[0]?.registry_data;
  const loc = (registry?.addresses ?? []).find((a: any) => a.address_purpose === 'LOCATION');
  if (loc && (!inputs.state || inputs.state === loc.state)) {
    const regZip = extractZip(String(loc.postal_code ?? '').slice(0, 5)) ?? undefined;
    const cityAgrees = !inputs.city || !loc.city || norm(inputs.city) === norm(loc.city);
    if (cityAgrees) {
      set('state', toStateCode(loc.state), 'NPI registry practice address');
      if (!inputs.zip && regZip) set('zip', regZip, 'NPI registry practice address');
      set(
        'city',
        loc.city
          ? String(loc.city).replace(/\b\w+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
          : undefined,
        'NPI registry practice address',
      );
    }
  }

  // Specialities with their share of practice, and the surgery type.
  const surgeryField = best('surgery_type');
  const procedures = all('procedures');
  const surgeryType =
    parseSurgeryType(surgeryField?.value) ?? parseSurgeryType(procedures.map((p) => p.value).join('\n'));
  const surgerySource = surgeryField && parseSurgeryType(surgeryField.value) ? label(surgeryField) : 'procedures';
  const specialties = all('specialty');
  let list = specialties.flatMap((s) => parseSpecialtyValue(s.value));
  let specialitySource = specialties.map(label).join('; ');
  if (!list.length) {
    const tax = (registry?.taxonomies ?? []).find((t: any) => t.primary) ?? registry?.taxonomies?.[0];
    if (tax?.desc) [list, specialitySource] = [[{ title: tax.desc }], 'NPI registry primary taxonomy'];
  }
  if (list.length) {
    const total = list.reduce((s, p) => s + (p.practicePercent ?? 0), 0);
    const keepPercent = list.length === 1 || Math.abs(total - 100) < 1e-9;
    set(
      'specialities',
      list.map((p) => ({
        title: p.title,
        ...(list.length === 1
          ? { practicePercent: 100 }
          : keepPercent && p.practicePercent !== undefined
            ? { practicePercent: p.practicePercent }
            : {}),
        ...(surgeryType ? { surgeryType } : {}),
      })),
      specialitySource,
    );
    if (surgeryType) sources.surgeryType = surgerySource;
    if (list.length > 1 && !keepPercent) {
      inputs.pickHighest = true;
      sources.pickHighest = 'specialty shares not stated or not totalling 100% - rated on the highest class';
    }
  }

  // Limits, dates and hours.
  const limits = best('requested_limits');
  if (limits) set('limit', parseLimit(limits.value), label(limits));
  const effective = best('effective_date');
  if (effective) set('effectiveDate', toIsoDate(effective.value), label(effective));
  const expiration = best('expiration_date');
  if (expiration) set('expirationDate', toIsoDate(expiration.value), label(expiration));
  const retro = best('retroactive_date');
  if (retro) {
    if (NO_RETRO.test(retro.value) && inputs.effectiveDate)
      set('retroDate', inputs.effectiveDate, `${label(retro)}: no prior acts`);
    else set('retroDate', toIsoDate(retro.value), label(retro));
  }
  const hours = best('hours_per_week');
  if (hours) set('hoursPerWeek', parseHoursPerWeek(hours.value), label(hours));

  // Scheduled credits and deductibles the submission names, matched to the rate table titles.
  const creditFields = ['schedule_credit', 'deductible', 'deductible_credit', 'risk_management_cme'].flatMap((n) =>
    all(n),
  );
  if (creditFields.length) {
    const text = creditFields
      .map((f) => f.value)
      .join('\n')
      .toLowerCase();
    const group = await activeRateGroupOrNull();
    const credits = group
      ? (await creditTitles(group)).filter((c) => c.title && text.includes(c.title.toLowerCase()))
      : [];
    if (credits.length)
      set(
        'scheduledCreditKeys',
        credits.map((c) => c.key),
        creditFields.map(label).join('; '),
      );
  }

  applyDateDefaults(inputs, sources);
  return { inputs, sources };
}

async function activeRateGroupOrNull(): Promise<string | null> {
  const { rows } = await pool.query(
    'SELECT name FROM lookup_rate_groups WHERE is_active ORDER BY imported_at DESC LIMIT 1',
  );
  return rows[0]?.name ?? null;
}

export const DEFAULT_EFFECTIVE_SOURCE = 'default: 1st of next month';
export const DEFAULT_RETRO_SOURCE = 'default: same as effective date';
export const DEFAULT_EXPIRATION_SOURCE = 'default: 1 year after effective date';

/**
 * A blank effective date = the 1st of next month, a blank retro date = the effective date (no prior acts,
 * step-up year 1; the quote is flagged so the underwriter confirms it), a blank expiration date = effective +
 * 1 year. Earlier defaults are recomputed, so they follow a changed effective date.
 */
export function applyDateDefaults(inputs: RatingInputs, sources: Record<string, string>): void {
  for (const k of ['effectiveDate', 'retroDate', 'expirationDate'] as const) {
    if (sources[k]?.startsWith('default')) {
      delete inputs[k];
      delete sources[k];
    }
  }
  let effective = inputs.effectiveDate ? toIsoDate(inputs.effectiveDate) : undefined;
  if (!effective) {
    const now = new Date();
    effective = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    inputs.effectiveDate = effective;
    sources.effectiveDate = DEFAULT_EFFECTIVE_SOURCE;
  }
  if (!inputs.retroDate) {
    inputs.retroDate = effective;
    sources.retroDate = DEFAULT_RETRO_SOURCE;
  }
  // An extracted expiration on/before the effective date is the current policy's, not the new term's.
  const expiration = inputs.expirationDate ? toIsoDate(inputs.expirationDate) : undefined;
  if (expiration && expiration <= effective && sources.expirationDate !== 'underwriter') delete inputs.expirationDate;
  if (!inputs.expirationDate) {
    const [y, m, d] = effective.split('-').map(Number) as [number, number, number];
    inputs.expirationDate = new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10);
    sources.expirationDate = DEFAULT_EXPIRATION_SOURCE;
  }
}
