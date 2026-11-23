import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError, notFound } from '../http.js';
import { logger } from '../logger.js';
import { automationSettings } from './appSettings.js';
import { audit, recordSystemError } from './audit.js';
import { claudeAvailable, claudeModel, structuredCall, type Task, type Usage } from './claude.js';
import { buildCoverage } from './coverage.js';
import { type EffectiveField, effectiveFields } from './fields.js';
import { describeError } from './friendlyError.js';
import { gradeAnalysis, gradeSynthesis, type Grounding, type GroundingSource } from './grounding.js';
import { listInjectionFlags, safetyNotice } from './injectionFlags.js';
import { jobLeaseLost } from './jobContext.js';
import { jobs } from './jobQueue.js';
import { limits } from './limitsSettings.js';
import { assertLlmBudget, isFallbackModel, LlmBudgetError } from './llmUsage.js';
import { escapeAttr, escapeContent, fitToBudget, INJECTION_NOTE, redactPii } from './promptSafety.js';
import { startAutoQuote } from './rating/autoQuote.js';
import { quoteContext } from './rating/quote.js';
import {
  type Analysis,
  AnalysisSchema,
  type ApplicantName,
  renderAnalysisMarkdown,
  renderSynthesisMarkdown,
  type Synthesis,
  SynthesisSchema,
  withCompletenessScore,
} from './reportSchemas.js';
import { loadSkill } from './skills.js';

/** The submission's typed applicant name, shown in the rendered markdown. */
async function applicantName(submissionId: string): Promise<ApplicantName> {
  const {
    rows: [s],
  } = await pool.query(
    'SELECT applicant_type, applicant_first_name, applicant_last_name, applicant_entity_name FROM submissions WHERE id=$1',
    [submissionId],
  );
  return {
    type: s?.applicant_type ?? null,
    firstName: s?.applicant_first_name ?? null,
    lastName: s?.applicant_last_name ?? null,
    entityName: s?.applicant_entity_name ?? null,
  };
}

type Kind = 'SYNTHESIS' | 'ANALYSIS';
const SKILL_FOR: Record<Kind, string> = { SYNTHESIS: 'synthesis', ANALYSIS: 'underwriting-analysis' };
const TASK_FOR: Record<Kind, Task> = { SYNTHESIS: 'synthesis', ANALYSIS: 'analysis' };

/**
 * Create a RUNNING report row (next version) and queue generation.
 * actorId null = started by the pipeline; `thenAnalysis` chains an Analysis on the finished Synthesis.
 * A COMPLETED report of the same kind, context version, skill version (and Synthesis, for an Analysis) is returned
 * instead of spending tokens on an identical run, unless `force`. Throws LlmBudgetError (429) once the daily budget is spent.
 */
