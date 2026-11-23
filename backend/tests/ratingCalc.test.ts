import { describe, expect, it } from 'vitest';

import {
  priceRating,
  type PricingInput,
  retroYears,
  round2,
  specialityFactor,
  stepUpFactor,
} from '../src/services/rating/calc.js';
import {
  parseHoursPerWeek,
  parseLimit,
  parseSpecialtyValue,
  parseSurgeryType,
  ratingInputsSchema,
  toIsoDate,
} from '../src/services/rating/inputs.js';
import { calculateQuote } from '../src/services/rating/quote.js';
import type { RateContext } from '../src/services/rating/tables.js';

const base: PricingInput = {
  baseRate: 10000,
  specialityFactor: 1.2,
  stepUpFactor: 0.8,
  territoryFactor: 1.1,
  limitsFactor: 1,
  fteFactor: 1,
  scheduled: [{ title: 'Scheduled credit', percent: -10 }],
  uwCreditPercent: 5,
  ratingFees: [
    { title: 'Calculated 2%', calculate: true, amount: 2 },
    { title: 'Flat', calculate: false, amount: 50 },
  ],
  domicileState: 'NC',
  domicileTaxPercent: 1,
  state: 'TX',
  stateTaxPercent: 2.5,
  policyFeesTotal: 150,
};

describe('rating formula', () => {
  it('matches the worked example (not combined)', () => {
    const r = priceRating(base);
    expect(round2(r.baseModifierTotal * 1000) / 1000).toBe(1.056);
    expect(r.scheduledPremium).toBe(10560);
    expect(round2(r.creditTotal)).toBe(-528);
    expect(round2(r.premium)).toBe(10032);
    expect(round2(r.ratingFeesTotal)).toBe(250.64);
    expect(round2(r.taxTotal)).toBe(351.12);
    expect(round2(r.total)).toBe(10783.76);
    expect(round2(r.combineTotal)).toBe(10633.76);
  });

  it('counts step-up years from retro to effective (2y 11m is year 3; retro after effective is 1)', () => {
    expect(retroYears(new Date('2024-11-01'), new Date('2026-01-01'))).toBe(2);
    expect(retroYears(new Date('2023-02-01'), new Date('2026-01-01'))).toBe(3);
    expect(retroYears(new Date('2027-01-01'), new Date('2026-01-01'))).toBe(1);
    expect(retroYears(new Date('2026-01-01'), new Date('2026-01-01'))).toBe(1);
  });

  it('uses the mature (highest) step-up year beyond the table', () => {
    const t = new Map([
      [1, 0.35],
      [2, 0.6],
      [5, 1],
    ]);
    expect(stepUpFactor(t, 2)).toBe(0.6);
    expect(stepUpFactor(t, 9)).toBe(1);
  });

  it('mixes specialities as the sum of round4(practice% x class); pick highest ignores %', () => {
    const specs = [
      { specialityClass: 1.138, practicePercent: 60 },
      { specialityClass: 1.52, practicePercent: 40 },
    ];
    expect(specialityFactor(specs, false)).toBe(1.2908);
    expect(specialityFactor(specs, true)).toBe(1.52);
  });

  it('applies a part-time FTE factor and a zero factor', () => {
    expect(round2(priceRating({ ...base, fteFactor: 0.6, scheduled: [], uwCreditPercent: 0 }).premium)).toBe(6336);
    expect(priceRating({ ...base, territoryFactor: 0 }).premium).toBe(0);
  });

  it('rejects a combined credit below -100%', () => {
    expect(() => priceRating({ ...base, uwCreditPercent: -95, scheduled: [{ title: 'x', percent: -10 }] })).toThrow();
  });
});

