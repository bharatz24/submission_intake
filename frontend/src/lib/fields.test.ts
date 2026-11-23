import { describe, expect, it } from 'vitest';

import type { ExtractedField, ManualField } from '../types';
import { effectiveValue, fieldLabel, isValidFieldName, mergeFields, normalizeFieldName } from './fields';

const ex = (fieldName: string, value: string, confidence = 0.9): ExtractedField => ({
  id: `e-${fieldName}-${value}`,
  fieldName,
  value,
  confidence,
  evidenceQuote: null,
  sourceLabel: 'app.pdf',
  documentId: null,
});
const man = (fieldName: string, value: string, updatedAt = '2026-10-30T10:00:00Z'): ManualField => ({
  id: `m-${fieldName}-${value}`,
  fieldName,
  value,
  note: null,
  documentId: null,
  createdBy: null,
  updatedBy: null,
  createdAt: updatedAt,
  updatedAt,
});

describe('field helpers', () => {
  it('normalizes and validates field names', () => {
    expect(normalizeFieldName(' Practice State ')).toBe('practice_state');
    expect(isValidFieldName('Prior-Carrier')).toBe(true);
    expect(isValidFieldName('1st')).toBe(false);
  });

  it('merges rows with manual first and superseded extracted values marked', () => {
    const rows = mergeFields([ex('npi', '1'), ex('applicant_name', 'Jane')], [man('applicant_name', 'Janet')]);
    expect(
      rows.map((r) => `${r.fieldName}:${r.kind}${r.kind === 'extracted' && r.superseded ? ':superseded' : ''}`),
    ).toEqual(['applicant_name:manual', 'applicant_name:extracted:superseded', 'npi:extracted']);
  });

  it('picks the effective value', () => {
    expect(effectiveValue('applicant_name', [ex('applicant_name', 'Jane')], [man('applicant_name', 'Janet')])).toEqual({
      value: 'Janet',
      manual: true,
    });
    expect(effectiveValue('npi', [ex('npi', 'low', 0.2), ex('npi', 'high', 0.9)], [])).toEqual({
      value: 'high',
      manual: false,
    });
    expect(effectiveValue('specialty', [], [])).toBeNull();
  });
});

describe('field labels', () => {
  it('humanizes names and keeps acronyms', () => {
    expect(fieldLabel('practice_state')).toBe('Practice state');
    expect(fieldLabel('npi')).toBe('NPI');
  });
});
