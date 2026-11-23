import { z } from 'zod';

const Level = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const Sourced = z.object({ text: z.string(), source: z.string(), confidence: Level });

export const SynthesisSchema = z.object({
  submissionOverview: z.string(),
  applicantProfile: z.object({
    name: z.string().nullable(),
    npi: z.string().nullable(),
    specialty: z.string().nullable(),
    state: z.string().nullable(),
    practiceName: z.string().nullable(),
    yearsInPractice: z.string().nullable(),
    other: z.array(Sourced),
  }),
  emailAndAttachmentInventory: z.array(
    z.object({ item: z.string(), type: z.string(), status: z.string(), notes: z.string() }),
  ),
  extractedFacts: z.array(Sourced),
  npiVerificationSummary: z.string(),
  conflicts: z.array(z.object({ description: z.string(), sources: z.array(z.string()), resolution: z.string() })),
  missingInformation: z.array(
    z.object({ item: z.string(), importance: z.enum(['CRITICAL', 'IMPORTANT', 'NICE_TO_HAVE']), reason: z.string() }),
  ),
  dataConfidence: z.object({ overall: Level, notes: z.string() }),
  consolidatedContextForLlm: z.string(),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

const Finding = z.object({
  title: z.string(),
  detail: z.string(),
  severity: Level,
  confidence: Level,
  evidence: z.array(z.string()),
});

export const AnalysisSchema = z.object({
  executiveSummary: z.string(),
  overallRisk: z.enum(['LOW', 'MODERATE', 'ELEVATED', 'HIGH']),
  recommendation: z.enum(['PROCEED', 'PROCEED_WITH_CONDITIONS', 'REFER', 'DECLINE', 'REQUEST_INFORMATION']),
  riskIndicators: z.array(Finding),
  applicationCompleteness: z.object({ score: z.number(), summary: z.string(), gaps: z.array(z.string()) }),
  inconsistencies: z.array(Finding),
  potentialConcerns: z.array(Finding),
  missingInformation: z.array(z.string()),
  followUpQuestions: z.array(z.object({ question: z.string(), rationale: z.string(), addressedTo: z.string() })),
  recommendedNextSteps: z.array(z.string()),
  limitationsAndUncertainties: z.array(z.string()),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// Draft Emails (skills/email-draft): one draft for the audience the underwriter picked (broker, insured or quote).
// Saved for reopening, never sent.
export const EMAIL_AUDIENCES = ['broker', 'insured', 'quote'] as const;
export type EmailAudience = (typeof EMAIL_AUDIENCES)[number];
const EmailDraft = z.object({
  to: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  keyPoints: z.array(z.string()),
});
export const EmailDraftSchema = z.object({
  purpose: AnalysisSchema.shape.recommendation,
  draft: EmailDraft,
});
export type EmailDrafts = z.infer<typeof EmailDraftSchema>;

/**
 * Share of the score each completeness gap keeps, by the level its text names; the first pattern that matches wins,
 * so "zip UNSUPPORTED (IMPORTANT)" counts as IMPORTANT. A gap naming no level costs nothing.
 */
const COMPLETENESS_FACTORS: [RegExp, number][] = [
  [/\bCRITICAL\b/, 0.85],
  [/\bIMPORTANT\b/, 0.95],
  [/\bNICE[_ ]TO[_ ]HAVE\b/i, 0.99],
  [/\b(unreadable|unsupported|error)\b/i, 0.9],
];

/**
 * Application completeness 0..100 from the analysis's gaps: each missing item takes its share of what is left, so the
 * score falls with every gap but never floors at 0 (a flat −20 per CRITICAL item put almost every submission at 0).
 */
export function completenessScore(gaps: string[]): number {
  const kept = gaps.reduce((score, gap) => score * (COMPLETENESS_FACTORS.find(([re]) => re.test(gap))?.[1] ?? 1), 1);
  return Math.round(kept * 100);
}

/** The analysis with its completeness score computed from its gaps, replacing the model's own arithmetic. */
export function withCompletenessScore(a: Analysis): Analysis {
  return {
    ...a,
    applicationCompleteness: { ...a.applicationCompleteness, score: completenessScore(a.applicationCompleteness.gaps) },
  };
}
type FindingT = z.infer<typeof Finding>;

const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '_None._');
const cell = (s: string | null | undefined) => (s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The submission's typed applicant name (submissions.applicant_*). */
export interface ApplicantName {
  type: 'INDIVIDUAL' | 'ORGANIZATION' | null;
  firstName: string | null;
  lastName: string | null;
  entityName: string | null;
}

/** Label/value pairs by type: first + last name for individuals, entity name for organizations, else the free-text name. */
function applicantNameFields(a: ApplicantName | undefined, fallback: string | null): [string, string | null][] {
  switch (a?.type) {
    case 'INDIVIDUAL':
      return [
        ['Applicant type', 'Individual'],
        ['First name', a.firstName],
        ['Last name', a.lastName],
      ];
    case 'ORGANIZATION':
      return [
        ['Applicant type', 'Organization'],
        ['Entity name', a.entityName],
      ];
    default:
      return [['Name', fallback]];
  }
}

type RenderMeta = {
  version: number;
  skillVersion: string;
  model: string;
  contextVersion: number;
  applicant?: ApplicantName;
};

export function renderSynthesisMarkdown(s: Synthesis, meta: RenderMeta): string {
  const p = s.applicantProfile;
  const missingBy = (lvl: string) =>
    s.missingInformation.filter((m) => m.importance === lvl).map((m) => `**${m.item}** — ${m.reason}`);
  return `# Synthesis Report v${meta.version}

_Skill ${meta.skillVersion} · Model ${meta.model} · Context v${meta.contextVersion}_

## 1. Submission Overview
${s.submissionOverview}

## 2. Applicant / Provider Profile
| Field | Value |
|---|---|
${applicantNameFields(meta.applicant, p.name)
  .map(([label, value]) => `| ${label} | ${cell(value)} |`)
  .join('\n')}
| NPI | ${cell(p.npi)} |
| Specialty | ${cell(p.specialty)} |
| State | ${cell(p.state)} |
| Practice | ${cell(p.practiceName)} |
| Years in practice | ${cell(p.yearsInPractice)} |
${p.other.map((o) => `| ${cell(o.source)} | ${cell(o.text)} (${o.confidence}) |`).join('\n')}

## 3. Email & Attachment Inventory
| Item | Type | Status | Notes |
|---|---|---|---|
${s.emailAndAttachmentInventory.map((i) => `| ${cell(i.item)} | ${cell(i.type)} | ${cell(i.status)} | ${cell(i.notes)} |`).join('\n')}

## 4. Extracted Facts (with sources)
${bullets(s.extractedFacts.map((f) => `${f.text} — _${f.source}_ (${f.confidence})`))}

## 5. NPI Verification Results
${s.npiVerificationSummary}

## 6. Conflicts & Discrepancies
${bullets(s.conflicts.map((c) => `**${c.description}** (sources: ${c.sources.join(', ')}). Resolution: ${c.resolution}`))}

## 7. Missing / Unreadable Information
**Critical**
${bullets(missingBy('CRITICAL'))}

**Important**
${bullets(missingBy('IMPORTANT'))}

**Nice to have**
${bullets(missingBy('NICE_TO_HAVE'))}

## 8. Data Confidence & Traceability
**Overall: ${s.dataConfidence.overall}** — ${s.dataConfidence.notes}

## 9. Consolidated Context for LLM Analysis
${s.consolidatedContextForLlm}
`;
}

const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
const sortFindings = (f: FindingT[]) =>
  [...f].sort((a, b) => rank[a.severity] - rank[b.severity] || rank[a.confidence] - rank[b.confidence]);
const findingList = (f: FindingT[]) =>
  f.length
    ? sortFindings(f)
        .map(
          (x) =>
            `- **[${x.severity} / conf. ${x.confidence}] ${x.title}** — ${x.detail}${x.evidence.length ? `\n  - Evidence: ${x.evidence.join('; ')}` : ''}`,
        )
        .join('\n')
    : '_None identified._';

export function renderAnalysisMarkdown(a: Analysis, meta: RenderMeta & { synthesisVersion: number }): string {
  const all = [...a.riskIndicators, ...a.inconsistencies, ...a.potentialConcerns];
  const applicant = meta.applicant?.type
    ? applicantNameFields(meta.applicant, null)
        .map(([label, value]) => `**${label}:** ${value ?? '—'}`)
        .join(' · ')
    : null;
  return `# Analysis Report v${meta.version}

_Skill ${meta.skillVersion} · Model ${meta.model} · Based on Synthesis v${meta.synthesisVersion} · Context v${meta.contextVersion}_
${applicant ? `\n${applicant}\n` : ''}
## 1. Executive Summary
${a.executiveSummary}

## 2. Overall Risk & Recommendation
**Overall risk: ${a.overallRisk}** · **Recommendation: ${a.recommendation.replace(/_/g, ' ')}**

## 3. Risk Indicators
${findingList(a.riskIndicators)}

## 4. Application Completeness — ${Math.round(a.applicationCompleteness.score)}/100
${a.applicationCompleteness.summary}

${bullets(a.applicationCompleteness.gaps)}

## 5. Inconsistencies
${findingList(a.inconsistencies)}

## 6. Potential Concerns
${findingList(a.potentialConcerns)}

## 7. Missing Information
${bullets(a.missingInformation)}

## 8. Follow-up Questions
${a.followUpQuestions.length ? a.followUpQuestions.map((q, i) => `${i + 1}. **${q.question}** _(to ${q.addressedTo})_ — ${q.rationale}`).join('\n') : '_None._'}

## 9. Findings by Severity & Confidence
| Severity | High conf. | Medium conf. | Low conf. |
|---|---|---|---|
${(['HIGH', 'MEDIUM', 'LOW'] as const).map((s) => `| ${s} | ${(['HIGH', 'MEDIUM', 'LOW'] as const).map((c) => all.filter((f) => f.severity === s && f.confidence === c).length).join(' | ')} |`).join('\n')}

## 10. Recommended Next Steps
${bullets(a.recommendedNextSteps)}

## 11. Limitations & Uncertainties
${bullets(a.limitationsAndUncertainties)}
`;
}

export const ComparisonSchema = z.object({
  summary: z.string(),
  overallChange: z.enum(['NONE', 'MINOR', 'MATERIAL']),
  changes: z.array(
    z.object({
      section: z.string(),
      fieldPath: z.string(),
      changeType: z.enum(['ADDED', 'REMOVED', 'MODIFIED']),
      before: z.string(),
      after: z.string(),
      significance: Level,
      explanation: z.string(),
      likelyCause: z.enum(['NEW_EVIDENCE', 'SKILL_CHANGE', 'MODEL_CHANGE', 'MODEL_VARIANCE']),
    }),
  ),
  unchangedSections: z.array(z.string()),
  reviewerNote: z.string(),
});
export type Comparison = z.infer<typeof ComparisonSchema>;

export function renderComparisonMarkdown(
  c: Comparison,
  meta: {
    kind: 'SYNTHESIS' | 'ANALYSIS';
    baseVersion: number;
    targetVersion: number;
    skillVersion: string;
    model: string;
  },
): string {
  const label = meta.kind === 'SYNTHESIS' ? 'Synthesis' : 'Analysis';
  const changes = [...c.changes].sort((a, b) => rank[a.significance] - rank[b.significance]);
  return `# ${label} v${meta.baseVersion} → v${meta.targetVersion} comparison

_Skill ${meta.skillVersion} · Model ${meta.model}_

## Summary
**Overall change: ${c.overallChange}**

${c.summary}

## Changes
${
  changes.length
    ? `| Significance | Section | Change | Before | After | Why it matters | Likely cause |
|---|---|---|---|---|---|---|
${changes.map((x) => `| ${x.significance} | ${cell(x.section)} | ${x.changeType} | ${cell(x.before)} | ${cell(x.after)} | ${cell(x.explanation)} | ${x.likelyCause.replace(/_/g, ' ')} |`).join('\n')}`
    : '_No changes._'
}

## Unchanged sections
${bullets(c.unchangedSections)}

## Reviewer note
${c.reviewerNote}
`;
}