describe('money rounding', () => {
  it('rounds half away from zero, without binary noise', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0.125)).toBe(0.13);
    expect(round2(-0.004)).toBe(0);
    expect(Object.is(round2(-0.004), -0)).toBe(false);
    expect(round2(10032.005)).toBe(10032.01);
  });

  it('stores every amount in cents and the line items add up to the totals', () => {
    const cents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
    const r = priceRating({
      ...base,
      baseRate: 9876.54,
      specialityFactor: 1.2908,
      stepUpFactor: 0.65,
      territoryFactor: 1.137,
      scheduled: [
        { title: 'a', percent: -7.5 },
        { title: 'b', percent: 3.33 },
      ],
      uwCreditPercent: -4.25,
      ratingFees: [
        { title: 'pct', calculate: true, amount: 1.75 },
        { title: 'flat', calculate: false, amount: 33.333 },
      ],
      domicileTaxPercent: 1.1,
      stateTaxPercent: 4.85,
      policyFeesTotal: 99.995,
    });
    const amounts = [
      r.premium,
      r.creditTotal,
      r.uwCredit.amount,
      r.ratingFeesTotal,
      r.taxTotal,
      r.policyFeesTotal,
      r.feesTotal,
      r.total,
      r.combineTotal,
      ...r.scheduled.map((c) => c.amount),
      ...r.ratingFees.map((f) => f.amount),
      ...r.taxes.map((t) => t.amount),
    ];
    for (const a of amounts) expect(cents(a)).toBe(true);
    const sum = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0));
    expect(r.creditTotal).toBe(sum([r.uwCredit.amount, ...r.scheduled.map((c) => c.amount)]));
    expect(r.premium).toBe(sum([round2(r.scheduledPremium), r.creditTotal]));
    expect(r.ratingFeesTotal).toBe(sum(r.ratingFees.map((f) => f.amount)));
    expect(r.taxTotal).toBe(sum(r.taxes.map((t) => t.amount)));
    expect(r.feesTotal).toBe(sum([r.policyFeesTotal, r.ratingFeesTotal]));
    expect(r.total).toBe(sum([r.premium, r.taxTotal, r.feesTotal]));
    expect(r.combineTotal).toBe(sum([r.premium, r.taxTotal, r.ratingFeesTotal]));
    expect(r.ratingFees[1]!.amount).toBe(33.33);
    expect(r.policyFeesTotal).toBe(100);
  });
});

/** A one-state rate context; override any table to test bad rate data. */
function ctx(over: Partial<RateContext> = {}): RateContext {
  return {
    rateGroup: 'test',
    stateCode: 'TX',
    ratedStates: ['TX'],
    state: { state: 'TX', baseRate: 10000, domicileTaxRate: 1, stateTaxRate: 2.5, defense: 'Inside', key: 'TX' },
    stepUp: new Map([
      [1, 0.5],
      [2, 0.8],
    ]),
    territories: [
      { id: 1, state: 'TX', territory: 1, factor: 1.1, counties: ['Travis'], isRemainder: true, key: 'T1' },
    ],
    limits: [{ state: 'TX', factor: 1, incidentLimit: 1e6, aggregateLimit: 3e6, isDefault: true, key: 'L1' }],
    specialityFactors: [
      {
        code: '80268',
        title: 'Internal Medicine',
        state: 'TX',
        surgeryType: 'No Surgery',
        factor: 1.2,
        abbreviation: 'IM',
      },
    ],
    hours: [{ title: '0-40', factor: 1, type: '', isDefault: true, key: 'H1', maxHours: Infinity }],
    credits: [],
    ratingFees: [],
    policyFees: [{ title: 'Policy fee', amount: 150.005, required: true, key: 'P1' }],
    ...over,
  };
}
const inputs = {
  state: 'TX',
  county: 'Travis',
  specialities: [{ code: '80268', practicePercent: 100 }],
  effectiveDate: '2027-01-01',
  retroDate: '2027-01-01',
};

describe('calculateQuote with bad rate data', () => {
  it('prices good data', () => {
    const q = calculateQuote(inputs, ctx());
    expect(q.status).toBe('QUOTED');
    expect(q.factors.policyFees![0]!.amount).toBe(150.01);
    expect(q.summary!.premium).toBe(6600);
  });

  it('treats a zero, negative or NaN base rate or factor as missing, never a $0 QUOTED premium', () => {
    const c = ctx();
    const bad: Partial<RateContext>[] = [
      { state: { ...c.state!, baseRate: 0 } },
      { stepUp: new Map([[1, 0]]) },
      { territories: [{ ...c.territories[0]!, factor: 0 }] },
      { limits: [{ ...c.limits[0]!, factor: -1 }] },
      { hours: [{ ...c.hours[0]!, factor: Number.NaN }] },
      { specialityFactors: [{ ...c.specialityFactors[0]!, factor: 0 }] },
    ];
    for (const over of bad) {
      const q = calculateQuote(inputs, ctx(over));
      expect(q.status, JSON.stringify(over)).toBe('INCOMPLETE');
      expect(q.pricing).toBeNull();
      expect(q.missing.length).toBeGreaterThan(0);
    }
  });

  it('never rolls an impossible date over to the next month', () => {
    const q = calculateQuote({ ...inputs, effectiveDate: '2027-02-30' }, ctx());
    expect(q.factors.dates!.effectiveDate).not.toBe('2027-03-02');
    expect(q.flags.some((f) => f.startsWith('Effective date not stated'))).toBe(true);
  });
});