export async function startReport(
  submissionId: string,
  kind: Kind,
  actorId: string | null,
  basedOnReportId?: string,
  opts: { thenAnalysis?: boolean; force?: boolean } = {},
) {
  if (!claudeAvailable())
    throw new AppError('LLM_UNAVAILABLE', 503, 'No Anthropic API key is set: add one in Settings → Claude API');
  const {
    rows: [sub],
  } = await pool.query('SELECT id, status, context_version FROM submissions WHERE id=$1', [submissionId]);
  if (!sub) throw notFound('Submission');
  if (sub.status === 'PROCESSING' || sub.status === 'NEW')
    throw new AppError('NOT_READY', 409, 'Submission is still being processed');
  assertProcessable(sub.status);

  let basedOn: string | null = null;
  if (kind === 'ANALYSIS') {
    const {
      rows: [syn],
    } = basedOnReportId
      ? await pool.query(
          `SELECT id FROM reports WHERE id=$1 AND submission_id=$2 AND kind='SYNTHESIS' AND status='COMPLETED'`,
          [basedOnReportId, submissionId],
        )
      : await pool.query(
          `SELECT id FROM reports WHERE submission_id=$1 AND kind='SYNTHESIS' AND status='COMPLETED' ORDER BY version DESC LIMIT 1`,
          [submissionId],
        );
    if (!syn) throw new AppError('SYNTHESIS_REQUIRED', 409, 'A completed Synthesis Report is required before analysis');
    basedOn = syn.id;
  }

  const skill = loadSkill(SKILL_FOR[kind]);
  const model = claudeModel(TASK_FOR[kind], skill);
  if (!opts.force) {
    const {
      rows: [same],
    } = await pool.query(
      `SELECT id FROM reports WHERE submission_id=$1 AND kind=$2 AND status='COMPLETED' AND context_version=$3 AND skill_version=$4
         AND based_on_report_id IS NOT DISTINCT FROM $5::uuid ORDER BY version DESC LIMIT 1`,
      [submissionId, kind, sub.context_version, skill.version, basedOn],
    );
    if (same) {
      if (opts.thenAnalysis) await startReport(submissionId, 'ANALYSIS', actorId, same.id);
      return same.id as string;
    }
  }
  await assertLlmBudget({ submissionId, task: TASK_FOR[kind] });
  const {
    rows: [report],
  } = await insertNextVersion(
    `INSERT INTO reports (submission_id, kind, version, status, context_version, based_on_report_id, skill_name, skill_version, model, created_by)
     VALUES ($1, $2, COALESCE((SELECT max(version) FROM reports WHERE submission_id=$1 AND kind=$2), 0) + 1, 'RUNNING', $3, $4, $5, $6, $7, $8)
     RETURNING id, version`,
    [submissionId, kind, sub.context_version, basedOn, skill.name, skill.version, model, actorId],
  );
  await audit({
    action: `${kind}_REQUESTED`,
    entityType: 'report',
    entityId: report.id,
    submissionId,
    actorId,
    details: {
      version: report.version,
      skillVersion: skill.version,
      model,
      contextVersion: sub.context_version,
      basedOnReportId: basedOn,
      automatic: actorId === null,
    },
  });
  // Only a person starting a report moves the submission into review; automatic reports leave it READY_FOR_REVIEW.
  if (actorId)
    await pool.query(
      `UPDATE submissions SET status = CASE WHEN status='READY_FOR_REVIEW' THEN 'IN_REVIEW' ELSE status END, updated_at=now() WHERE id=$1`,
      [submissionId],
    );

  await jobs.enqueue('report', `report:${report.id}`, {
    reportId: report.id,
    submissionId,
    actorId,
    thenAnalysis: opts.thenAnalysis,
  });
  return report.id as string;
}

// runReport marks the row FAILED itself, so errors are not retried (a second LLM call per failure); a crash mid-run
// (lapsed lease) re-runs it while the row is still RUNNING. A finished Synthesis still chains its Analysis.
jobs.register(
  'report',
  async ({ reportId, submissionId, actorId, thenAnalysis }) => {
    const {
      rows: [r],
    } = await pool.query('SELECT status FROM reports WHERE id=$1', [reportId]);
    if (!r || r.status === 'FAILED') return;
    if (r.status === 'RUNNING') await runReport(reportId);
    if (!thenAnalysis || (await automationSettings()).analysis !== 'AUTO') return;
    const { rowCount } = await pool.query(`SELECT 1 FROM reports WHERE based_on_report_id=$1 AND kind='ANALYSIS'`, [
      reportId,
    ]);
    if (!rowCount) await startReport(submissionId, 'ANALYSIS', actorId, reportId);
  },
  { retryOnError: false },
);

/**
 * Run a reports INSERT that takes max(version)+1. Two concurrent inserts for the same submission and kind can read
 * the same max; the loser hits the (submission_id, kind, version) key and simply recomputes.
 */
async function insertNextVersion(sql: string, params: unknown[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code !== '23505' || e.constraint !== 'reports_submission_id_kind_version_key' || attempt >= 5) throw err;
    }
  }
}

/** Ignored and duplicate emails are never processed, so they get no reports. */
function assertProcessable(status: string) {
  if (status === 'DUPLICATE' || status === 'NOT_SUBMISSION') {
    throw new AppError(
      'NOT_PROCESSABLE',
      409,
      `Reports are not generated for ${status === 'DUPLICATE' ? 'duplicate' : 'ignored'} emails`,
    );
  }
}

/** Pipeline hook: Synthesis -> Analysis with no user action, as set in Settings → Automation, when Claude is configured. */
export async function startAutoReports(submissionId: string): Promise<void> {
  if (!claudeAvailable()) return;
  const auto = await automationSettings();
  if (auto.synthesis !== 'AUTO') return;
  // Over the daily token budget: skip (no FAILED report rows) and leave a trace on Monitoring.
  try {
    await assertLlmBudget({ submissionId, task: 'synthesis' });
  } catch (err) {
    if (!(err instanceof LlmBudgetError)) throw err;
    await recordSystemError(`auto-reports:${submissionId}`, new Error(`Automatic reports skipped: ${err.message}`));
    return;
  }
  await startReport(submissionId, 'SYNTHESIS', null, undefined, { thenAnalysis: auto.analysis === 'AUTO' });
}

