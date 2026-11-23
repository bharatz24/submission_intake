import { describe, expect, it } from 'vitest';

import {
  concreteTokens,
  gradeAnalysis,
  gradeChatAnswer,
  gradeClaim,
  gradeSynthesis,
  type GroundingSource,
} from '../src/services/grounding.js';
import type { Analysis, Synthesis } from '../src/services/reportSchemas.js';

const src = (label: string, text: string): GroundingSource => ({ label, text });
const loss = src('loss_runs.pdf', 'Claim closed 2021. Paid: 175,000.00 on 01/05/2021');

describe('concreteTokens', () => {
  it('extracts money, dates, NPIs and percents', () => {
    const tokens = concreteTokens('paid $175,000 on 01/05/2021, NPI 1234567893, 12.5%');
    expect(tokens).toEqual(expect.arrayContaining(['175000', '2021-01-05', '1234567893', '12.5%']));
  });
  it('canonicalises money and dates written differently', () => {
    expect(concreteTokens('$175K')).toContain('175000');
    expect(concreteTokens('$175,000')).toContain('175000');
    expect(concreteTokens('175000')).toContain('175000');
    expect(concreteTokens('Jan 5, 2021')).toContain('2021-01-05');
    expect(concreteTokens('2021-01-05')).toContain('2021-01-05');
  });
  it('keeps quoted fragments of at least 4 characters', () => {
    const tokens = concreteTokens('Note says "claims made" and "ok"');
    expect(tokens).toContain('claims made');
    expect(tokens).not.toContain('ok');
  });
});

describe('number canonicalisation', () => {
  it('does not read the tail of a comma-grouped amount as a second number', () => {
    expect(concreteTokens('limit $1,000,000 / $3,000,000')).toEqual(['1000000', '3000000']);
    expect(gradeClaim('x', 'limit $1,000,000', null, [src('a.pdf', 'Limit 1,000,000')]).verdict).toBe('verified');
  });
  it('treats trailing fractional zeros as equal on both sides', () => {
    expect(gradeClaim('x', 'paid $1,234.50', null, [src('a', 'Paid 1,234.50')]).verdict).toBe('verified');
    expect(gradeClaim('x', 'paid $1,234.5', null, [src('a', 'Paid 1,234.50')]).verdict).toBe('verified');
    expect(gradeClaim('x', 'paid $1,234.00', null, [src('a', 'Paid 1,234')]).verdict).toBe('verified');
    expect(gradeClaim('x', 'rate 12.50%', null, [src('a', 'rate 12.5%')]).verdict).toBe('verified');
  });
  it('expands word and MM suffixes', () => {
    expect(concreteTokens('$1.5MM')).toEqual(['1500000']);
    expect(concreteTokens('$250 thousand')).toEqual(['250000']);
    expect(gradeClaim('x', 'limit $2 million', null, [src('a', 'Limit 2,000,000')]).verdict).toBe('verified');
  });
});

describe('gradeClaim', () => {
  it('checks each part of a multi-source citation', () => {
    const corpus = [loss, src('app.pdf', 'x')];
    expect(gradeClaim('x', 'paid $175,000', 'loss_runs.pdf, app.pdf', corpus).verdict).toBe('verified');
    const g = gradeClaim('x', 'paid $175,000', 'loss_runs.pdf and gone.pdf', corpus);
    expect(g.missing).toEqual(['source: gone.pdf']);
  });
  it('does not match a filename that only shares a suffix', () => {
    expect(gradeClaim('x', 'paid $175,000', 'xloss_runs.pdf', [loss]).verdict).toBe('unverified');
  });
  const text = 'Loss runs: 2021 closed, paid $175,000 (loss_runs.pdf)';
  it('verifies values found in the cited source', () => {
    expect(gradeClaim('x', text, 'loss_runs.pdf', [loss]).verdict).toBe('verified');
  });
  it('flags values missing from the cited source', () => {
    const g = gradeClaim('x', text, 'loss_runs.pdf', [src('loss_runs.pdf', 'Paid: 1,750,000')]);
    expect(g.verdict).toBe('unverified');
    expect(g.missing).toEqual(['175000']);
  });
  it('flags a cited filename that is not in the corpus', () => {
    const g = gradeClaim('x', text, 'other.pdf', [loss]);
    expect(g.verdict).toBe('unverified');
    expect(g.missing).toContain('source: other.pdf');
  });
  it('checks the whole corpus for an unknown non-filename citation', () => {
    expect(gradeClaim('x', text, 'Synthesis', [loss]).verdict).toBe('verified');
    expect(gradeClaim('x', text, 'applicant profile', [loss]).verdict).toBe('verified');
  });
  it('checks the labelled corpus entry for a known non-file source, case-insensitively', () => {
    const corpus = [src('Email Body', 'nothing'), loss];
    expect(gradeClaim('x', 'paid $175,000', 'email body', corpus).verdict).toBe('unverified');
    expect(gradeClaim('x', 'paid $175,000', 'email body', [src('Email Body', 'paid 175,000')]).verdict).toBe(
      'verified',
    );
  });
  it('finds a filename cited inside the text when no source is given', () => {
    expect(gradeClaim('x', text, null, [src('other.pdf', 'Paid 175,000')]).missing).toContain('source: loss_runs.pdf');
    expect(gradeClaim('x', text, null, [src('Acme loss_runs.pdf', 'Paid 175,000')]).verdict).toBe('verified');
  });
  it('is unchecked with no tokens and no source', () => {
    expect(gradeClaim('x', 'Looks fine.', null, [loss]).verdict).toBe('unchecked');
  });
  it('matches dates written in another format', () => {
    expect(gradeClaim('x', 'Effective Jan 5, 2021', null, [loss]).verdict).toBe('verified');
  });
});

