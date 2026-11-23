import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';

import { config, isValidModelId } from '../config.js';
import { ANTHROPIC_MAX_RETRIES, CLAUDE_PING_TIMEOUT_MS } from '../constants.js';
import { logger } from '../logger.js';
import { anthropicApiKey, anthropicModel } from './anthropicSettings.js';
import { currentJobSignal } from './jobContext.js';
import { limits } from './limitsSettings.js';
import {
  assertLlmBudget,
  callStatus,
  ClaudeTimeoutError,
  ClaudeTruncatedError,
  isFallbackModel,
  type RawUsage,
  recordLlmCall,
  recordTranscript,
} from './llmUsage.js';
import { CHAT_TRUNCATION_NOTICE, INJECTION_NOTE, redactPii } from './promptSafety.js';
import type { LoadedSkill } from './skills.js';

/** Rebuilt when the key in Settings changes. */
let client: { apiKey: string; anthropic: Anthropic } | null = null;
function getClient(): Anthropic {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new Error('No Anthropic API key is set: add one in Settings → Claude API');
  // Retries are stated, not left to the SDK default: 429, 5xx and connection errors are retried with the SDK's
  // backoff. The overall deadline (responseDeadline) still bounds the whole call, retries included.
  if (client?.apiKey !== apiKey)
    client = { apiKey, anthropic: new Anthropic({ apiKey, maxRetries: ANTHROPIC_MAX_RETRIES }) };
  return client.anthropic;
}

export const claudeAvailable = () => Boolean(anthropicApiKey());

/** Cheap liveness probe: fetches model metadata, which validates the key without spending tokens. */
export async function claudePing(): Promise<void> {
  await getClient().models.retrieve(anthropicModel(), {}, { timeout: CLAUDE_PING_TIMEOUT_MS, maxRetries: 0 });
}
export type Task =
  | 'classification'
  | 'extraction'
  | 'synthesis'
  | 'analysis'
  | 'chat'
  | 'comparison'
  | 'quote'
  | 'email_draft';
/**
 * Tasks whose output a person decides on (reports, quotes, chat answers, comparisons): under LLM_STORE_TRANSCRIPTS
 * `decisions` (the default) their full outbound prompt and raw output are kept in llm_transcripts; other calls keep
 * hashes only.
 */
export const DECISION_TASKS: Task[] = ['synthesis', 'analysis', 'quote', 'chat', 'comparison'];
/** Whether a call of `task` keeps its full prompt and output, not only their hashes. Read per call. */
export const storesTranscript = (task: Task) =>
  config.LLM_STORE_TRANSCRIPTS === 'all' ||
  (config.LLM_STORE_TRANSCRIPTS === 'decisions' && DECISION_TASKS.includes(task));

const TASK_MODEL: Record<Task, string | undefined> = {
  classification: config.ANTHROPIC_MODEL_CLASSIFICATION,
  extraction: config.ANTHROPIC_MODEL_EXTRACTION,
  synthesis: config.ANTHROPIC_MODEL_SYNTHESIS,
  analysis: config.ANTHROPIC_MODEL_ANALYSIS,
  chat: config.ANTHROPIC_MODEL_CHAT,
  comparison: config.ANTHROPIC_MODEL_COMPARISON,
  quote: config.ANTHROPIC_MODEL_QUOTE,
  email_draft: config.ANTHROPIC_MODEL_EMAIL_DRAFT,
};
const warnedModels = new Set<string>();
/** Model precedence: ANTHROPIC_MODEL_<TASK> env var, then the skill's `model:`, then the model in Settings → Claude API. */
export const claudeModel = (task?: Task, skill?: LoadedSkill) => {
  const model = (task && TASK_MODEL[task]) || skill?.model || anthropicModel();
  // Env values are checked at startup (config.ts); a skill's `model:` can change at runtime, so it is checked here, once.
  if (skill?.model === model && !isValidModelId(model) && !warnedModels.has(model)) {
    warnedModels.add(model);
    logger.warn({ skill: skill.name, model }, 'Skill model does not look like an Anthropic model ID (claude-...)');
  }
  return model;
};

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export class ClaudeRefusalError extends Error {}

