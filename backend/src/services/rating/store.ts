// Saved quotes in the rating structure (STRUCTURE.md): single_rating + child rows, Coverage_fees and
// submissions.primary_rating_id. Read back into the same Quote shape the API has always returned.
import type pg from 'pg';

import { pool, withTransaction } from '../../db/pool.js';
import { notFound } from '../../http.js';
import { type PricingResult, round2, round4 } from './calc.js';
import type { RatingInputs } from './inputs.js';
import type { QuoteFactors, QuoteResult } from './quote.js';
import { MANUAL_CODE } from './tables.js';

type Queryable = Pick<pg.PoolClient, 'query'>;

const isDeductible = (type: string | null | undefined) => /deductible/i.test(type ?? '');

/** "1 Year", "N Years", or "Mature" when the step-up table has no row for the retro years. */
export function retroYearLabel(retroYears: number, stepUpYear: number | undefined): string {
  if (stepUpYear !== undefined && stepUpYear < retroYears) return 'Mature';
  return retroYears === 1 ? '1 Year' : `${retroYears} Years`;
}

async function insertRows(db: Queryable, table: string, cols: string[], rows: unknown[][]) {
  if (!rows.length) return;
  const values = rows.map((_, i) => `(${cols.map((__, j) => `$${i * cols.length + j + 1}`).join(', ')})`);
  await db.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values.join(', ')}`, rows.flat());
}

/** The quote fields saved with a rating: what saveRating stores and what a legacy `quotes` row is converted from. */
export type StoredResult = Pick<
  QuoteResult,
  'status' | 'rateGroup' | 'inputs' | 'factors' | 'pricing' | 'flags' | 'missing'
>;

/** single_rating column values for a result (all but id, submission_id, version, context_version, created_at). */
export function ratingColumns(
  result: StoredResult,
  label: string | null,
  actorId: string | null,
): Record<string, unknown> {
  const f = result.factors;
  const p = result.pricing;
  const credits = f.scheduledCredits ?? [];
  const deductibleIdx = credits.findIndex((c) => isDeductible(c.type));
  const creditAmount = (i: number) => p?.scheduled[i]?.amount ?? null;
  const totalCreditPct = credits.reduce((s, c) => s + c.percent, 0);

  const r: Record<string, unknown> = {
    title: label,
    status: result.status,
    rate_group: result.rateGroup,
    location: f.location?.state ?? f.state?.state ?? result.inputs.state?.toUpperCase() ?? null,
    county: f.location?.county ?? null,
    zipcode: f.location?.zip ?? null,
    city: f.location?.city ?? null,
    county_source: f.location?.countySource ?? null,
    defense: f.state?.defense ?? null,
    hourseperweek: result.inputs.hoursPerWeek ?? null,
    effective_date: f.dates?.effectiveDate ?? null,
    expired_date: f.dates?.expirationDate ?? null,
    retrodate: f.dates?.retroDate ?? null,
    retro_years: f.dates?.retroYears ?? null,
    retroyear: f.dates ? retroYearLabel(f.dates.retroYears, f.dates.stepUpYear) : null,
    pickhighest: result.inputs.pickHighest ?? false,
    baseratevalue: f.state?.baseRate ?? null,
    domicile_tax_rate: f.state?.domicileTaxRate ?? null,
    state_tax_rate: f.state?.stateTaxRate ?? null,
    specialityfactor: f.speciality ?? null,
    territory: f.territory?.territory ?? null,
    territory_matched: f.territory?.matched ?? null,
    territoryfactor: f.territory?.factor ?? null,
    setupfactor: f.stepUp ?? null,
    setupfactorlable: f.dates?.stepUpYear !== undefined && f.stepUp !== undefined ? String(f.dates.stepUpYear) : null,
    hours_worked_key: f.fte?.key ?? null,
    hours_worked_title: f.fte?.title ?? null,
    parttime_fulltime_factor: f.fte?.factor ?? null,
    limit_key: f.limits?.key ?? null,
    incident_limit: f.limits?.incidentLimit ?? null,
    aggregate_limit: f.limits?.aggregateLimit ?? null,
    limits_factor: f.limits?.factor ?? null,
    basemodifiertotal: p?.baseModifierTotal ?? null,
    scheduledpremium: p?.scheduledPremium ?? null,
    totalschedulecreditdebit: p ? totalCreditPct : null,
    totalschedulecreditdebitamount: p ? round2(p.scheduled.reduce((s, c) => s + c.amount, 0)) : null,
    credittotal_percentage: result.inputs.uwCreditPercent ?? 0,
    underwritercreditdebitamount: p?.uwCredit.amount ?? null,
    creditdebitpercentagetotal: p ? p.uwCredit.percent + totalCreditPct : null,
    credittotal: p?.creditTotal ?? null,
    premium: p?.premium ?? null,
    deductible: deductibleIdx >= 0 ? creditAmount(deductibleIdx) : null,
    deductiblelable: f.deductible || null,
    policy_fees_total: p?.policyFeesTotal ?? null,
    rating_fees_total: p?.ratingFeesTotal ?? null,
    feestotal: p?.feesTotal ?? null,
    tax_total: p?.taxTotal ?? null,
    total: p?.total ?? null,
    combine_total: p?.combineTotal ?? null,
    inputs: JSON.stringify(result.inputs),
    flags: result.flags,
    missing: result.missing,
    created_by: actorId,
    policy_fees_stored: true,
  };
  return r;
}

/** The child rows of a rating (specialities, credits/debits, rating fees, taxes, its policy fees). */
export async function insertRatingChildren(db: Queryable, id: string, result: StoredResult): Promise<void> {
  const f = result.factors;
  const p = result.pricing;
  const credits = f.scheduledCredits ?? [];
  const creditAmount = (i: number) => p?.scheduled[i]?.amount ?? null;
  await insertRows(
    db,
    'specialities',
    [
      'singlerating_id',
      'sort_order',
      'code',
      'title',
      'requested',
      'surgery_type',
      'location',
      'factor',
      'class',
      'selectedclass',
      'practice_percentage',
      'matched_from',
    ],
    (f.specialities ?? []).map((s, i) => [
      id,
      i,
      s.code,
      s.title,
      s.requested,
      s.surgeryType,
      s.factorState,
      round4((s.practicePercent / 100) * s.specialityClass),
      s.specialityClass,
      s.specialityClass,
      s.practicePercent,
      s.matchedFrom,
    ]),
  );
  await insertRows(
    db,
    'ScheduledCreditsDebits',
    ['singlerating', 'sort_order', 'key', 'title', 'type', 'credit', 'amount', 'deductiblelable'],
    credits.map((c, i) => [id, i, c.key, c.title, c.type, c.percent, creditAmount(i), c.deductibleLabel || null]),
  );
  await insertRows(
    db,
    'single_rating_fees',
    [
      'rating_id',
      'sort_order',
      'key',
      'lable',
      'calculate',
      'value',
      'state',
      'percentageofcalculatedpremium',
      'percentageofearn',
      'required',
    ],
    (f.ratingFees ?? []).map((fee, i) => [
      id,
      i,
      fee.key,
      fee.title,
      fee.calculate,
      fee.calculate ? (p?.ratingFees[i]?.amount ?? null) : fee.amount,
      fee.state ?? null,
      fee.calculate ? fee.amount : null,
      fee.earnPercent ?? null,
      fee.required,
    ]),
  );
  await insertRows(
    db,
    'single_rating_tax',
    ['rating_id', 'sort_order', 'lable', 'rate', 'value'],
    (p?.taxes ?? []).map((t, i) => [id, i, t.label, t.rate, t.amount]),
  );
  // The policy fees this rating was priced with, so an old version still shows its own fees after the submission's change.
  await insertRows(
    db,
    'single_rating_policy_fees',
    ['rating_id', 'sort_order', 'key', 'title', 'amount', 'percentageofearn'],
    (f.policyFees ?? []).map((pf, i) => [id, i, pf.key, pf.title, pf.amount, pf.earnPercent ?? null]),
  );
}

/** Stores a priced (or INCOMPLETE) result as the submission's next quote version; returns its id and version. */
export async function saveRating(
  db: Queryable,
  submissionId: string,
  label: string | null,
  result: QuoteResult,
  actorId: string | null,
): Promise<{ id: string; version: number }> {
  const r = ratingColumns(result, label, actorId);
  const cols = Object.keys(r);
  const {
    rows: [q],
  } = await db.query<{ id: string; version: number }>(
    `INSERT INTO single_rating (submission_id, version, context_version, ${cols.join(', ')})
     SELECT $1, COALESCE((SELECT max(version) FROM single_rating WHERE submission_id=$1), 0) + 1, s.context_version,
            ${cols.map((_, i) => `$${i + 2}`).join(', ')}
     FROM submissions s WHERE s.id=$1 RETURNING id, version`,
    [submissionId, ...Object.values(r)],
  );
  if (!q) throw notFound('Submission');
  const id = q.id;
  await insertRatingChildren(db, id, result);
  await claimPrimary(db, submissionId, id, result.status);
  return { id, version: q.version };
}

/**
 * The first priced quote becomes the primary rating; an INCOMPLETE one only while there is nothing else.
 * Coverage_fees is the primary rating's set (each rating also keeps its own): only a save that became primary
 * replaces it, and an INCOMPLETE one only fills it while it is empty.
 */
async function claimPrimary(db: Queryable, submissionId: string, id: string, status: QuoteResult['status']) {
  const { rowCount: madePrimary } = await db.query(
    `UPDATE submissions s SET primary_rating_id=$2 WHERE s.id=$1 AND (s.primary_rating_id IS NULL OR ($3 = 'QUOTED' AND EXISTS
       (SELECT 1 FROM single_rating r WHERE r.id = s.primary_rating_id AND r.status = 'INCOMPLETE')))`,
    [submissionId, id, status],
  );
  if (madePrimary) await syncCoverageFees(db, submissionId, id, { onlyIfEmpty: status !== 'QUOTED' });
}

/**
 * Overwrites a saved quote in place with a new result: same id and version, its child rows replaced. Who created it
 * is kept; an automatic quote an underwriter saves over counts as reviewed. When it is the primary rating its fees
 * become the submission's Coverage_fees again; otherwise it can become primary as a new save would.
 * Returns the overwritten quote's version and the totals it had, or null when it is not this submission's.
 */
export async function overwriteRating(
  db: Queryable,
  submissionId: string,
  ratingId: string,
  label: string | null,
  result: QuoteResult,
  actorId: string,
): Promise<{ version: number; before: { status: string; premium: number | null; total: number | null } } | null> {
  const {
    rows: [old],
  } = await db.query<{ version: number; status: string; premium: string | null; total: string | null }>(
    'SELECT version, status, premium, total FROM single_rating WHERE id=$1 AND submission_id=$2 FOR UPDATE',
    [ratingId, submissionId],
  );
  if (!old) return null;
  const r = ratingColumns(result, label, actorId);
  delete r.created_by;
  const cols = Object.keys(r);
  await db.query(
    `UPDATE single_rating SET ${cols.map((c, i) => `${c}=$${i + 3}`).join(', ')},
       reviewed_at=COALESCE(reviewed_at, CASE WHEN created_by IS NULL THEN now() END),
       reviewed_by=COALESCE(reviewed_by, CASE WHEN created_by IS NULL THEN $${cols.length + 3}::uuid END)
     WHERE id=$1 AND submission_id=$2`,
    [ratingId, submissionId, ...Object.values(r), actorId],
  );
  for (const [table, col] of [
    ['specialities', 'singlerating_id'],
    ['ScheduledCreditsDebits', 'singlerating'],
    ['single_rating_fees', 'rating_id'],
    ['single_rating_tax', 'rating_id'],
    ['single_rating_policy_fees', 'rating_id'],
  ])
    await db.query(`DELETE FROM ${table} WHERE ${col}=$1`, [ratingId]);
  await insertRatingChildren(db, ratingId, result);

  const { rowCount: isPrimary } = await db.query('SELECT 1 FROM submissions WHERE id=$1 AND primary_rating_id=$2', [
    submissionId,
    ratingId,
  ]);
  if (isPrimary) await syncCoverageFees(db, submissionId, ratingId, { onlyIfEmpty: result.status !== 'QUOTED' });
  else await claimPrimary(db, submissionId, ratingId, result.status);
  const money = (v: string | null) => (v === null ? null : Number(v));
  return { version: old.version, before: { status: old.status, premium: money(old.premium), total: money(old.total) } };
}

/** Sets Coverage_fees (the submission's current policy fees) to the fees a rating was saved with. */
export async function syncCoverageFees(
  db: Queryable,
  submissionId: string,
  ratingId: string,
  opts: { onlyIfEmpty?: boolean } = {},
): Promise<void> {
  // A rating saved before fees were kept per rating has none of its own: the current set is left as it is.
  const {
    rows: [r],
  } = await db.query('SELECT policy_fees_stored FROM single_rating WHERE id=$1', [ratingId]);
  if (!r?.policy_fees_stored) return;
  if (
    opts.onlyIfEmpty &&
    (await db.query('SELECT 1 FROM Coverage_fees WHERE submission_id=$1 LIMIT 1', [submissionId])).rowCount
  )
    return;
  await db.query('DELETE FROM Coverage_fees WHERE submission_id=$1', [submissionId]);
  await db.query(
    `INSERT INTO Coverage_fees (submission_id, key, title, amount, percentageofearn)
     SELECT $1, key, title, amount, percentageofearn FROM single_rating_policy_fees WHERE rating_id=$2 ORDER BY sort_order`,
    [submissionId, ratingId],
  );
}

export interface SavedQuote {
  id: string;
  version: number;
  label: string | null;
  status: QuoteResult['status'];
  rateGroup: string;
  contextVersion: number;
  isPrimary: boolean;
  inputs: RatingInputs;
  factors: QuoteFactors;
  pricing: PricingResult | null;
  premium: number | null;
  total: number | null;
  flags: string[];
  missing: string[];
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  /** Automatic (createdBy null) and not yet acknowledged by a person. */
  needsReview: boolean;
  reviewedAt: string | null;
  /** The reviewer's name. */
  reviewedBy: string | null;
}

const groupBy = <T extends Record<string, any>>(rows: T[], key: keyof T) => {
  const m = new Map<string, T[]>();
  for (const row of rows) m.set(row[key], [...(m.get(row[key]) ?? []), row]);
  return m;
};
const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));

/** Saved quotes, newest version first. */
export async function loadQuotes(
  where: { submissionId: string } | { id: string },
  db: Queryable = pool,
): Promise<SavedQuote[]> {
  const { rows } = await db.query(
    `SELECT r.*, r.effective_date::text AS effective_date, r.expired_date::text AS expired_date, r.retrodate::text AS retrodate,
            u.name AS created_by_name, rv.name AS reviewed_by_name, (s.primary_rating_id = r.id) AS is_primary
     FROM single_rating r JOIN submissions s ON s.id = r.submission_id LEFT JOIN users u ON u.id = r.created_by
     LEFT JOIN users rv ON rv.id = r.reviewed_by
     WHERE ${'id' in where ? 'r.id' : 'r.submission_id'} = $1 ORDER BY r.version DESC`,
    ['id' in where ? where.id : where.submissionId],
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [specs, credits, fees, taxes, ownPolicyFees, coverage] = await Promise.all([
    db.query('SELECT * FROM specialities WHERE singlerating_id = ANY($1) AND NOT isdelete ORDER BY sort_order', [ids]),
    db.query('SELECT * FROM ScheduledCreditsDebits WHERE singlerating = ANY($1) ORDER BY sort_order', [ids]),
    db.query('SELECT * FROM single_rating_fees WHERE rating_id = ANY($1) ORDER BY sort_order', [ids]),
    db.query('SELECT * FROM single_rating_tax WHERE rating_id = ANY($1) ORDER BY sort_order', [ids]),
    db.query('SELECT * FROM single_rating_policy_fees WHERE rating_id = ANY($1) ORDER BY sort_order', [ids]),
    db.query('SELECT * FROM Coverage_fees WHERE submission_id = ANY($1) ORDER BY id', [
      [...new Set(rows.map((r) => r.submission_id))],
    ]),
  ]);
  const specsBy = groupBy(specs.rows, 'singlerating_id');
  const creditsBy = groupBy(credits.rows, 'singlerating');
  const feesBy = groupBy(fees.rows, 'rating_id');
  const taxesBy = groupBy(taxes.rows, 'rating_id');
  const policyBy = groupBy(ownPolicyFees.rows, 'rating_id');
  const coverageBy = groupBy(coverage.rows, 'submission_id');
  const toFee = (c: any) => ({
    key: c.key,
    title: c.title,
    amount: num(c.amount)!,
    earnPercent: c.percentageofearn ?? undefined,
  });
  return rows.map((r) => {
    // A rating saved before fees were kept per rating (policy_fees_stored false) shows the submission's current fees.
    const policyFees = (
      r.policy_fees_stored ? (policyBy.get(r.id) ?? []) : (coverageBy.get(r.submission_id) ?? [])
    ).map(toFee);
    return toQuote(
      r,
      specsBy.get(r.id) ?? [],
      creditsBy.get(r.id) ?? [],
      feesBy.get(r.id) ?? [],
      taxesBy.get(r.id) ?? [],
      policyFees,
    );
  });
}

/** numeric (money) columns arrive from pg as strings: every one goes through n() here. */
function toQuote(
  r: any,
  specs: any[],
  credits: any[],
  fees: any[],
  taxes: any[],
  policyFees: NonNullable<QuoteFactors['policyFees']>,
): SavedQuote {
  const n = (v: unknown) => (num(v) ?? null) as number;
  const county = r.county?.replace(/\s+county$/i, '').trim() || null;
  const factors: QuoteFactors = {
    location: {
      zip: r.zipcode,
      city: r.city,
      state: r.location,
      county: r.county,
      countySource: r.county_source,
    },
    ...(r.baseratevalue !== null && {
      state: {
        state: r.location,
        baseRate: r.baseratevalue,
        domicileTaxRate: r.domicile_tax_rate,
        stateTaxRate: r.state_tax_rate,
        defense: r.defense,
      },
    }),
    ...(r.effective_date && {
      dates: {
        effectiveDate: r.effective_date,
        expirationDate: r.expired_date,
        retroDate: r.retrodate,
        retroYears: r.retro_years,
        ...(r.setupfactorlable ? { stepUpYear: Number(r.setupfactorlable) } : {}),
      },
    }),
    ...(r.setupfactor !== null && { stepUp: r.setupfactor }),
    ...(specs.length > 0 && {
      specialities: specs.map((s) => ({
        requested: s.requested,
        code: s.code,
        title: s.title,
        surgeryType: s.surgery_type,
        specialityClass: s.class,
        practicePercent: s.practice_percentage,
        factorState: s.location,
        matchedFrom: s.matched_from,
        // A manually rated specialty keeps its reason in matched_from ("manual factor: …").
        ...(s.code === MANUAL_CODE && {
          manual: { reason: String(s.matched_from ?? '').replace(/^manual factor: /, '') },
        }),
      })),
    }),
    ...(r.specialityfactor !== null && { speciality: r.specialityfactor }),
    ...(r.territory !== null && {
      territory: { territory: r.territory, factor: r.territoryfactor, county, matched: r.territory_matched },
    }),
    ...(r.limit_key !== null && {
      limits: {
        key: r.limit_key,
        incidentLimit: n(r.incident_limit),
        aggregateLimit: n(r.aggregate_limit),
        factor: r.limits_factor,
      },
    }),
    ...(r.hours_worked_key !== null && {
      fte: { key: r.hours_worked_key, title: r.hours_worked_title, factor: r.parttime_fulltime_factor },
    }),
    scheduledCredits: credits.map((c) => ({
      key: c.key,
      title: c.title,
      percent: c.credit,
      type: c.type,
      deductibleLabel: c.deductiblelable ?? '',
    })),
    deductible: r.deductiblelable,
    ratingFees: fees.map((fe) => ({
      key: fe.key,
      title: fe.lable,
      calculate: fe.calculate,
      amount: fe.calculate ? fe.percentageofcalculatedpremium : n(fe.value),
      required: fe.required,
      state: fe.state ?? undefined,
      earnPercent: fe.percentageofearn ?? undefined,
    })),
    policyFees,
  };

  const pricing: PricingResult | null =
    r.status === 'QUOTED'
      ? {
          baseModifierTotal: r.basemodifiertotal,
          scheduledPremium: n(r.scheduledpremium),
          scheduled: credits.map((c) => ({ title: c.title, percent: c.credit, amount: n(c.amount) })),
          uwCredit: { percent: r.credittotal_percentage, amount: n(r.underwritercreditdebitamount) },
          creditTotal: n(r.credittotal),
          premium: n(r.premium),
          ratingFees: fees.map((fe) => ({ title: fe.lable, amount: n(fe.value) })),
          ratingFeesTotal: n(r.rating_fees_total),
          taxes: taxes.map((t) => ({ label: t.lable, rate: t.rate, amount: n(t.value) })),
          taxTotal: n(r.tax_total),
          policyFeesTotal: n(r.policy_fees_total),
          feesTotal: n(r.feestotal),
          total: n(r.total),
          combineTotal: n(r.combine_total),
        }
      : null;

  return {
    id: r.id,
    version: r.version,
    label: r.title,
    status: r.status,
    rateGroup: r.rate_group,
    contextVersion: r.context_version,
    isPrimary: Boolean(r.is_primary),
    inputs: r.inputs,
    factors,
    pricing,
    premium: r.premium === null ? null : round2(num(r.premium)!),
    total: r.total === null ? null : round2(num(r.total)!),
    flags: r.flags,
    missing: r.missing,
    createdBy: r.created_by ? { id: r.created_by, name: r.created_by_name ?? '' } : null,
    needsReview: r.created_by === null && !r.reviewed_at,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    reviewedBy: r.reviewed_at ? (r.reviewed_by_name ?? '') : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** Makes a saved quote the submission's primary rating; Coverage_fees follows it. */
export async function setPrimaryRating(submissionId: string, ratingId: string): Promise<boolean> {
  return withTransaction(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE submissions SET primary_rating_id=$2 WHERE id=$1 AND EXISTS (SELECT 1 FROM single_rating WHERE id=$2 AND submission_id=$1)`,
      [submissionId, ratingId],
    );
    if (rowCount) await syncCoverageFees(db, submissionId, ratingId);
    return Boolean(rowCount);
  });
}
