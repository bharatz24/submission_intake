import { createHash } from 'node:crypto';

import { z } from 'zod';

import { CLASSIFICATION_REUSE_MAX, CLASSIFICATION_REUSE_MS } from '../constants.js';
import { logger } from '../logger.js';
import { applyRules, type Classification, ruleConfidence, type RuleInput } from './classificationRules.js';
import { claudeAvailable, structuredCall } from './claude.js';
import { EMAIL_BODY_SOURCE, safetyNotice, scanEmail } from './injectionFlags.js';
import { limits } from './limitsSettings.js';
import { LlmBudgetError } from './llmUsage.js';
import { escapeAttr, escapeContent, INJECTION_NOTE } from './promptSafety.js';
import { loadSkill } from './skills.js';

export interface ClassificationResult {
  classification: Classification;
  confidence: number;
  reasons: string[];
  method: 'RULES' | 'RULES+LLM' | 'RULES_ONLY_FALLBACK';
}

const LlmClassification = z.object({
  classification: z.enum(['SUBMISSION', 'NOT_SUBMISSION', 'REVIEW_REQUIRED']),
  confidence: z.number(),
  reasons: z.array(z.string()),
});

/** Earlier emails in the same Gmail thread, oldest first. Subjects and verdicts only: never their bodies. */
export interface ThreadEmail {
  subject: string;
  classification: Classification | null;
  receivedAt: Date;
}

type LlmVerdict = z.infer<typeof LlmClassification>;

/**
 * The safety notice for an email whose subject or body reads like instructions to an AI. Classification runs before
 * the documents are read, so only the email itself is scanned. A scan failure never stops classification.
 */
function emailSafetyNotice(subject: string, body: string): string {
  try {
    return safetyNotice(scanEmail(subject, body).map(() => ({ source: EMAIL_BODY_SOURCE })));
  } catch (err) {
    logger.warn({ err }, 'injection scan failed; classifying without a safety notice');
    return '';
  }
}

/**
 * Claude's verdicts on recent prompts, so the same email sent twice (same sender, subject, attachments, body and rule
 * signals) is not paid for twice. Keyed by skill version + exact prompt, so any difference asks Claude again; a call
 * still in flight is shared too. In memory only: a restart just means asking again.
 */
const recentVerdicts = new Map<string, { at: number; verdict: Promise<LlmVerdict> }>();

async function askClaude(
  prompt: string,
  submissionId: string | undefined,
  reuse: boolean,
): Promise<{ data: LlmVerdict; reused: boolean }> {
  const skill = loadSkill('email-classification');
  const call = () =>
    structuredCall({
      skill,
      prompt,
      schema: LlmClassification,
      effort: 'low',
      task: 'classification',
      maxTokens: limits().classificationMaxTokens,
      submissionId,
    }).then((r) => r.data);
  if (!reuse) return { data: await call(), reused: false };

  const key = createHash('sha256').update(`${skill.version}\n${prompt}`).digest('hex');
  const now = Date.now();
  for (const [k, v] of recentVerdicts) if (now - v.at > CLASSIFICATION_REUSE_MS) recentVerdicts.delete(k);
  const hit = recentVerdicts.get(key);
  if (hit) return { data: await hit.verdict, reused: true };

  const verdict = call();
  recentVerdicts.set(key, { at: now, verdict });
  if (recentVerdicts.size > CLASSIFICATION_REUSE_MAX) recentVerdicts.delete(recentVerdicts.keys().next().value!);
  // A failed call is not remembered: the next copy asks again.
  verdict.catch(() => {
    if (recentVerdicts.get(key)?.verdict === verdict) recentVerdicts.delete(key);
  });
  return { data: await verdict, reused: false };
}

/** Test hook: forget remembered verdicts. */
export const clearRecentVerdicts = () => recentVerdicts.clear();

/**
 * `reuse` (automatic runs): an identical email classified in the last 30 minutes takes Claude's earlier verdict instead
 * of a new call. A person's re-run leaves it off and always asks Claude.
 */
