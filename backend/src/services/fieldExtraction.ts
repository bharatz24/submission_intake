import { z } from 'zod';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { recordSystemError } from './audit.js';
import { claudeAvailable, structuredCall } from './claude.js';
import { limits } from './limitsSettings.js';
import { ClaudeTruncatedError, LlmBudgetError } from './llmUsage.js';
import { findNpis } from './npi.js';
import { escapeAttr, escapeContent, fitToBudget, INJECTION_NOTE } from './promptSafety.js';
import { loadSkill } from './skills.js';

export interface SourceDoc {
  documentId: string | null; // null => email body
  label: string; // filename or "email body"
  text: string;
  ocrUsed: boolean;
}

/**
 * Give every source a distinct label: Claude cites sources by label and the cited label picks the documentId, so two
 * attachments with the same filename are told apart as "name.pdf", "name.pdf (2)", ... (in source order).
 */
export function withUniqueLabels(sources: SourceDoc[]): SourceDoc[] {
  const seen = new Set<string>();
  return sources.map((s) => {
    let label = s.label;
    for (let n = 2; seen.has(label); n++) label = `${s.label} (${n})`;
    seen.add(label);
    return label === s.label ? s : { ...s, label };
  });
}

export interface Field {
  fieldName: string;
  value: string;
  confidence: number;
  evidenceQuote: string | null;
  sourceLabel: string;
  documentId: string | null;
}

export const FIELD_NAMES = [
  // applicant & contact
  'applicant_name',
  'npi',
  'practice_name',
  'contact_name',
  'contact_email',
  'contact_phone',
  'mailing_address',
  'years_in_practice',
  'board_certification',
  // locations & specialties (one entry per location / specialty)
  'practice_location',
  'practice_zip',
  'practice_county',
  'practice_state',
  'specialty',
  'surgery_type',
  'procedures',
  'patient_volume',
  // coverage terms
  'coverage_type',
  'effective_date',
  'expiration_date',
  'retroactive_date',
  'requested_limits',
  'retro_limit',
  'defense_costs',
  'deductible',
  'prior_carrier',
  'expiring_premium',
  // rating inputs
  'base_premium',
  'claims_made_factor',
  'limit_factor',
  'fte_factor',
  'deductible_credit',
  'schedule_credit',
  'schedule_debit',
  'policy_fees',
  // loss history (one claims_detail entry per claim)
  'claims_count_5yr',
  'claims_detail',
  'disciplinary_actions',
  // DPL manual inputs: forms, prior coverage, licensure, practice structure
  'transaction_type',
  'application_form',
  'application_date',
  'claims_count_10yr',
  'loss_run_valuation',
  'prior_coverage_period',
  'prior_limits',
  'provider_type',
  'license',
  'medical_education',
  'training_completion_date',
  'hours_per_week',
  'group_size',
  'entity_ownership',
  'third_party_facility',
  'medical_directorship',
  'risk_management_cme',
  'erp_request',
  // broker
  'broker_name',
  'broker_email',
] as const;

const Extraction = z.object({
  fields: z.array(
    z.object({
      fieldName: z.enum(FIELD_NAMES),
      value: z.string(),
      confidence: z.number(),
      evidenceQuote: z.string(),
      sourceLabel: z.string(),
    }),
  ),
});

/**
 * Sources in order of priority (email body first). Over the prompt budget the last sources are trimmed first, with a
 * note in the text. Over the daily token budget, or when the output is cut off at the output limit, the NPI
 * regex fallback runs instead: a large submission still reaches review, it never ends in ERROR for its size alone.
 */
export async function extractFields(sources: SourceDoc[], submissionId?: string): Promise<Field[]> {
  sources = withUniqueLabels(sources);
  const byLabel = new Map(sources.map((s) => [s.label, s]));
  if (!claudeAvailable()) return regexFallback(sources);

  const prompt = fitToBudget(
    sources.filter((s) => s.text.trim()),
    { maxTotal: config.LLM_PROMPT_MAX_CHARS, perSource: limits().extractionPerDocChars },
  )
    .map(
      (s) =>
        `<source label="${escapeAttr(s.label)}" ocr="${escapeAttr(s.ocrUsed)}"${s.truncated ? ' truncated="true"' : ''}>\n${escapeContent(s.text)}\n</source>`,
    )
    .join('\n\n');
  if (!prompt) return [];
  const call = (maxTokens: number) =>
    structuredCall({
      skill: loadSkill('field-extraction'),
      prompt: `Allowed field names: ${FIELD_NAMES.join(', ')}\n\n${INJECTION_NOTE}\n\n${prompt}`,
      schema: Extraction,
      effort: 'medium',
      task: 'extraction',
      maxTokens,
      submissionId,
    });
  let data: z.infer<typeof Extraction>;
  try {
    ({ data } = await call(limits().extractionMaxTokens));
  } catch (err) {
    if (!(err instanceof ClaudeTruncatedError) && !(err instanceof LlmBudgetError)) throw err;
    logger.warn({ err, submissionId }, 'Field extraction fell back to the NPI regex');
    await recordSystemError(
      `extraction:${submissionId ?? 'unknown'}`,
      new Error(`Only NPIs were extracted: ${err.message}`),
    );
    return regexFallback(sources);
  }
  return data.fields
    .filter((f) => f.value.trim())
    .map((f) => {
      const src = byLabel.get(f.sourceLabel);
      return {
        fieldName: f.fieldName,
        value: f.value.trim(),
        confidence: Math.max(0, Math.min(1, f.confidence)),
        evidenceQuote: f.evidenceQuote || null,
        sourceLabel: src ? src.label : f.sourceLabel,
        documentId: src?.documentId ?? null,
      };
    });
}

/** Without an API key we still surface NPIs so registry verification can run. */
function regexFallback(sources: SourceDoc[]): Field[] {
  const out: Field[] = [];
  for (const s of sources) {
    for (const npi of findNpis(s.text)) {
      const idx = s.text.indexOf(npi);
      out.push({
        fieldName: 'npi',
        value: npi,
        confidence: 0.7,
        evidenceQuote: s.text.slice(Math.max(0, idx - 40), idx + 50).replace(/\s+/g, ' '),
        sourceLabel: s.label,
        documentId: s.documentId,
      });
    }
  }
  return out;
}