/**
 * Overall deadline of one call (Settings → Limits). The SDK's own timeout ends at the response headers, so without
 * this a stalled stream would never end. `signal` goes with the request, combined with the caller's: by default the
 * lease signal of the job this call runs in (jobContext.ts), so a job taken over by another worker stops its call;
 * `settle` turns the abort into ClaudeTimeoutError.
 */
function responseDeadline(callerSignal: AbortSignal | undefined = currentJobSignal()) {
  const minutes = limits().claudeResponseTimeoutMinutes;
  const timeout = AbortSignal.timeout(minutes * 60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const settle = <T>(p: Promise<T>) =>
    p.catch((err: unknown) => {
      if (timeout.aborted) throw new ClaudeTimeoutError(minutes);
      throw err;
    });
  return { signal, settle };
}

// Server-side fallback: if a safety classifier declines, the API re-runs the request on
// Anthropic's recommended fallback model instead of returning a refusal.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };
/** Haiku has no server-side fallback: the request is sent without it. */
const fallbackFor = (model: string) => (model.startsWith('claude-haiku') ? {} : FALLBACK);

/**
 * How long Claude keeps a task's prompt cached. A read restarts the timer for free; a write costs 1.25x the input price
 * for 5 minutes, 2x for an hour. Bursty tasks (a Gmail poll, one submission's documents) stay on 5 minutes; tasks with
 * large skills that recur minutes to an hour apart (reports, drafts, chat follow-ups) keep it an hour.
 * LLM_CACHE_TTL_<TASK> overrides a default.
 */
export type CacheTtl = '5m' | '1h';
const DEFAULT_CACHE_TTL: Record<Task, CacheTtl> = {
  classification: '5m',
  extraction: '5m',
  quote: '5m',
  synthesis: '1h',
  analysis: '1h',
  comparison: '1h',
  email_draft: '1h',
  chat: '1h',
};
const CACHE_TTL_ENV: Record<Task, CacheTtl | undefined> = {
  classification: config.LLM_CACHE_TTL_CLASSIFICATION,
  extraction: config.LLM_CACHE_TTL_EXTRACTION,
  synthesis: config.LLM_CACHE_TTL_SYNTHESIS,
  analysis: config.LLM_CACHE_TTL_ANALYSIS,
  chat: config.LLM_CACHE_TTL_CHAT,
  comparison: config.LLM_CACHE_TTL_COMPARISON,
  quote: config.LLM_CACHE_TTL_QUOTE,
  email_draft: config.LLM_CACHE_TTL_EMAIL_DRAFT,
};
export const cacheTtl = (task: Task): CacheTtl => CACHE_TTL_ENV[task] ?? DEFAULT_CACHE_TTL[task];
const cacheControl = (ttl: CacheTtl) => ({ type: 'ephemeral' as const, ttl });

/**
 * The skill text as a cached system block. It is the same for every call of a skill version (no dates or ids in it), so
 * calls within the cache lifetime read it at a fraction of the input price; the submission data stays in the user turn.
 * A skill edited in Settings is different text, so its next call simply writes a new entry: nothing stale is ever read.
 */
export const cachedSystem = (skill: LoadedSkill, ttl: CacheTtl = '5m') => [
  { type: 'text' as const, text: skill.systemPrompt, cache_control: cacheControl(ttl) },
];

/** Text leaves the server only through here: PII is redacted when LLM_REDACT_PII is on. Stored text is never changed. */
const outbound = (text: string) => (config.LLM_REDACT_PII ? redactPii(text) : text);

/**
 * One structured call: skill (system prompt, model, effort) + user prompt -> JSON validated
 * against a Zod schema. Streams (large outputs, no HTTP timeouts) and waits for the final parsed message.
 * `effort` is the default when the skill's frontmatter does not set one.
 * Throws LlmBudgetError (429) before calling once the daily token budget, or the submission's own budget for a task
 * other than classification/extraction, is spent.
 */
export async function structuredCall<S extends z.ZodType>(p: {
  skill: LoadedSkill;
  prompt: string;
  schema: S;
  effort: Effort;
  task: Task;
  /** Output cap, from Settings → Limits (limits()); required so no call skips the setting. */
  maxTokens: number;
  submissionId?: string | null;
}): Promise<{ data: z.infer<S>; usage: Usage; model: string; callId: string | null }> {
  await assertLlmBudget({ submissionId: p.submissionId, task: p.task });
  const model = claudeModel(p.task, p.skill);
  const prompt = outbound(p.prompt);
  // The format goes out without its `parse`: the SDK would otherwise parse inside finalMessage() and throw a bare JSON
  // error on output cut off at max_tokens, before the stop_reason checks below can report it as truncated.
  const { parse, ...format } = betaZodOutputFormat(p.schema);
  const deadline = responseDeadline();
  const stream = getClient().beta.messages.stream(
    {
      model,
      max_tokens: p.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: p.skill.effort ?? p.effort, format },
      system: cachedSystem(p.skill, cacheTtl(p.task)),
      messages: [{ role: 'user', content: prompt }],
      ...fallbackFor(model),
    },
    { signal: deadline.signal },
  );
  let parseError: unknown;
  const final = deadline.settle(stream.finalMessage()).then((m) => {
    if (m.stop_reason === 'refusal' || m.stop_reason === 'max_tokens') return { ...m, parsed_output: null };
    const text = m.content.find((b) => b.type === 'text')?.text ?? '';
    try {
      return { ...m, parsed_output: parse(text) as z.infer<S> | null };
    } catch (err) {
      parseError = err;
      return { ...m, parsed_output: null };
    }
  });
  const { msg, callId } = await tracked(
    { task: p.task, skill: p.skill, model, submissionId: p.submissionId, structured: true, prompt },
    final,
  );
  if (msg.stop_reason === 'refusal')
    throw new ClaudeRefusalError(`Claude declined the request (${msg.stop_details?.category ?? 'unspecified'})`);
  if (msg.stop_reason === 'max_tokens')
    throw new ClaudeTruncatedError('Claude output was truncated (max_tokens reached)');
  if (msg.parsed_output == null) {
    logger.warn({ task: p.task, err: parseError }, 'Claude structured output did not match the schema');
    throw new Error('Claude returned output that did not match the expected schema');
  }
  return { data: msg.parsed_output, usage: toUsage(msg.usage), model: msg.model, callId };
}

