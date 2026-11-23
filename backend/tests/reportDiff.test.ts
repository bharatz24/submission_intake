import { describe, expect, it } from 'vitest';

import { comparisonPrompt } from '../src/services/comparisons.js';
import { diffReportContent } from '../src/services/reportDiff.js';
import { ComparisonSchema, renderComparisonMarkdown } from '../src/services/reportSchemas.js';

const finding = (title: string, severity = 'HIGH', detail = 'd') => ({
  title,
  detail,
  severity,
  confidence: 'HIGH',
  evidence: [] as string[],
});
const analysis = (over: Record<string, unknown> = {}) => ({
  executiveSummary: 'Summary.',
  overallRisk: 'MODERATE',
  recommendation: 'PROCEED',
  riskIndicators: [finding('Prior claims'), finding('Board action', 'MEDIUM')],
  applicationCompleteness: { score: 80, summary: 's', gaps: ['loss runs'] },
  followUpQuestions: [{ question: 'Q1?', rationale: 'r', addressedTo: 'broker' }],
  missingInformation: ['loss runs'],
  ...over,
});

describe('diffReportContent', () => {
  it('returns no changes for identical content, ignoring whitespace and list order', () => {
    const a = analysis();
    const b = analysis({
      executiveSummary: '  Summary.\n',
      riskIndicators: [finding('Board action', 'MEDIUM'), finding('Prior claims')],
    });
    expect(diffReportContent(a, b)).toEqual([]);
  });

  it('reports scalar changes with their section and path', () => {
    const changes = diffReportContent(
      analysis(),
      analysis({ recommendation: 'REFER', applicationCompleteness: { score: 60, summary: 's', gaps: ['loss runs'] } }),
    );
    expect(changes).toEqual([
      { section: 'recommendation', path: 'recommendation', changeType: 'MODIFIED', before: 'PROCEED', after: 'REFER' },
      {
        section: 'applicationCompleteness',
        path: 'applicationCompleteness.score',
        changeType: 'MODIFIED',
        before: 80,
        after: 60,
      },
    ]);
  });

  it('matches list items by key, so edits are MODIFIED and new/old items are ADDED/REMOVED', () => {
    const b = analysis({ riskIndicators: [finding('Prior claims', 'LOW'), finding('Lapsed license')] });
    const changes = diffReportContent(analysis(), b);
    expect(changes).toContainEqual({
      section: 'riskIndicators',
      path: 'riskIndicators[title="Prior claims"].severity',
      changeType: 'MODIFIED',
      before: 'HIGH',
      after: 'LOW',
    });
    expect(changes).toContainEqual(
      expect.objectContaining({ path: 'riskIndicators[title="Board action"]', changeType: 'REMOVED', after: null }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ path: 'riskIndicators[title="Lapsed license"]', changeType: 'ADDED', before: null }),
    );
    expect(changes).toHaveLength(3);
  });

  it('diffs string lists as sets', () => {
    const changes = diffReportContent(analysis(), analysis({ missingInformation: ['loss runs', 'CV'] }));
    expect(changes).toEqual([
      {
        section: 'missingInformation',
        path: 'missingInformation["CV"]',
        changeType: 'ADDED',
        before: null,
        after: 'CV',
      },
    ]);
  });

  it('treats a field that appears or disappears as ADDED or REMOVED', () => {
    const changes = diffReportContent({ a: { npi: null } }, { a: { npi: '1234567893' } });
    expect(changes).toEqual([{ section: 'a', path: 'a.npi', changeType: 'ADDED', before: null, after: '1234567893' }]);
    expect(diffReportContent({ a: { npi: '1' } }, { a: { npi: null } })[0].changeType).toBe('REMOVED');
  });
});

describe('comparison rendering', () => {
  const content = ComparisonSchema.parse({
    summary: 'Recommendation moved to refer.',
    overallChange: 'MATERIAL',
    changes: [
      {
        section: 'executiveSummary',
        fieldPath: 'executiveSummary',
        changeType: 'MODIFIED',
        before: 'a',
        after: 'b',
        significance: 'LOW',
        explanation: 'Wording',
        likelyCause: 'MODEL_VARIANCE',
      },
      {
        section: 'recommendation',
        fieldPath: 'recommendation',
        changeType: 'MODIFIED',
        before: 'PROCEED',
        after: 'REFER',
        significance: 'HIGH',
        explanation: 'Decision | path',
        likelyCause: 'NEW_EVIDENCE',
      },
    ],
    unchangedSections: ['followUpQuestions'],
    reviewerNote: 'Rely on v2.',
  });

  it('renders markdown with the highest significance first and escaped cells', () => {
    const md = renderComparisonMarkdown(content, {
      kind: 'ANALYSIS',
      baseVersion: 1,
      targetVersion: 2,
      skillVersion: '1.0.0+abc',
      model: 'm',
    });
    expect(md).toContain('# Analysis v1 → v2 comparison');
    expect(md).toContain('**Overall change: MATERIAL**');
    expect(md.indexOf('| HIGH |')).toBeLessThan(md.indexOf('| LOW |'));
    expect(md).toContain('Decision \\| path');
    expect(md).toContain('NEW EVIDENCE');
  });

  it('builds a prompt with both versions, the diff and metadata changes', () => {
    const base = {
      kind: 'ANALYSIS',
      version: 1,
      context_version: 3,
      skill_version: 's1',
      model: 'm',
      based_on_version: 1,
      content_json: analysis(),
    };
    const target = {
      ...base,
      version: 2,
      context_version: 4,
      based_on_version: 2,
      content_json: analysis({ recommendation: 'REFER' }),
    };
    const prompt = comparisonPrompt(
      'ANALYSIS',
      base,
      target,
      diffReportContent(base.content_json, target.content_json),
    );
    expect(prompt).toContain('<comparison kind="ANALYSIS" />');
    expect(prompt).toContain('<base_report version="1" context_version="3"');
    expect(prompt).toContain('based_on_synthesis="v2"');
    expect(prompt).toContain('<field_diff count="1">');
    expect(prompt).toMatch(/"field": "context_version",\s+"before": 3,\s+"after": 4,\s+"changed": true/);
  });
});

describe('completenessScore', () => {
  it('keeps a share per gap by level instead of flooring at 0', async () => {
    const { completenessScore, withCompletenessScore } = await import('../src/services/reportSchemas.js');
    expect(completenessScore([])).toBe(100);
    expect(completenessScore(['Loss runs (CRITICAL, −20)'])).toBe(85);
    const many = [...Array(8)]
      .map((_, i) => `Item ${i} (CRITICAL)`)
      .concat(
        [...Array(6)].map((_, i) => `Item ${i} (IMPORTANT)`),
        ['A (NICE_TO_HAVE)', 'B (NICE_TO_HAVE)'],
      );
    expect(completenessScore(many)).toBe(20);
    // The level wins over the attachment wording; a gap naming no level costs nothing.
    expect(completenessScore(['Readable prior declarations pages; zip UNSUPPORTED (IMPORTANT, −8)'])).toBe(95);
    expect(completenessScore(['Unreadable attachment scan_002.pdf (−10)', 'A note'])).toBe(90);
    const a = withCompletenessScore(
      analysis({ applicationCompleteness: { score: 0, summary: 's', gaps: ['Loss runs (CRITICAL)'] } }) as never,
    );
    expect(a.applicationCompleteness).toEqual({ score: 85, summary: 's', gaps: ['Loss runs (CRITICAL)'] });
  });
});
