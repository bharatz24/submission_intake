import { describe, expect, it } from 'vitest';

import { quoteAppearsIn, UNVERIFIED_CONFIDENCE_CAP, verifyEvidence } from '../src/services/evidence.js';
import type { Field, SourceDoc } from '../src/services/fieldExtraction.js';

const source = (label: string, text: string, documentId: string | null = label): SourceDoc => ({
  label,
  text,
  documentId,
  ocrUsed: false,
});
const field = (over: Partial<Field>): Field => ({
  fieldName: 'applicant_name',
  value: 'Jane Roe',
  confidence: 0.95,
  evidenceQuote: 'Applicant: Jane Roe, MD',
  sourceLabel: 'app.pdf',
  documentId: 'app.pdf',
  ...over,
});

describe('quoteAppearsIn', () => {
  it('ignores case, whitespace and typographic quotes and dashes', () => {
    expect(quoteAppearsIn('“Limits:  1M – 3M”', 'LIMITS:\n1m - 3m requested')).toBe(true);
  });
  it('accepts elisions when every fragment appears in order', () => {
    expect(
      quoteAppearsIn(
        'Prior carrier: ProAssurance … expiring premium $12,500',
        'Prior carrier: ProAssurance since 2015. The expiring premium $12,500 is',
      ),
    ).toBe(true);
    expect(
      quoteAppearsIn(
        'expiring premium $12,500 ... Prior carrier: ProAssurance',
        'Prior carrier: ProAssurance. expiring premium $12,500',
      ),
    ).toBe(false);
  });
  it('skips PII placeholders the prompt had in place of the stored text', () => {
    expect(quoteAppearsIn('SSN: [REDACTED-SSN] Name: Jane Roe', 'SSN: 123-45-6789 Name: Jane Roe')).toBe(true);
  });
  it('undoes the prompt escaping of tag-like text', () => {
    expect(quoteAppearsIn('&lt;b>Specialty&lt;/b> Cardiology', '<b>Specialty</b> Cardiology')).toBe(true);
  });
  it('rejects made-up quotes', () => {
    expect(quoteAppearsIn('Applicant: John Doe', 'Applicant: Jane Roe')).toBe(false);
    expect(quoteAppearsIn('…', 'anything')).toBe(false);
  });
  it('accepts a short quote only as a whole word', () => {
    expect(quoteAppearsIn('TX', 'State: TX\nZIP 78701')).toBe(true);
    expect(quoteAppearsIn('TX', 'see the attached text')).toBe(false);
  });
});

describe('verifyEvidence', () => {
  const sources = [
    source('email body', 'Please quote Dr. Jane Roe.', null),
    source('app.pdf', 'Applicant: Jane Roe, MD\nNPI 1234567893'),
  ];

  it('marks a quote found in its cited source as verified, unchanged', () => {
    const [f] = verifyEvidence([field({})], sources);
    expect(f).toMatchObject({ evidenceVerified: true, confidence: 0.95, sourceLabel: 'app.pdf' });
  });
  it('re-attributes a quote found in another source', () => {
    const [f] = verifyEvidence([field({ evidenceQuote: 'Please quote Dr. Jane Roe' })], sources);
    expect(f).toMatchObject({ evidenceVerified: true, sourceLabel: 'email body', documentId: null });
  });
  it('flags a quote found nowhere and caps its confidence', () => {
    const [f] = verifyEvidence([field({ evidenceQuote: 'Applicant: Jane Roe, DO, board certified' })], sources);
    expect(f).toMatchObject({ evidenceVerified: false, confidence: UNVERIFIED_CONFIDENCE_CAP, value: 'Jane Roe' });
  });
  it('leaves fields without a quote unchecked', () => {
    const [f] = verifyEvidence([field({ evidenceQuote: null })], sources);
    expect(f!.evidenceVerified).toBeNull();
  });
});