/**
 * Free-text multi-turn call used by the workspace chat. The system prompt is the skill text only: the untrusted
 * submission `context` rides in the first user turn behind INJECTION_NOTE (P2-10), so a follow-up question reads the
 * skill, the context and the earlier turns from the prompt cache. An answer cut off at max_tokens comes back with
 * CHAT_TRUNCATION_NOTICE appended.
 */
export async function chatCall(p: {
  skill: LoadedSkill;
  context: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  submissionId?: string | null;
}): Promise<{ text: string; usage: Usage; model: string; truncated: boolean; callId: string | null }> {
  await assertLlmBudget({ submissionId: p.submissionId, task: 'chat' });
  const model = claudeModel('chat', p.skill);
  const messages = chatMessages(p.context, p.messages, outbound, cacheTtl('chat'));
  const deadline = responseDeadline();
  const stream = getClient().beta.messages.stream(
    {
      model,
      max_tokens: limits().chatMaxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: p.skill.effort ?? 'medium' },
      system: cachedSystem(p.skill, cacheTtl('chat')),
      messages,
      ...fallbackFor(model),
    },
    { signal: deadline.signal },
  );
  const { msg, callId } = await tracked(
    {
      task: 'chat',
      skill: p.skill,
      model,
      submissionId: p.submissionId,
      structured: false,
      prompt: transcriptOf(messages),
    },
    deadline.settle(stream.finalMessage()),
  );
  if (msg.stop_reason === 'refusal') throw new ClaudeRefusalError('Claude declined to answer this question.');
  const truncated = msg.stop_reason === 'max_tokens';
  const answer = outputText(msg).trim();
  return {
    text: truncated ? `${answer}${CHAT_TRUNCATION_NOTICE}` : answer,
    usage: toUsage(msg.usage),
    model: msg.model,
    truncated,
    callId,
  };
}

/** The outbound chat turns as one readable text (role headers, blocks in order): what the transcript keeps and hashes. */
function transcriptOf(messages: ReturnType<typeof chatMessages>): string {
  return messages.map((m) => `[${m.role}]\n${m.content.map((b) => b.text).join('\n\n')}`).join('\n\n');
}