async function runReport(reportId: string): Promise<void> {
  const {
    rows: [r],
  } = await pool.query('SELECT * FROM reports WHERE id=$1', [reportId]);
  try {
    const skill = loadSkill(r.skill_name);
    const evidence = await buildEvidence(r.submission_id);
    let content: unknown;
    let markdown: string;
    let usage: Usage;
    let answeredBy: string;
    let grounding: Grounding | null;
    let callId: string | null;
    if (r.kind === 'SYNTHESIS') {
      const res = await structuredCall({
        skill,
        prompt: synthesisPrompt(evidence),
        schema: SynthesisSchema,
        effort: 'high',
        task: 'synthesis',
        maxTokens: limits().synthesisMaxTokens,
        submissionId: r.submission_id,
      });
      content = res.data;
      usage = res.usage;
      answeredBy = res.model;
      callId = res.callId ?? null;
      grounding = await gradeSafely({ submissionId: r.submission_id, reportId }, async () =>
        gradeSynthesis(res.data, await groundingCorpus(r.submission_id, [], { evidence })),
      );
      markdown = renderSynthesisMarkdown(res.data, {
        version: r.version,
        skillVersion: r.skill_version,
        model: res.model,
        contextVersion: r.context_version,
        applicant: await applicantName(r.submission_id),
      });
    } else {
      const {
        rows: [syn],
      } = await pool.query('SELECT version, content_json FROM reports WHERE id=$1', [r.based_on_report_id]);
      const quotes = await quoteContext(r.submission_id);
      const res = await structuredCall({
        skill,
        prompt: analysisPrompt(syn.content_json as Synthesis, syn.version, evidence, quotes),
        schema: AnalysisSchema,
        effort: 'high',
        task: 'analysis',
        maxTokens: limits().analysisMaxTokens,
        submissionId: r.submission_id,
      });
      const analysis = withCompletenessScore(res.data);
      content = analysis;
      usage = res.usage;
      answeredBy = res.model;
      callId = res.callId ?? null;
      grounding = await gradeSafely({ submissionId: r.submission_id, reportId }, async () =>
        gradeAnalysis(
          analysis,
          await groundingCorpus(r.submission_id, analysisSources(syn.content_json, quotes), { evidence }),
        ),
      );
      markdown = renderAnalysisMarkdown(analysis, {
        version: r.version,
        skillVersion: r.skill_version,
        model: res.model,
        contextVersion: r.context_version,
        synthesisVersion: syn.version,
        applicant: await applicantName(r.submission_id),
      });
    }
    // `model` becomes the model that actually answered (a server-side fallback can differ from the one requested).
    const fallback = isFallbackModel(r.model, answeredBy);
    await pool.query(
      `UPDATE reports SET status='COMPLETED', content_json=$2, content_markdown=$3, input_tokens=$4, output_tokens=$5, model=$6, grounding=$7, llm_call_id=$8, completed_at=now() WHERE id=$1`,
      [
        reportId,
        JSON.stringify(content),
        markdown,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        answeredBy,
        grounding === null ? null : JSON.stringify(grounding),
        callId,
      ],
    );
    await audit({
      action: `${r.kind}_COMPLETED`,
      entityType: 'report',
      entityId: reportId,
      submissionId: r.submission_id,
      actorId: null,
      details: { version: r.version, usage, model: answeredBy, ...(fallback ? { fallbackFrom: r.model } : {}) },
    });
    // A first quote follows an automatic Analysis (rating/autoQuote.ts), not one a person generated; its failure
    // never fails the report.
    if (r.kind === 'ANALYSIS' && r.created_by === null)
      await startAutoQuote(reportId, r.submission_id).catch((err) =>
        recordSystemError(`auto-quote:${r.submission_id}`, err),
      );
  } catch (err) {
    if (jobLeaseLost()) throw err; // another worker owns the job now and records its outcome
    const { message, detail } = describeError(err);
    await pool.query(`UPDATE reports SET status='FAILED', error=$2, completed_at=now() WHERE id=$1`, [
      reportId,
      message.slice(0, 2000),
    ]);
    await audit({
      action: `${r.kind}_FAILED`,
      entityType: 'report',
      entityId: reportId,
      submissionId: r.submission_id,
      actorId: null,
      details: { version: r.version, error: message, ...(detail ? { detail: detail.slice(0, 2000) } : {}) },
    });
    throw err;
  }
}

