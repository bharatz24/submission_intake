// Pure rating math. See FORMULA.md in this folder.
// The per-speciality factor and the scheduled premium are rounded to 4 dp (the formula's own steps). Every money
// line item is rounded to cents before it is summed, so the stored line items always add up to the stored totals.

/** Half away from zero at `dp` places; toPrecision(15) first strips binary noise (1.005 * 100 = 100.49999999999999). */
function roundAway(n: number, dp: number): number {
  const f = 10 ** dp;
  const a = Math.round(Number((Math.abs(n) * f).toPrecision(15))) / f;
  return n < 0 && a !== 0 ? -a : a;
}
export const round4 = (n: number): number => roundAway(n, 4);
/** Money to cents, half away from zero: the one rounding helper for every amount stored or shown. */
export const round2 = (n: number): number => roundAway(n, 2);

/** 1 + whole years between retro and effective date (months/days dropped), minimum 1. */
export function retroYears(retro: Date, effective: Date): number {
  let years = effective.getUTCFullYear() - retro.getUTCFullYear();
  const beforeAnniversary =
    effective.getUTCMonth() < retro.getUTCMonth() ||
    (effective.getUTCMonth() === retro.getUTCMonth() && effective.getUTCDate() < retro.getUTCDate());
  if (beforeAnniversary) years -= 1;
  return Math.max(1, 1 + Math.max(0, years));
}

/** Value for the year; a year not in the table uses the highest ("Mature") year's value. */
export function stepUpFactor(table: Map<number, number> | undefined, years: number): number {
  if (!table || table.size === 0) return 0;
  return table.get(years) ?? table.get(Math.max(...table.keys()))!;
}

export function specialityFactor(
  specs: { specialityClass: number; practicePercent: number }[],
  pickHighest: boolean,
): number {
  if (specs.length === 0) return 0;
  if (pickHighest) return Math.max(...specs.map((s) => s.specialityClass));
  // A sum of 4-dp values is itself 4-dp; round4 only strips binary float noise (0.8999999999999999).
  return round4(specs.reduce((sum, s) => sum + round4((s.practicePercent / 100) * s.specialityClass), 0));
}

export interface PricingInput {
  baseRate: number;
  specialityFactor: number;
  stepUpFactor: number;
  territoryFactor: number;
  limitsFactor: number;
  fteFactor: number;
  /** percent: credit (negative) or debit (positive) %; amount is used only when percent is null. */
  scheduled: { title: string; percent: number | null; amount?: number }[];
  uwCreditPercent: number;
  /** calculate: amount is a % of premium; otherwise a flat amount. */
  ratingFees: { title: string; calculate: boolean; amount: number }[];
  domicileState: string;
  domicileTaxPercent: number;
  state: string;
  stateTaxPercent: number;
  policyFeesTotal: number;
}

export interface PricingResult {
  baseModifierTotal: number;
  scheduledPremium: number;
  scheduled: { title: string; percent: number | null; amount: number }[];
  uwCredit: { percent: number; amount: number };
  creditTotal: number;
  premium: number;
  ratingFees: { title: string; amount: number }[];
  ratingFeesTotal: number;
  taxes: { label: string; rate: number; amount: number }[];
  taxTotal: number;
  policyFeesTotal: number;
  feesTotal: number;
  /** Used when coverage is not combined: each rating carries the policy fees. */
  total: number;
  /** Used for combined coverage: policy fees are added once across all ratings. */
  combineTotal: number;
}

export class RatingError extends Error {}

export function priceRating(i: PricingInput): PricingResult {
  const baseModifierTotal = i.specialityFactor * i.stepUpFactor * i.territoryFactor * i.limitsFactor * i.fteFactor;
  const scheduledPremium = round4(i.baseRate * baseModifierTotal);

  const combinedPercent = i.uwCreditPercent + i.scheduled.reduce((s, c) => s + (c.percent ?? 0), 0);
  if (combinedPercent < -100) throw new RatingError(`Combined credit ${combinedPercent}% is below -100%`);

  // Each amount in cents first, then sums of cents (round2 again only strips float noise from the sum).
  const sum = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0));
  const scheduled = i.scheduled.map((c) => ({
    title: c.title,
    percent: c.percent,
    amount: round2(c.percent != null ? (c.percent / 100) * scheduledPremium : (c.amount ?? 0)),
  }));
  const uwCredit = { percent: i.uwCreditPercent, amount: round2((i.uwCreditPercent / 100) * scheduledPremium) };
  const creditTotal = sum([uwCredit.amount, ...scheduled.map((c) => c.amount)]);
  const premium = sum([round2(scheduledPremium), creditTotal]);

  const ratingFees = i.ratingFees.map((f) => ({
    title: f.title,
    amount: round2(f.calculate ? (f.amount / 100) * premium : f.amount),
  }));
  const ratingFeesTotal = sum(ratingFees.map((f) => f.amount));

  // Taxes apply to premium only, never to fees.
  const taxes = [
    {
      label: `${i.domicileState} ${i.domicileTaxPercent}% Tax`,
      rate: i.domicileTaxPercent,
      amount: round2((premium * i.domicileTaxPercent) / 100),
    },
    {
      label: `${i.state} ${i.stateTaxPercent}% Tax`,
      rate: i.stateTaxPercent,
      amount: round2((premium * i.stateTaxPercent) / 100),
    },
  ];
  const taxTotal = sum(taxes.map((t) => t.amount));

  const policyFeesTotal = round2(i.policyFeesTotal);
  const feesTotal = sum([policyFeesTotal, ratingFeesTotal]);
  return {
    baseModifierTotal,
    scheduledPremium,
    scheduled,
    uwCredit,
    creditTotal,
    premium,
    ratingFees,
    ratingFeesTotal,
    taxes,
    taxTotal,
    policyFeesTotal,
    feesTotal,
    total: sum([premium, taxTotal, feesTotal]),
    combineTotal: sum([premium, taxTotal, ratingFeesTotal]),
  };
}