/**
 * The turns sent for a chat, history from its first user turn. The first user turn carries two blocks,
 * [INJECTION_NOTE + <submission_context>, its question]; later turns are plain text, and every question is labelled.
 * The context leads the conversation, not the latest turn, so it sits in the same place on every request: the prefix up
 * to the previous question is the cached entry the next request reads. The last block marks the new end of the cache.
 * The context is rebuilt per request; when it changes (a new document, a new report) the prefix changes and the
 * cache starts over, so answers never rest on stale data. `transform` redacts every turn.
 */
export function chatMessages(
  context: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  transform: (s: string) => string = (s) => s,
  ttl?: CacheTtl,
) {
  const first = messages.findIndex((m) => m.role === 'user');
  const turns = first < 0 ? [] : messages.slice(first);
  if (turns.at(-1)?.role !== 'user') throw new Error('A chat request must end with a user message');
  const question = (m: { content: string }) => `Question from the underwriter:\n${transform(m.content)}`;
  const out: {
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string; cache_control?: ReturnType<typeof cacheControl> }[];
  }[] = turns.map((m, i) => ({
    role: m.role,
    content:
      i === 0
        ? [
            {
              type: 'text' as const,
              text: transform(`${INJECTION_NOTE}\n\n<submission_context>\n${context}\n</submission_context>`),
            },
            { type: 'text' as const, text: question(m) },
          ]
        : [{ type: 'text' as const, text: m.role === 'user' ? question(m) : transform(m.content) }],
  }));
  if (ttl) {
    const last = out.at(-1)!.content;
    last[last.length - 1] = { ...last[last.length - 1]!, cache_control: cacheControl(ttl) };
  }
  return out;
}

function toUsage(u: RawUsage): Usage {
  return {
    inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens,
  };
}

interface CallMeta {
  task: Task;
  skill: LoadedSkill;
  model: string;
  submissionId?: string | null;
  structured: boolean;
  /** The outbound user content exactly as sent (redacted), for the transcript. */
  prompt: string;
}
interface FinalMessage {
  model: string;
  stop_reason: string | null;
  usage: RawUsage;
  content: readonly { type: string; text?: string }[];
  parsed_output?: unknown;
}

/** The text blocks of a response, joined: the raw output a transcript keeps. */
const outputText = (msg: Pick<FinalMessage, 'content'>) =>
  msg.content.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');

/**
 * Awaits the final message and logs its token usage (services/llmUsage.ts), whatever the outcome. The model that
 * answered is recorded next to the one requested, so a server-side fallback shows on Monitoring. Then the transcript:
 * hashes of the system prompt and outbound prompt always, the prompt and raw output too when LLM_STORE_TRANSCRIPTS
 * covers the task. Neither write can fail the call (both log and carry on).
 */
async function tracked<M extends FinalMessage>(
  meta: CallMeta,
  final: Promise<M>,
): Promise<{ msg: M; callId: string | null }> {
  const started = Date.now();
  const base = {
    task: meta.task,
    skillName: meta.skill.name,
    skillVersion: meta.skill.version,
    submissionId: meta.submissionId,
    requestedModel: meta.model,
  };
  try {
    const msg = await final;
    if (isFallbackModel(meta.model, msg.model))
      logger.info(
        { task: meta.task, requested: meta.model, answered: msg.model },
        'Claude answered with a fallback model',
      );
    const callId = await recordLlmCall({
      ...base,
      model: msg.model,
      status: callStatus(msg, meta.structured),
      usage: msg.usage,
      durationMs: Date.now() - started,
    });
    await transcript(meta, callId, outputText(msg));
    return { msg, callId: callId ?? null };
  } catch (err) {
    const callId = await recordLlmCall({
      ...base,
      model: meta.model,
      status: 'ERROR',
      durationMs: Date.now() - started,
      error: err,
    });
    await transcript(meta, callId, null);
    throw err;
  }
}

/** Mocked usage recorders (tests) return undefined: no call row, so no transcript. */
async function transcript(meta: CallMeta, callId: string | null | undefined, output: string | null): Promise<void> {
  if (!callId) return;
  await recordTranscript({
    callId,
    task: meta.task,
    system: meta.skill.systemPrompt,
    prompt: meta.prompt,
    output,
    store: storesTranscript(meta.task),
  });
}
