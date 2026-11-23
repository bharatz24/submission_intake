import { z } from 'zod';

import { pool } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { automationSettings } from '../appSettings.js';
import { audit, recordSystemError } from '../audit.js';
import { claudeAvailable, structuredCall } from '../claude.js';
import { describeError } from '../friendlyError.js';
import { jobLeaseLost } from '../jobContext.js';
import { jobs } from '../jobQueue.js';
import { limits } from '../limitsSettings.js';
import { escapeAttr, escapeContent, INJECTION_NOTE } from '../promptSafety.js';
import { loadSkill } from '../skills.js';
import { deriveRatingInputs, type RatingInputs } from './inputs.js';
import { createQuote, specialityOptions } from './quote.js';
import { activeRateGroup, RatesNotLoadedError } from './tables.js';

/**
 * After an Underwriting Analysis completes, a first quote is priced with no click: the rating inputs come from the
 * submission (deriveRatingInputs), and a small model (skill `auto-quote`, Claude Haiku by default) picks the rate class
 * for each speciality from the engine's ranked options and fills a limit or hours the analysis states. The rating
 * engine does all the pricing. Skipped when the submission already has a quote for its current context version (so
 * an underwriter's quote is never buried under an automatic one), or when no rate tables are imported.
 */

const SKILL = 'auto-quote';
export const AUTO_QUOTE_LABEL = 'Automatic quote';

const AutoQuoteSchema = z.object({
  specialities: z.array(z.object({ index: z.number().int(), rank: z.number().int().nullable() })),
  limit: z.object({ incident: z.number().positive(), aggregate: z.number().positive().nullable() }).nullable(),
  hoursPerWeek: z.number().min(0).max(168).nullable(),
  notes: z.string(),
});

export async function startAutoQuote(reportId: string, submissionId: string): Promise<void> {
  if (!claudeAvailable() || (await automationSettings()).autoQuote !== 'AUTO') return;
  await jobs.enqueue('auto-quote', `auto-quote:${reportId}`, { reportId, submissionId });
}

jobs.register(
  'auto-quote',
  async ({ reportId, submissionId }) => {
    try {
      await runAutoQuote(reportId, submissionId);
    } catch (err) {
      if (jobLeaseLost()) throw err; // another worker owns the job now and records its outcome
      logger.warn({ err, submissionId, reportId }, 'Automatic quote failed');
      await audit({
        action: 'AUTO_QUOTE_FAILED',
        entityType: 'report',
        entityId: reportId,
        submissionId,
        actorId: null,
        details: { error: describeError(err).message },
      });
      await recordSystemError(`auto-quote:${submissionId}`, err);
    }
  },
  { retryOnError: false },
);

async function runAutoQuote(reportId: string, submissionId: string): Promise<void> {
  const {
    rows: [r],
  } = await pool.query(
    `SELECT r.content_markdown, s.context_version, s.status FROM reports r JOIN submissions s ON s.id = r.submission_id
     WHERE r.id=$1 AND r.kind='ANALYSIS' AND r.status='COMPLETED'`,
    [reportId],
  );
  if (!r || r.status === 'DUPLICATE' || r.status === 'NOT_SUBMISSION') return;
  const { rowCount } = await pool.query('SELECT 1 FROM single_rating WHERE submission_id=$1 AND context_version=$2', [
    submissionId,
    r.context_version,
  ]);
  if (rowCount) return;
  // No rate tables imported yet: nothing to price with, and not an error.
  if (
    !(await activeRateGroup().then(
      () => true,
      (err) => (err instanceof RatesNotLoadedError ? false : Promise.reject(err)),
    ))
  )
    return;

  const { inputs, sources } = await deriveRatingInputs(submissionId);
  const options = await Promise.all(
    (inputs.specialities ?? []).map((_, index) => specialityOptions(submissionId, inputs, { index, limit: 4 })),
  );

  let notes: string | null = null;
  let model: string | null = null;
  if (options.some((o) => o.options.length) || !inputs.limit || inputs.hoursPerWeek === undefined) {
    const res = await structuredCall({
      skill: loadSkill(SKILL),
      prompt: autoQuotePrompt(inputs, sources, options, r.content_markdown ?? ''),
      schema: AutoQuoteSchema,
      effort: 'low',
      task: 'quote',
      maxTokens: limits().autoQuoteMaxTokens,
      submissionId,
    });
    applyChoices(inputs, options, res.data);
    notes = res.data.notes;
    model = res.model;
  }
  const quoteId = await createQuote(submissionId, { ...inputs, label: AUTO_QUOTE_LABEL }, null);
  await audit({
    action: 'AUTO_QUOTE_CREATED',
    entityType: 'quote',
    entityId: quoteId,
    submissionId,
    actorId: null,
    details: { analysisReportId: reportId, model, notes },
  });
}

type Options = Awaited<ReturnType<typeof specialityOptions>>;

/** Only the engine's own options can be chosen, and derived values are never overwritten. */
function applyChoices(inputs: RatingInputs, options: Options[], data: z.infer<typeof AutoQuoteSchema>): void {
  for (const choice of data.specialities) {
    const option = options[choice.index]?.options.find((o) => o.rank === choice.rank);
    const current = inputs.specialities?.[choice.index];
    if (!option || !current) continue;
    inputs.specialities![choice.index] = { ...current, code: option.code, surgeryType: option.surgeryType };
  }
  if (!inputs.limit && data.limit)
    inputs.limit = {
      incident: data.limit.incident,
      ...(data.limit.aggregate ? { aggregate: data.limit.aggregate } : {}),
    };
  if (inputs.hoursPerWeek === undefined && data.hoursPerWeek != null) inputs.hoursPerWeek = data.hoursPerWeek;
}

function autoQuotePrompt(
  inputs: RatingInputs,
  sources: Record<string, string>,
  options: Options[],
  analysis: string,
): string {
  const derived = Object.entries(inputs)
    .map(([k, v]) => `- ${k}: ${JSON.stringify(v)} (from ${sources[k] ?? 'derived'})`)
    .join('\n');
  const blocks = options
    .map(
      (
        o,
        index,
      ) => `<speciality_options index="${index}" requested="${escapeAttr(o.requested ?? '')}" state="${escapeAttr(o.state ?? '')}">
${escapeContent(
  [
    ...o.options.map(
      (x) =>
        `- rank ${x.rank}: ${x.code} ${x.title} / ${x.surgeryType}, class ${x.specialityClass}, match score ${x.score}${x.recommended ? ', recommended="true"' : ''}${x.weak ? ', weak match' : ''}; premium ${x.quote.premium ?? 'n/a'}`,
    ),
    ...(o.note ? [`Note: ${o.note}`] : []),
  ].join('\n') || '(no options)',
)}
</speciality_options>`,
    )
    .join('\n\n');
  return `${INJECTION_NOTE}

<derived_inputs>
${escapeContent(derived || '(none)')}
</derived_inputs>

${blocks || '<speciality_options>(no speciality on the submission)</speciality_options>'}

<analysis>
${escapeContent(analysis)}
</analysis>

Return the choices as the structured JSON object, following the skill instructions.`;
}