const EXTERNAL_MODEL = 'claude-code-cli (external)';

async function latestSynthesis(submissionId: string, basedOnReportId?: string) {
  const {
    rows: [syn],
  } = basedOnReportId
    ? await pool.query(
        `SELECT id, version, content_json FROM reports WHERE id=$1 AND submission_id=$2 AND kind='SYNTHESIS' AND status='COMPLETED'`,
        [basedOnReportId, submissionId],
      )
    : await pool.query(
        `SELECT id, version, content_json FROM reports WHERE submission_id=$1 AND kind='SYNTHESIS' AND status='COMPLETED' ORDER BY version DESC LIMIT 1`,
        [submissionId],
      );
  if (!syn) throw new AppError('SYNTHESIS_REQUIRED', 409, 'A completed Synthesis Report is required before analysis');
  return syn;
}

/** The exact skill instructions + prompt the API path would use, for generating a report outside the portal. */
export async function reportInput(submissionId: string, kind: Kind, basedOnReportId?: string) {
  const {
    rows: [sub],
  } = await pool.query('SELECT id FROM submissions WHERE id=$1 AND deleted_at IS NULL', [submissionId]);
  if (!sub) throw notFound('Submission');
  const skill = loadSkill(SKILL_FOR[kind]);
  const evidence = await buildEvidence(submissionId);
  // The CLI sends this prompt to Claude as-is, so it gets the same PII redaction as the API path (claude.ts).
  const redact = (p: string) => (config.LLM_REDACT_PII ? redactPii(p) : p);
  if (kind === 'SYNTHESIS') return { system: skill.systemPrompt, prompt: redact(synthesisPrompt(evidence)) };
  const syn = await latestSynthesis(submissionId, basedOnReportId);
  return {
    system: skill.systemPrompt,
    prompt: redact(
      analysisPrompt(syn.content_json as Synthesis, syn.version, evidence, await quoteContext(submissionId)),
    ),
    basedOnReportId: syn.id as string,
  };
}

/** Store a report generated outside the portal (e.g. by the Claude CLI) as the next COMPLETED version. */
export async function saveExternalReport(
  submissionId: string,
  kind: Kind,
  content: unknown,
  actorId: string,
  basedOnReportId?: string,
) {
  const {
    rows: [sub],
  } = await pool.query('SELECT id, status, context_version FROM submissions WHERE id=$1', [submissionId]);
  if (!sub) throw notFound('Submission');
  assertProcessable(sub.status);
  const parsed = (kind === 'SYNTHESIS' ? SynthesisSchema : AnalysisSchema).safeParse(content);
  if (!parsed.success)
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      `Report content does not match the ${kind} schema`,
      parsed.error.issues,
    );
  if (kind === 'ANALYSIS') parsed.data = withCompletenessScore(parsed.data as Analysis);
  const syn = kind === 'ANALYSIS' ? await latestSynthesis(submissionId, basedOnReportId) : null;
  const skill = loadSkill(SKILL_FOR[kind]);
  const {
    rows: [report],
  } = await insertNextVersion(
    `INSERT INTO reports (submission_id, kind, version, status, context_version, based_on_report_id, skill_name, skill_version, model, created_by, completed_at)
     VALUES ($1, $2, COALESCE((SELECT max(version) FROM reports WHERE submission_id=$1 AND kind=$2), 0) + 1, 'RUNNING', $3, $4, $5, $6, $7, $8, NULL)
     RETURNING id, version`,
    [submissionId, kind, sub.context_version, syn?.id ?? null, skill.name, skill.version, EXTERNAL_MODEL, actorId],
  );
  const meta = {
    version: report.version,
    skillVersion: skill.version,
    model: EXTERNAL_MODEL,
    contextVersion: sub.context_version,
    applicant: await applicantName(submissionId),
  };
  const markdown =
    kind === 'SYNTHESIS'
      ? renderSynthesisMarkdown(parsed.data as Synthesis, meta)
      : renderAnalysisMarkdown(parsed.data as Analysis, { ...meta, synthesisVersion: syn!.version });
  const grounding = await gradeSafely({ submissionId, reportId: report.id }, async () =>
    kind === 'SYNTHESIS'
      ? gradeSynthesis(parsed.data as Synthesis, await groundingCorpus(submissionId))
      : gradeAnalysis(
          parsed.data as Analysis,
          await groundingCorpus(submissionId, analysisSources(syn?.content_json, await quoteContext(submissionId))),
        ),
  );
  await pool.query(
    `UPDATE reports SET status='COMPLETED', content_json=$2, content_markdown=$3, grounding=$4, completed_at=now() WHERE id=$1`,
    [report.id, JSON.stringify(parsed.data), markdown, grounding === null ? null : JSON.stringify(grounding)],
  );
  await audit({
    action: `${kind}_COMPLETED`,
    entityType: 'report',
    entityId: report.id,
    submissionId,
    actorId,
    details: {
      version: report.version,
      skillVersion: skill.version,
      model: EXTERNAL_MODEL,
      contextVersion: sub.context_version,
      basedOnReportId: syn?.id ?? null,
    },
  });
  await pool.query(
    `UPDATE submissions SET status = CASE WHEN status='READY_FOR_REVIEW' THEN 'IN_REVIEW' ELSE status END, updated_at=now() WHERE id=$1`,
    [submissionId],
  );
  if (kind === 'ANALYSIS')
    await startAutoQuote(report.id, submissionId).catch((err) => recordSystemError(`auto-quote:${submissionId}`, err));
  return report.id as string;
}