describe('gradeChatAnswer', () => {
  it('has nothing to check in an answer without concrete values', () => {
    const g = gradeChatAnswer('The applicant looks fine.', [loss]);
    expect(g.checked).toBe(0);
    expect(g.items).toHaveLength(0);
  });
  it('reports only unverified sentences', () => {
    const g = gradeChatAnswer('Paid $175,000 in 2021.\n- Reserve is $999,000.', [loss]);
    expect(g).toMatchObject({ checked: 2, verified: 1, unverified: 1 });
    expect(g.items[0]?.missing).toEqual(['999000']);
  });
});

describe('gradeAnalysis', () => {
  const finding = (evidence: string[]) => ({
    title: 't',
    detail: 'd',
    severity: 'LOW' as const,
    confidence: 'LOW' as const,
    evidence,
  });
  const analysis = (over: Partial<Analysis>): Analysis => ({
    executiveSummary: '',
    overallRisk: 'LOW',
    recommendation: 'PROCEED',
    riskIndicators: [],
    applicationCompleteness: { score: 1, summary: '', gaps: [] },
    inconsistencies: [],
    potentialConcerns: [],
    missingInformation: [],
    followUpQuestions: [],
    recommendedNextSteps: [],
    limitationsAndUncertainties: [],
    ...over,
  });
  it('walks every finding list with indexed paths', () => {
    const g = gradeAnalysis(analysis({ riskIndicators: [finding(['ok 175,000', 'bad $999,000 (loss_runs.pdf)'])] }), [
      loss,
    ]);
    expect(g.items.map((i) => i.path)).toEqual(['riskIndicators[0].evidence[1]']);
    const h = gradeAnalysis(
      analysis({ inconsistencies: [finding(['$555,000'])], potentialConcerns: [finding(['$666,000'])] }),
      [loss],
    );
    expect(h.items.map((i) => i.path)).toEqual(['inconsistencies[0].evidence[0]', 'potentialConcerns[0].evidence[0]']);
  });
  it('counts values found only in the synthesis entry as verified', () => {
    const g = gradeAnalysis(analysis({ riskIndicators: [finding(['$42,000'])] }), [
      loss,
      src('synthesis', 'Limit $42,000'),
    ]);
    expect(g.unverified).toBe(0);
  });
});

describe('gradeSynthesis', () => {
  it('walks profile extras, facts and conflicts', () => {
    const s = {
      applicantProfile: { other: [{ text: 'Revenue $1,000,000', source: 'loss_runs.pdf', confidence: 'HIGH' }] },
      extractedFacts: [{ text: 'Paid $175,000', source: 'loss_runs.pdf', confidence: 'HIGH' }],
      conflicts: [{ description: 'Paid $777,000 vs other', sources: ['loss_runs.pdf'], resolution: '' }],
    } as unknown as Synthesis;
    const g = gradeSynthesis(s, [loss]);
    expect(g.checked).toBe(3);
    expect(g.items.map((i) => i.path)).toEqual(['applicantProfile.other[0]', 'conflicts[0].sources']);
  });
});