export async function classifyEmail(
  input: RuleInput & { thread?: ThreadEmail[] },
  submissionId?: string,
  opts: { useLlm?: boolean; reuse?: boolean } = {},
): Promise<ClassificationResult> {
  const thread = input.thread ?? [];
  const rules = applyRules({
    ...input,
    threadSubmissionSubject:
      input.threadSubmissionSubject ?? thread.find((t) => t.classification === 'SUBMISSION')?.subject ?? null,
  });
  if (rules.decisive) {
    return {
      classification: rules.decisive,
      confidence: ruleConfidence(rules.decisive, rules.score),
      reasons: rules.reasons,
      method: 'RULES',
    };
  }
  const rulesOnly = (why: string): ClassificationResult => ({
    classification: rules.score >= 4 ? 'SUBMISSION' : 'REVIEW_REQUIRED',
    confidence: 0.5,
    reasons: [...rules.reasons, `${why}; rules-only decision`],
    method: 'RULES_ONLY_FALLBACK',
  });
  // Manual (Settings → Automation): Claude is not asked; an underwriter sets the classification.
  if (opts.useLlm === false) {
    return {
      classification: 'REVIEW_REQUIRED',
      confidence: 0.5,
      method: 'RULES_ONLY_FALLBACK',
      reasons: [...rules.reasons, 'Classification is manual in Settings → Automation: an underwriter decides'],
    };
  }
  if (!claudeAvailable()) return rulesOnly('LLM unavailable (no Anthropic API key in Settings)');
  // Subjects, names and the body come from the sender: escaped so they cannot close a tag or open a fake one.
  const threadContext = thread.length
    ? `<thread_context>\n${escapeContent(thread.map((t) => `${t.receivedAt.toISOString().slice(0, 10)} | ${t.classification ?? 'UNCLASSIFIED'} | ${t.subject}`).join('\n'))}\n</thread_context>\n`
    : '';
  const notice = emailSafetyNotice(input.subject, input.bodyText);
  const prompt = `${INJECTION_NOTE}
${
  notice
    ? `
${notice}
`
    : ''
}
<rule_signals score="${escapeAttr(rules.score)}">\n${escapeContent(rules.reasons.join('\n') || '(none)')}\n</rule_signals>
${threadContext}<email>
${escapeContent(`From: ${input.fromAddress}
Subject: ${input.subject}
Attachments: ${input.attachmentNames.join(', ') || '(none)'}

${input.bodyText.slice(0, limits().classificationBodyChars)}`)}
</email>`;
  let data: LlmVerdict;
  let reused: boolean;
  try {
    ({ data, reused } = await askClaude(prompt, submissionId, opts.reuse ?? false));
  } catch (err) {
    // Over the daily token budget the email is still classified, by the rules alone.
    if (err instanceof LlmBudgetError) return rulesOnly('Daily Claude token budget used up');
    throw err;
  }
  const confidence = Math.max(0, Math.min(1, data.confidence));
  const reasons = [...rules.reasons, ...data.reasons.map((r) => `LLM: ${r}`)];
  if (reused)
    reasons.push(
      "Identical to an email classified in the last 30 minutes: Claude's verdict on it was reused, not asked again",
    );
  // Low-confidence LLM verdicts are routed to a human instead of being trusted.
  let classification =
    confidence < 0.6 && data.classification !== 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : data.classification;
  // Ignoring an email that carries submission documents or continues a submission thread needs a near-certain verdict.
  if (classification === 'NOT_SUBMISSION' && rules.submissionEvidence && confidence < 0.85) {
    classification = 'REVIEW_REQUIRED';
    reasons.push(
      `Not ignored: Claude was only ${Math.round(confidence * 100)}% sure, and the email has submission documents or continues a submission thread`,
    );
  }
  return { classification, confidence, reasons, method: 'RULES+LLM' };
}