/**
 * Startup recovery for reports left RUNNING with no queued or running job (e.g. started before the durable queue):
 * generated ones are queued again (automatic Syntheses chain their Analysis, as startAutoReports does); an
 * external save interrupted between its two statements has nothing to re-run and is failed.
 */
export async function requeueOrphanedReports(): Promise<number> {
  const orphan = `status='RUNNING' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key='report:' || reports.id AND j.status IN ('queued', 'running'))`;
  await pool.query(
    `UPDATE reports SET status='FAILED', error='Interrupted by server restart', completed_at=now() WHERE ${orphan} AND model=$1`,
    [EXTERNAL_MODEL],
  );
  const { rows } = await pool.query(`SELECT id, submission_id, kind, created_by FROM reports WHERE ${orphan}`);
  let n = 0;
  for (const r of rows) {
    const thenAnalysis = r.kind === 'SYNTHESIS' && r.created_by === null;
    if (
      await jobs.enqueue('report', `report:${r.id}`, {
        reportId: r.id,
        submissionId: r.submission_id,
        actorId: r.created_by,
        thenAnalysis,
      })
    )
      n++;
  }
  return n;
}

/**
 * The sources a report or chat answer is graded against (services/grounding.ts): the email (subject, sender, body) as
 * 'email body', each attachment's full text by filename, and the evidence string the prompt carried (extracted fields,
 * manual entries, derived coverage, NPI registry results) as 'evidence', plus any `extra` the call also saw. Pass the
 * `evidence` the call was given to reuse it (chat sees every NPI, reports only matched ones).
 */
export async function groundingCorpus(
  submissionId: string,
  extra: GroundingSource[] = [],
  opts: { evidence?: string } = {},
): Promise<GroundingSource[]> {
  const [email, docs, evidence] = await Promise.all([
    pool.query(
      'SELECT e.subject, e.from_address, e.body_text FROM submissions s JOIN emails e ON e.id=s.email_id WHERE s.id=$1',
      [submissionId],
    ),
    pool.query('SELECT filename, extracted_text FROM documents WHERE submission_id=$1 ORDER BY created_at', [
      submissionId,
    ]),
    opts.evidence ?? buildEvidence(submissionId),
  ]);
  const e = email.rows[0];
  return [
    {
      label: 'email body',
      text: e
        ? `Subject: ${e.subject}
From: ${e.from_address}

${e.body_text ?? ''}`
        : '',
    },
    ...docs.rows.map((d) => ({ label: d.filename as string, text: (d.extracted_text as string | null) ?? '' })),
    { label: 'evidence', text: evidence },
    ...extra,
  ];
}

/** What an Analysis saw beyond the evidence: the Synthesis it was based on and the underwriter quote context. */
const analysisSources = (synthesis: unknown, quotes: string): GroundingSource[] => [
  { label: 'synthesis', text: JSON.stringify(synthesis) },
  { label: 'quote', text: quotes },
];

