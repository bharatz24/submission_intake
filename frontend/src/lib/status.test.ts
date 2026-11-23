import { describe, expect, it } from 'vitest';

import {
  applicantNameFields,
  classificationColor,
  confidenceColor,
  duplicateBasisLabel,
  formatBytes,
  formatDate,
  formatDateTime,
  formatPercent,
  formatTokens,
  humanize,
  levelColor,
  mainClassificationReason,
  npiStatusColor,
  parseUsDate,
  shortLabel,
  submissionChance,
  submissionChanceColor,
  submissionStatusColor,
  usDates,
  usDatesDeep,
} from './status';

describe('status chip helpers', () => {
  it('maps submission statuses to colors', () => {
    expect(submissionStatusColor('COMPLETED')).toBe('success');
    expect(submissionStatusColor('ERROR')).toBe('error');
    expect(submissionStatusColor('READY_FOR_REVIEW')).toBe('primary');
    expect(submissionStatusColor('NOT_SUBMISSION')).toBe('default');
    expect(submissionStatusColor('DUPLICATE')).toBe('default');
  });

  it('labels ignored and duplicate emails', () => {
    expect(humanize('NOT_SUBMISSION')).toBe('Ignored');
    expect(humanize('DUPLICATE')).toBe('Duplicate');
    expect(humanize('REVIEW_REQUIRED')).toBe('Review required');
  });

  it('explains duplicate matches', () => {
    const basis = {
      strength: 'HIGH' as const,
      similarity: 0.97,
      sharedAttachments: [],
      daysSinceOriginal: 2,
      originalId: 'x',
      method: 'AUTO' as const,
    };
    expect(duplicateBasisLabel({ ...basis, rule: 'R1' })).toBe('Same message');
    expect(duplicateBasisLabel({ ...basis, rule: 'R2' })).toBe('Identical content');
    expect(duplicateBasisLabel({ ...basis, rule: 'R3' })).toBe('Same attachments, 97% similar text');
    expect(duplicateBasisLabel({ ...basis, rule: 'MANUAL', similarity: null, reason: 'same account' })).toBe(
      'Marked by hand: same account',
    );
    expect(duplicateBasisLabel(null)).toBe('—');
  });

  it('picks the reason that explains a classification', () => {
    expect(mainClassificationReason(['-3: newsletter/marketing (unsubscribe link)', '-2: marketing language'])).toBe(
      'newsletter/marketing (unsubscribe link)',
    );
    expect(
      mainClassificationReason([
        '+1: healthcare provider terms ("clinic")',
        '-3: unsubscribe',
        '-8: calendar response: subject starts "Accepted:"',
      ]),
    ).toBe('calendar response: subject starts "Accepted:"');
    expect(mainClassificationReason(['Repeat of an ignored email. Same text as "Newsletter"'])).toBe(
      'Repeat of an ignored email. Same text as "Newsletter"',
    );
    expect(mainClassificationReason(['+2: mentions "application"', 'LLM: Vendor newsletter'])).toBe(
      'Vendor newsletter',
    );
    expect(mainClassificationReason(['LLM: x', 'Manual override by Ada: not ours'])).toBe(
      'Manual override by Ada: not ours',
    );
    expect(mainClassificationReason([])).toBeNull();
  });

  it('maps classification and NPI statuses', () => {
    expect(classificationColor('REVIEW_REQUIRED')).toBe('warning');
    expect(classificationColor(null)).toBe('default');
    expect(npiStatusColor('MATCH')).toBe('success');
    expect(npiStatusColor('MISMATCH')).toBe('error');
    expect(npiStatusColor(null)).toBe('default');
  });

  it('treats severity and confidence levels in opposite directions', () => {
    expect(levelColor('HIGH')).toBe('error');
    expect(levelColor('HIGH', true)).toBe('success');
    expect(levelColor('LOW', true)).toBe('error');
  });

  it('formats values', () => {
    expect(humanize('READY_FOR_REVIEW')).toBe('Ready for review');
    expect(humanize(null)).toBe('—');
    expect(formatPercent(0.876)).toBe('88%');
    expect(shortLabel('READY_FOR_REVIEW')).toBe('Ready');
    expect(shortLabel('IN_REVIEW')).toBe('In review');
    expect(shortLabel('NOT_SUBMISSION')).toBe('Ignored');
    expect(submissionChance('NOT_SUBMISSION', 0.7)).toBeCloseTo(0.3);
    expect(submissionChance('NOT_SUBMISSION', null)).toBeNull();
    expect(submissionChance('SUBMISSION', 0.9)).toBeNull();
    expect(submissionChanceColor(0.3)).toBe('warning');
    expect(submissionChanceColor(0.1)).toBe('default');
    expect(confidenceColor(0.9)).toBe('success');
    expect(confidenceColor(0.4)).toBe('error');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_340)).toBe('12.3k');
    expect(formatTokens(2_000_000)).toBe('2M');
    expect(formatTokens(999_950)).toBe('1M');
    expect(formatTokens(-5)).toBe('—');
  });

  it('splits the applicant name by type', () => {
    const base = {
      applicantName: 'Jane Smith',
      applicantFirstName: 'Jane',
      applicantLastName: 'Smith',
      applicantEntityName: 'Acme Clinic',
    };
    expect(applicantNameFields({ ...base, applicantType: 'INDIVIDUAL' }).map((f) => f.value)).toEqual([
      'Individual',
      'Jane',
      'Smith',
    ]);
    expect(applicantNameFields({ ...base, applicantType: 'ORGANIZATION' })).toEqual([
      { label: 'Applicant type', value: 'Organization' },
      { label: 'Entity name', value: 'Acme Clinic' },
    ]);
    expect(applicantNameFields({ ...base, applicantType: null })).toEqual([{ label: 'Name', value: 'Jane Smith' }]);
    expect(applicantNameFields({ ...base, applicantType: null }, 'Dr. J. Smith')).toEqual([
      { label: 'Name', value: 'Dr. J. Smith' },
    ]);
  });
});