describe('quote input limits', () => {
  it('rejects impossible or malformed dates and accepts real ones', () => {
    expect(ratingInputsSchema.safeParse({ effectiveDate: '2027-02-28' }).success).toBe(true);
    expect(ratingInputsSchema.safeParse({ effectiveDate: '2028-02-29' }).success).toBe(true);
    expect(ratingInputsSchema.safeParse({ effectiveDate: '2027-02-30' }).success).toBe(false);
    expect(ratingInputsSchema.safeParse({ retroDate: '01/01/2027' }).success).toBe(false);
    expect(ratingInputsSchema.safeParse({ expirationDate: '2027-1-1' }).success).toBe(false);
  });

  it('caps string lengths and list sizes', () => {
    expect(ratingInputsSchema.safeParse({ county: 'x'.repeat(101) }).success).toBe(false);
    expect(
      ratingInputsSchema.safeParse({ specialities: Array.from({ length: 21 }, () => ({ title: 'IM' })) }).success,
    ).toBe(false);
    expect(
      ratingInputsSchema.safeParse({ scheduledCreditKeys: Array.from({ length: 51 }, (_, i) => `k${i}`) }).success,
    ).toBe(false);
    expect(
      ratingInputsSchema.safeParse({
        feeAmounts: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 1])),
      }).success,
    ).toBe(false);
    expect(
      ratingInputsSchema.safeParse({
        specialities: [{ title: 'Internal Medicine', practicePercent: 100 }],
        scheduledCreditKeys: ['a'],
      }).success,
    ).toBe(true);
  });
});

describe('field value parsing for rating inputs', () => {
  it('reads limits written several ways', () => {
    expect(parseLimit('$1M/$3M')).toEqual({ incident: 1_000_000, aggregate: 3_000_000 });
    expect(parseLimit('1/3')).toEqual({ incident: 1_000_000, aggregate: 3_000_000 });
    expect(parseLimit('$1,000,000 per claim / $3,000,000 aggregate')).toEqual({
      incident: 1_000_000,
      aggregate: 3_000_000,
    });
    expect(parseLimit('$1M per claim, $3M aggregate')).toEqual({ incident: 1_000_000, aggregate: 3_000_000 });
  });

  it('reads a specialty value with its share of practice', () => {
    expect(parseSpecialtyValue('Family Medicine (70%)')).toEqual([{ title: 'Family Medicine', practicePercent: 70 }]);
    expect(parseSpecialtyValue('30% Dermatology')).toEqual([{ title: 'Dermatology', practicePercent: 30 }]);
    expect(parseSpecialtyValue('Internal Medicine')).toEqual([{ title: 'Internal Medicine' }]);
  });

  it('reads surgery type, hours and dates', () => {
    expect(parseSurgeryType('Minor Surgery (Dermatology)')).toBe('Minor Surgery');
    expect(parseSurgeryType('No Surgery')).toBe('No Surgery');
    expect(parseSurgeryType('does not perform major surgery')).toBeUndefined();
    expect(parseHoursPerWeek('32')).toBe(32);
    expect(parseHoursPerWeek('30 hours per week')).toBe(30);
    expect(toIsoDate('1/1/2027')).toBe('2027-01-01');
    expect(toIsoDate('January 5, 2027')).toBe('2027-01-05');
  });
});