/**
 * Runs a grounding check; it never fails the report or answer it grades. An error is logged (ids only) and stored as
 * null; unverified items are logged as a count, never their text.
 */
export async function gradeSafely(
  ids: { submissionId: string; reportId?: string; messageId?: string },
  grade: () => Promise<Grounding>,
): Promise<Grounding | null> {
  try {
    const grounding = await grade();
    if (grounding.unverified)
      logger.warn(
        { ...ids, unverified: grounding.unverified, checked: grounding.checked },
        'generated evidence not found in the submission',
      );
    return grounding;
  } catch (err) {
    logger.warn({ ...ids, err }, 'grounding check failed; stored as not graded');
    return null;
  }
}

/** Reports see only NPIs the registry matched (MATCH / PARTIAL_MATCH, after any underwriter decision); anything else
 *  is left out of the report entirely. Workspace chat passes npi 'all' so underwriters can still ask about a mismatch. */
export async function buildEvidence(submissionId: string, opts: { npi?: 'matched' | 'all' } = {}): Promise<string> {
  const matchedOnly = (opts.npi ?? 'matched') === 'matched';
  const {
    rows: [s],
  } = await pool.query(
    `SELECT s.classification, s.classification_reasons, e.* FROM submissions s JOIN emails e ON e.id=s.email_id WHERE s.id=$1`,
    [submissionId],
  );
  const { rows: docs } = await pool.query(
    'SELECT filename, mime_type, extraction_status, ocr_used, page_count, extracted_text FROM documents WHERE submission_id=$1 ORDER BY created_at',
    [submissionId],
  );
  // Sources with instruction-like text are named ahead of the evidence, so the model is told not to follow it.
  const notice = safetyNotice(await listInjectionFlags(submissionId));
  // Manual entries supersede extracted values for the same field (services/fields.ts).
  const fields = (await effectiveFields(submissionId)).sort((a, b) => a.fieldName.localeCompare(b.fieldName));
  // The latest check per NPI decides; the status filter runs after DISTINCT ON so an older MATCH can't resurface.
  const { rows: npis } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (npi) npi, status, source, registry_name, registry_type, registry_taxonomy, registry_state, registry_status, mismatches,
         claimed_name, claimed_type, claimed_state, claimed_specialty, auto_status, override_note
       FROM npi_verifications WHERE submission_id=$1 ORDER BY npi, verified_at DESC) latest
     ${matchedOnly ? `WHERE status IN ('MATCH', 'PARTIAL_MATCH')` : ''} ORDER BY npi`,
    [submissionId],
  );

  // Size budget (P2-11): each source capped at reportPerDocChars (Settings → Limits), then the whole set at LLM_PROMPT_MAX_CHARS, the last
  // attachments trimmed first and the email body last; every cut is marked in the text. A large submission gets a
  // shorter prompt, never an API "prompt too long" error.
  const [body, ...texts] = fitToBudget(
    [{ text: s.body_text ?? '' }, ...docs.map((d) => ({ text: d.extracted_text ?? '' }))],
    { maxTotal: config.LLM_PROMPT_MAX_CHARS, perSource: limits().reportPerDocChars },
  );

  // Every value from the submission is escaped (promptSafety.ts), so it cannot close a tag or open a fake one (P2-10).
  return `${
    notice
      ? `${notice}

`
      : ''
  }<email>
${escapeContent(`From: ${s.from_address}
To: ${s.to_address}
Received: ${new Date(s.received_at).toISOString()}
Subject: ${s.subject}
Classification: ${s.classification}

${body?.text ?? ''}`)}
</email>

${
  docs
    .map(
      (
        d,
        i,
      ) => `<attachment filename="${escapeAttr(d.filename)}" type="${escapeAttr(d.mime_type)}" status="${escapeAttr(d.extraction_status)}" ocr="${escapeAttr(d.ocr_used)}" pages="${escapeAttr(d.page_count ?? '')}"${texts[i]?.truncated ? ' truncated="true"' : ''}>
${escapeContent(texts[i]?.text ?? '') || '(no extractable text)'}
</attachment>`,
    )
    .join('\n\n') || '<attachments>none</attachments>'
}