describe('US dates', () => {
  it('shows calendar dates as mm/dd/yyyy without a time-zone shift', () => {
    expect(formatDate('2026-12-01')).toBe('12/01/2026');
    expect(formatDate(null)).toBe('—');
  });
  it('shows timestamps as mm/dd/yyyy hh:mm AM/PM', () => {
    expect(formatDateTime('2026-11-05T14:15:00')).toBe('11/05/2026 02:15 PM');
  });
  it('parses only real mm/dd/yyyy dates', () => {
    expect(parseUsDate('12/01/2026')).toBe('2026-12-01');
    expect(parseUsDate('02/30/2026')).toBeNull();
    expect(parseUsDate('2026-12-01')).toBeNull();
    expect(parseUsDate('12/01/26')).toBeNull();
  });
});

describe('usDates in generated text', () => {
  it('rewrites ISO dates in prose as mm/dd/yyyy', () => {
    expect(usDates('Effective 2026-12-01 → 2027-12-01 · retro 2026-12-01.')).toBe(
      'Effective 12/01/2026 → 12/01/2027 · retro 12/01/2026.',
    );
    expect(usDates('Policy period (2026-12-01)')).toBe('Policy period (12/01/2026)');
  });
  it('leaves file names, ids and non-dates alone', () => {
    expect(usDates('loss_run_2026-01-05.pdf')).toBe('loss_run_2026-01-05.pdf');
    expect(usDates('rates-2026-11-05-fl')).toBe('rates-2026-11-05-fl');
    expect(usDates('code 2026-13-45')).toBe('code 2026-13-45');
  });
  it('rewrites every string inside a JSON value, keeping its shape', () => {
    expect(usDatesDeep({ a: ['on 2026-12-01'], b: { c: 2 }, d: null })).toEqual({
      a: ['on 12/01/2026'],
      b: { c: 2 },
      d: null,
    });
  });
});
