import { describe, expect, it } from 'vitest';

import { buildCoverage, claimsMadeYear, parseLimits, parseMoney, parsePercent } from '../src/services/coverage.js';

const f = (fieldName: string, value: string, confidence = 0.9, sourceLabel = 'app.pdf') => ({
  fieldName,
  value,
  confidence,
  evidenceQuote: null,
  sourceLabel,
});

describe('coverage parsing', () => {
  it('parses money and limits', () => {
    expect(parseMoney('$12,500.50')).toBe(12500.5);
    expect(parseMoney('1M')).toBe(1_000_000);
    expect(parseLimits('$1,000,000 / $3,000,000')).toEqual({ perClaim: 1_000_000, aggregate: 3_000_000 });
    expect(parseLimits('1M/3M')).toEqual({ perClaim: 1_000_000, aggregate: 3_000_000 });
  });

  it('parses percents', () => {
    expect(parsePercent('10%')).toBe(0.1);
    expect(parsePercent('0.15')).toBe(0.15);
    expect(parsePercent('25')).toBe(0.25);
  });

  it('computes claims-made year as full years since retro + 1', () => {
    expect(claimsMadeYear('2026-01-01', '2022-01-01')).toBe(5);
    expect(claimsMadeYear('2026-01-01', '2022-06-01')).toBe(4);
    expect(claimsMadeYear('2026-01-01', '2026-01-01')).toBe(1);
    expect(claimsMadeYear('2026-01-01', 'None')).toBe(1);
    expect(claimsMadeYear('01/15/2026', '01/15/2024')).toBe(3);
    expect(claimsMadeYear(null, '2022-01-01')).toBeNull();
  });
});

describe('buildCoverage', () => {
  it('builds the premium worksheet from stated inputs', () => {
    const c = buildCoverage([
      f('effective_date', '2026-01-01'),
      f('expiration_date', '2027-01-01'),
      f('retroactive_date', '2023-01-01'),
      f('requested_limits', '$1,000,000 / $3,000,000'),
      f('base_premium', '$20,000'),
      f('claims_made_factor', '0.90'),
      f('fte_factor', '0.50'),
      f('deductible_credit', '10%'),
      f('schedule_credit', '15%'),
      f('schedule_debit', '5%'),
      f('policy_fees', 'Policy fee: $250'),
      f('policy_fees', 'Surplus lines tax $300'),
    ]);
    expect(c.derived.claimsMadeYear).toBe(4);
    expect(c.derived.policyTermDays).toBe(365);
    // 20000 * 0.9 * 0.5 * 0.9 * (1 + 0.05 - 0.15) = 7290
    expect(c.worksheet.ratedPremium).toBe(7290);
    expect(c.worksheet.totalPremium).toBe(7840);
    expect(c.worksheet.missing).toEqual([]);
  });

  it('flags conflicts and missing inputs', () => {
    const c = buildCoverage([
      f('practice_zip', '77030', 0.9),
      f('practice_zip', '77031', 0.6, 'email body'),
      f('specialty', 'OB/GYN'),
      f('specialty', 'Maternal Fetal Medicine'),
    ]);
    expect(c.values.practice_zip).toMatchObject({ value: '77030', conflicts: ['77031'] });
    expect(c.lists.specialty).toHaveLength(2);
    expect(c.worksheet.totalPremium).toBeNull();
    expect(c.worksheet.missing).toContain('base_premium');
  });
});