<extracted_fields>
${escapeContent(
  fields
    .map((f) =>
      f.manual
        ? `- ${f.fieldName}: ${f.value} [source: manual entry by an underwriter, supersedes extracted values${f.supportingDocument ? `; supporting document: ${f.supportingDocument}` : ''}]${f.evidenceQuote ? ` note: "${f.evidenceQuote}"` : ''}`
        : `- ${f.fieldName}: ${f.value} [source: ${f.sourceLabel}; confidence ${f.confidence.toFixed(2)}${f.evidenceVerified === false ? '; UNVERIFIED: the evidence quote was not found in the source text, so treat this value as unconfirmed' : ''}]${f.evidenceQuote ? ` evidence: "${f.evidenceQuote}"` : ''}`,
    )
    .join('\n') || '(none)',
)}
</extracted_fields>

<derived_coverage>
${escapeContent(derivedCoverage(fields))}
</derived_coverage>

<npi_registry_results>
${escapeContent(npis.map((n) => `- NPI ${n.npi}${n.source === 'MANUAL' ? ' (entered by an underwriter)' : ''}: ${n.status}${n.auto_status ? ` (set by an underwriter; registry check said ${n.auto_status}; reason: "${n.override_note}")` : ''}; registry name "${n.registry_name ?? ''}" (${n.registry_type ?? '?'}), taxonomy "${n.registry_taxonomy ?? ''}", state ${n.registry_state ?? '?'}, record status ${n.registry_status ?? '?'}; claimed name "${n.claimed_name ?? ''}" (${n.claimed_type ?? '?'}), state ${n.claimed_state ?? '?'}, specialty "${n.claimed_specialty ?? ''}"; mismatches: ${(n.mismatches as string[]).join('; ') || 'none'}`).join('\n') || (matchedOnly ? '(no registry-matched NPI; NPI is not part of this report)' : '(no NPI found in submission)'))}
</npi_registry_results>`;
}

/** Deterministic calculations so reports quote the same numbers the Coverage tab shows. */
function derivedCoverage(fields: EffectiveField[]): string {
  const c = buildCoverage(fields);
  const money = (n: number | null) =>
    n === null ? 'n/a' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return [
    `- Claims-made year (effective vs retro, +1): ${c.derived.claimsMadeStep ?? 'cannot compute'}`,
    `- Policy term: ${c.derived.policyTermDays ?? 'n/a'} days`,
    `- Limits: ${money(c.derived.limits.perClaim)} / ${money(c.derived.limits.aggregate)}; retro limits: ${money(c.derived.retroLimits.perClaim)} / ${money(c.derived.retroLimits.aggregate)}`,
    ...c.worksheet.steps.map(
      (st) => `- ${st.label}: ${st.factor ?? '-'} -> ${money(st.amount)}${st.note ? ` (${st.note})` : ''}`,
    ),
    `- Fees: ${c.worksheet.fees.map((f) => `${f.label} ${money(f.amount)}`).join(', ') || 'none stated'}`,
    `- Total premium (calculated from stated inputs): ${money(c.worksheet.totalPremium)}${c.worksheet.missing.length ? `; missing inputs: ${c.worksheet.missing.join(', ')}` : ''}`,
  ].join('\n');
}

function synthesisPrompt(evidence: string): string {
  return `${INJECTION_NOTE}\n\n${evidence}\n\nProduce the Synthesis Report as the structured JSON object, following the skill instructions.`;
}

/**
 * buildEvidence puts the safety notice first; a prompt that wraps the evidence in another block takes it out first,
 * so the notice stands on its own ahead of the submission data rather than inside it.
 */
export function splitSafetyNotice(evidence: string): { notice: string; evidence: string } {
  const m = /^(<safety_notice>[\s\S]*?<\/safety_notice>)\n*/.exec(evidence);
  return m?.[1] ? { notice: m[1], evidence: evidence.slice(m[0].length) } : { notice: '', evidence };
}

function analysisPrompt(syn: Synthesis, synVersion: number, withNotice: string, quotes: string): string {
  const { notice, evidence } = splitSafetyNotice(withNotice);
  return `${INJECTION_NOTE}
${notice ? `\n${notice}\n` : ''}
${quotes}

<synthesis_report version="${escapeAttr(synVersion)}">
${escapeContent(JSON.stringify(syn, null, 2))}
</synthesis_report>

<supporting_evidence>
${evidence}
</supporting_evidence>

Produce the Analysis Report as the structured JSON object, following the skill instructions. Base it on the synthesis report; consult supporting evidence only to verify or cite.`;
}