describe('calculateQuote never under-prices a stated value', () => {
  const surgical = ctx({
    specialityFactors: [
      {
        code: '80268',
        title: 'Internal Medicine',
        state: 'TX',
        surgeryType: 'No Surgery',
        factor: 1.2,
        abbreviation: 'IM',
      },
      {
        code: '80268',
        title: 'Internal Medicine',
        state: 'TX',
        surgeryType: 'Minor Surgery',
        factor: 1.5,
        abbreviation: 'IM',
      },
    ],
    limits: [
      { state: 'TX', factor: 1, incidentLimit: 1e6, aggregateLimit: 3e6, isDefault: true, key: 'L1' },
      { state: 'TX', factor: 0.75, incidentLimit: 5e5, aggregateLimit: 1.5e5, isDefault: false, key: 'L2' },
    ],
  });

  it('holds a stated surgery type the class is not rated for INCOMPLETE; an unstated one defaults to No Surgery', () => {
    const q = calculateQuote(
      { ...inputs, specialities: [{ code: '80268', practicePercent: 100, surgeryType: 'Major Surgery' }] },
      surgical,
    );
    expect(q.status).toBe('INCOMPLETE');
    expect(q.missing.join(' ')).toMatch(
      /Surgery type Major Surgery not rated for 80268 Internal Medicine in TX.*choose a class/,
    );
    const unstated = calculateQuote(inputs, surgical);
    expect(unstated.status).toBe('QUOTED');
    expect(unstated.factors.specialities![0]!.surgeryType).toBe('No Surgery');
    expect(unstated.flags.some((f) => f.startsWith('Surgery type not stated'))).toBe(true);
  });

  it('prices a blank retro date as the effective date (flagged), and refuses one after the effective date', () => {
    const { retroDate: _r, ...noRetro } = inputs;
    const blank = calculateQuote(noRetro, ctx());
    expect(blank.status).toBe('QUOTED');
    expect(blank.missing.some((m) => m.startsWith('Retro date'))).toBe(false);
    expect(blank.factors.dates).toMatchObject({ retroDate: '2027-01-01', retroYears: 1 });
    expect(blank.flags.some((f) => f.startsWith('Retro date not stated — same as the effective date'))).toBe(true);
    const late = calculateQuote({ ...inputs, retroDate: '2027-06-01' }, ctx());
    expect(late.status).toBe('INCOMPLETE');
    expect(late.missing.join(' ')).toMatch(/2027-06-01 is after the effective date 2027-01-01/);
    expect(calculateQuote({ ...inputs, retroDate: '2025-01-01' }, ctx()).status).toBe('QUOTED');
  });

  it('never prices a stated limit as another one', () => {
    const notOffered = calculateQuote({ ...inputs, limit: { incident: 2e6, aggregate: 4e6 } }, surgical);
    expect(notOffered.status).toBe('INCOMPLETE');
    expect(notOffered.missing.join(' ')).toMatch(/\$2,000,000\/\$4,000,000 is not offered in TX/);
    expect(notOffered.factors.limits).toBeUndefined();

    const otherAggregate = calculateQuote({ ...inputs, limit: { incident: 1e6, aggregate: 2e6 } }, surgical);
    expect(otherAggregate.status).toBe('INCOMPLETE');
    expect(otherAggregate.missing.join(' ')).toMatch(/confirm the aggregate/);

    // The table's $500K/$150K rows (aggregate below per-incident) are bad data: never QUOTED.
    expect(calculateQuote({ ...inputs, limit: { incident: 5e5, aggregate: 1.5e5 } }, surgical).status).toBe(
      'INCOMPLETE',
    );
    expect(calculateQuote({ ...inputs, limitKey: 'L2' }, surgical).status).toBe('INCOMPLETE');
    expect(calculateQuote({ ...inputs, limitKey: 'NOPE' }, surgical).status).toBe('INCOMPLETE');

    expect(calculateQuote({ ...inputs, limit: { incident: 1e6, aggregate: 3e6 } }, surgical).status).toBe('QUOTED');
    expect(calculateQuote({ ...inputs, limit: { incident: 1e6 } }, surgical).status).toBe('QUOTED');
    const unstated = calculateQuote(inputs, surgical);
    expect(unstated.status).toBe('QUOTED');
    expect(unstated.factors.limits!.key).toBe('L1');
    expect(unstated.flags.some((f) => f.startsWith('Limits not stated'))).toBe(true);
  });
});

describe('unitless limit amounts', () => {
  it('reads under 100 as millions, 100 to 9,999 as thousands and 10,000 up as dollars', () => {
    expect(parseLimit('250/750')).toEqual({ incident: 250_000, aggregate: 750_000 });
    expect(parseLimit('500/1500')).toEqual({ incident: 500_000, aggregate: 1_500_000 });
    expect(parseLimit('1/3')).toEqual({ incident: 1_000_000, aggregate: 3_000_000 });
    expect(parseLimit('250000/750000')).toEqual({ incident: 250_000, aggregate: 750_000 });
    expect(parseLimit('200k/600k')).toEqual({ incident: 200_000, aggregate: 600_000 });
  });
});
