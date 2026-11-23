import { createHash } from 'node:crypto';

import { config } from '../config.js';
import {
  CACHE_WRITE_1H,
  CACHE_WRITE_5M,
  LLM_BUDGET_ALERT_SCOPE,
  LLM_BUDGET_ALERT_SHARE,
  MODEL_PRICES,
  TOP_SUBMISSIONS_BY_COST,
} from '../constants.js';
import { pool } from '../db/pool.js';
import { AppError } from '../http.js';
import { logger } from '../logger.js';
import { recordSystemError } from './audit.js';
import type { Task } from './claude.js';
import { scrubText } from './piiScrub.js';

// Token usage per Claude request (llm_calls): written by services/claude.ts, read by the Monitoring page.
// Input totals include cache reads/writes, matching Usage in services/claude.ts.

export type CallStatus = 'SUCCESS' | 'REFUSED' | 'TRUNCATED' | 'INVALID_OUTPUT' | 'ERROR';

export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** cache_creation_input_tokens split by lifetime. */
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
}

/**
 * Estimated USD prompt caching saved against sending every token uncached: reads cost a fraction of the input price,
 * writes a premium on top of it. Negative when entries were written and seldom read back. Null for an unknown model.
 */
export function cacheSavingsUsd(
  model: string,
  t: { cacheRead: number; cacheWrite: number; cacheWrite1h: number },
): number | null {
  const price = priceOf(model);
  if (!price) return null;
  const [, perMTok, readMult] = price;
  const write5m = Math.max(0, t.cacheWrite - t.cacheWrite1h);
  const saved = t.cacheRead * (1 - readMult) - write5m * (CACHE_WRITE_5M - 1) - t.cacheWrite1h * (CACHE_WRITE_1H - 1);
  return (saved * perMTok) / 1_000_000;
}

const priceOf = (model: string) => MODEL_PRICES.find(([prefix]) => model.startsWith(prefix));

/**
 * Estimated USD cost of one call: uncached input at the input price, cache reads at the read multiplier, 5-minute and
 * 1-hour cache writes at their premiums, output at the output price. Null for an unknown model.
 */
export function callCostUsd(model: string, u: RawUsage): number | null {
  const price = priceOf(model);
  if (!price) return null;
  const [, inPerMTok, readMult, outPerMTok] = price;
  const write = u.cache_creation_input_tokens ?? 0;
  const write1h = Math.min(write, u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const inputUnits =
    u.input_tokens +
    (u.cache_read_input_tokens ?? 0) * readMult +
    (write - write1h) * CACHE_WRITE_5M +
    write1h * CACHE_WRITE_1H;
  return (inputUnits * inPerMTok + u.output_tokens * outPerMTok) / 1_000_000;
}

export interface LlmCallInput {
  task: Task;
  skillName: string;
  skillVersion: string;
  model: string;
  /** The model the call asked for; differs from `model` when the API answered with a server-side fallback. */
  requestedModel?: string | null;
  submissionId?: string | null;
  status: CallStatus;
  usage?: RawUsage | null;
  durationMs: number;
  error?: unknown;
}

/** Outcome of a finished API response; structured calls also fail when the output did not parse. */
export function callStatus(
  msg: { stop_reason: string | null; parsed_output?: unknown },
  structured: boolean,
): CallStatus {
  if (msg.stop_reason === 'refusal') return 'REFUSED';
  if (msg.stop_reason === 'max_tokens') return 'TRUNCATED';
  if (structured && msg.parsed_output == null) return 'INVALID_OUTPUT';
  return 'SUCCESS';
}

/** Best-effort: usage logging must never fail the LLM call itself. Returns the new llm_calls id, null when not recorded. */
export async function recordLlmCall(c: LlmCallInput): Promise<string | null> {
  const u = c.usage;
  // Scrubbed: llm_calls is kept as PHI-free by the retention purge, and SDK/parse errors can quote model output.
  const error =
    c.error == null ? null : scrubText(c.error instanceof Error ? c.error.message : String(c.error)).slice(0, 1000);
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO llm_calls (submission_id, task, skill_name, skill_version, model, status,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, duration_ms, error, requested_model, cache_write_1h_tokens,
         cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        c.submissionId ?? null,
        c.task,
        c.skillName,
        c.skillVersion,
        c.model,
        c.status,
        u?.input_tokens ?? 0,
        u?.output_tokens ?? 0,
        u?.cache_read_input_tokens ?? 0,
        u?.cache_creation_input_tokens ?? 0,
        c.durationMs,
        error,
        c.requestedModel ?? null,
        u?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        u ? callCostUsd(c.model, u) : null,
      ],
    );
    return rows[0] ? String(rows[0].id) : null;
  } catch (err) {
    logger.warn({ err, task: c.task }, 'Failed to record LLM usage');
    return null;
  }
}

// --- Transcripts (llm_transcripts, LLM_STORE_TRANSCRIPTS) ---

export type TranscriptMode = 'off' | 'decisions' | 'all';

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Hashes of what a call sent, and, when `store`, the outbound prompt itself (already redacted: what Claude saw) and
 * the raw output text. Best-effort like the usage row: a failure is logged (ids only) and never fails the call.
 */
export async function recordTranscript(t: {
  callId: string;
  task: Task;
  system: string;
  prompt: string;
  output: string | null;
  store: boolean;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO llm_transcripts (llm_call_id, system_sha256, prompt_sha256, prompt, output) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (llm_call_id) DO NOTHING`,
      [t.callId, sha256Hex(t.system), sha256Hex(t.prompt), t.store ? t.prompt : null, t.store ? t.output : null],
    );
  } catch (err) {
    logger.warn({ err, task: t.task, callId: t.callId }, 'Failed to record LLM transcript');
  }
}

/** structuredCall output cut off at max_tokens; callers may retry with a smaller input or fall back. */
export class ClaudeTruncatedError extends Error {}

/** A Claude call, streamed answer included, ran past claudeResponseTimeoutMinutes (Settings → Limits); routes answer 504. */
export class ClaudeTimeoutError extends AppError {
  constructor(public minutes: number) {
    super('LLM_TIMEOUT', 504, `Claude did not finish within ${minutes} minutes`, { minutes });
  }
}

/** The API answered with another model than requested (server-side fallback). Dated snapshots of an alias are not a fallback. */
export const isFallbackModel = (requested: string | null | undefined, answered: string) =>
  !!requested && !answered.startsWith(requested);

// --- Daily token budget (LLM_DAILY_TOKEN_BUDGET) ---

/** Thrown before a Claude call once the rolling 24-hour token budget is spent; routes answer 429. */
export class LlmBudgetError extends AppError {
  constructor(
    public used: number,
    public budget: number,
  ) {
    super(
      'LLM_BUDGET_EXCEEDED',
      429,
      `The daily Claude token budget is used up (${used.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')} tokens in the last 24 hours). ` +
        'Try again later or ask an admin to raise LLM_DAILY_TOKEN_BUDGET.',
      { used, budget },
    );
  }
}

/** Tokens left in the budget; Infinity when the budget is 0 (unlimited). Never negative. */
export function budgetRemaining(used: number, budget: number): number {
  return budget <= 0 ? Infinity : Math.max(0, budget - used);
}

/**
 * The per-submission budget (LLM_SUBMISSION_DAILY_TOKEN_BUDGET) is spent for this submission; routes answer 429. A
 * subclass of LlmBudgetError, so callers that skip on a spent budget (automatic reports) handle both alike.
 */
export class LlmSubmissionBudgetError extends LlmBudgetError {
  constructor(used: number, budget: number) {
    super(used, budget);
    this.code = 'LLM_SUBMISSION_BUDGET_EXCEEDED';
    this.message =
      `This submission has used its daily Claude token budget (${used.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')} tokens in the last 24 hours). ` +
      'Try again later or ask an admin to raise LLM_SUBMISSION_DAILY_TOKEN_BUDGET.';
  }
}

/** Pipeline steps the per-submission budget never refuses: a large submission must not end in ERROR because of it. */
const PIPELINE_TASKS: readonly Task[] = ['classification', 'extraction'];

const USED_TOKENS = 'coalesce(sum(input_tokens + cache_read_tokens + cache_write_tokens + output_tokens), 0)::bigint';

/** Input (with cache reads/writes) plus output tokens of every Claude call in the last 24 hours. */
export async function tokensUsedLast24h(): Promise<number> {
  const {
    rows: [r],
  } = await pool.query(`SELECT ${USED_TOKENS} AS used FROM llm_calls WHERE created_at > now() - interval '24 hours'`);
  return Number(r.used);
}

/** Tokens of every call for one submission (all tasks) in the last 24 hours. */
export async function submissionTokensLast24h(submissionId: string): Promise<number> {
  const {
    rows: [r],
  } = await pool.query(
    `SELECT ${USED_TOKENS} AS used FROM llm_calls WHERE submission_id = $1 AND created_at > now() - interval '24 hours'`,
    [submissionId],
  );
  return Number(r.used);
}

/**
 * Once global usage reaches LLM_BUDGET_ALERT_SHARE of the budget, leaves one system error on Monitoring per 24 hours.
 * Best-effort: never fails the call it precedes.
 */
async function alertNearBudget(used: number, budget: number): Promise<void> {
  if (used < budget * LLM_BUDGET_ALERT_SHARE) return;
  try {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM system_errors WHERE scope = $1 AND created_at > now() - interval '24 hours' LIMIT 1`,
      [LLM_BUDGET_ALERT_SCOPE],
    );
    if (rowCount) return;
    const share = Math.floor((used / budget) * 100);
    await recordSystemError(
      LLM_BUDGET_ALERT_SCOPE,
      `Claude usage reached ${share} % of the daily token budget (${used.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')} tokens in the last 24 hours). ` +
        'AI work is refused once it is used up; raise LLM_DAILY_TOKEN_BUDGET if this is expected.',
    );
  } catch (err) {
    logger.warn({ err }, 'Could not record the LLM budget alert');
  }
}

/**
 * Throws LlmBudgetError when the rolling 24-hour budget (`budget`, default LLM_DAILY_TOKEN_BUDGET) is spent, and
 * LlmSubmissionBudgetError when `submissionId`'s own 24-hour usage passed LLM_SUBMISSION_DAILY_TOKEN_BUDGET for a
 * `task` other than classification/extraction. Warns admins at 80 % of the global budget. A failed usage query never
 * blocks a call.
 */
export async function assertLlmBudget(
  opts: { budget?: number; submissionId?: string | null; task?: Task } = {},
): Promise<void> {
  const budget = opts.budget ?? config.LLM_DAILY_TOKEN_BUDGET;
  if (budget > 0) {
    let used: number | null = null;
    try {
      used = await tokensUsedLast24h();
    } catch (err) {
      logger.warn({ err }, 'Could not read LLM usage for the budget check');
    }
    if (used !== null) {
      await alertNearBudget(used, budget);
      if (budgetRemaining(used, budget) <= 0) throw new LlmBudgetError(used, budget);
    }
  }
  const perSubmission = config.LLM_SUBMISSION_DAILY_TOKEN_BUDGET;
  if (perSubmission <= 0 || !opts.submissionId || (opts.task && PIPELINE_TASKS.includes(opts.task))) return;
  let used: number;
  try {
    used = await submissionTokensLast24h(opts.submissionId);
  } catch (err) {
    logger.warn({ err, submissionId: opts.submissionId }, 'Could not read submission LLM usage for the budget check');
    return;
  }
  if (budgetRemaining(used, perSubmission) <= 0) throw new LlmSubmissionBudgetError(used, perSubmission);
}

// 'today' starts at midnight in the viewer's time zone; the others are rolling windows.
export const USAGE_RANGES = { today: null, '24h': '24 hours', '7d': '7 days', '30d': '30 days', all: null } as const;
export type UsageRange = keyof typeof USAGE_RANGES;

/** An IANA time zone name the runtime knows ("America/New_York"); anything else falls back to UTC. */
export function validTimeZone(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Where a range starts: null for all time. */
export async function rangeStart(range: UsageRange, timeZone = 'UTC'): Promise<Date | null> {
  if (range === 'all') return null;
  const sql =
    range === 'today'
      ? `SELECT date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 AS start`
      : 'SELECT now() - $1::interval AS start';
  const {
    rows: [r],
  } = await pool.query(sql, [range === 'today' ? validTimeZone(timeZone) : USAGE_RANGES[range]]);
  return r.start as Date;
}

// Whitelisted ORDER BY expressions for the per-request table; l.id breaks ties so paging stays stable.
export const USAGE_SORT = {
  at: 'l.created_at',
  task: 'l.task',
  submission: 's.applicant_name',
  model: 'l.model',
  input: '(l.input_tokens + l.cache_read_tokens + l.cache_write_tokens)',
  output: 'l.output_tokens',
  duration: 'l.duration_ms',
  status: 'l.status',
} as const;
export type UsageSort = keyof typeof USAGE_SORT;

export async function usageReport(q: {
  range: UsageRange;
  tz?: string;
  page: number;
  pageSize: number;
  sort: UsageSort;
  order: 'asc' | 'desc';
}) {
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const params = [await rangeStart(q.range, q.tz)];
  const where = 'WHERE ($1::timestamptz IS NULL OR l.created_at >= $1::timestamptz)';
  const totals = `count(*)::int AS calls, count(*) FILTER (WHERE status <> 'SUCCESS')::int AS failed,
        coalesce(sum(input_tokens + cache_read_tokens + cache_write_tokens), 0)::bigint AS input,
        coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read,
        coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write,
        coalesce(sum(cache_write_1h_tokens), 0)::bigint AS cache_write_1h,
        coalesce(sum(output_tokens), 0)::bigint AS output,
        sum(cost_usd) AS cost`;
  const [byTask, byModel, requests, spend, top] = await Promise.all([
    pool.query(`SELECT task, ${totals} FROM llm_calls l ${where} GROUP BY task ORDER BY task`, params),
    pool.query(
      `SELECT task, model, ${totals} FROM llm_calls l ${where} GROUP BY task, model ORDER BY task, model`,
      params,
    ),
    pool.query(
      `SELECT l.*, s.applicant_name FROM llm_calls l LEFT JOIN submissions s ON s.id=l.submission_id
      ${where} ORDER BY ${USAGE_SORT[q.sort]} ${dir} NULLS LAST, l.id ${dir} LIMIT $2 OFFSET $3`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    // Spend for the fixed periods, whatever range is picked; NULL when no call in the period has a known price.
    pool.query(
      `SELECT sum(cost_usd) FILTER (WHERE created_at > now() - interval '24 hours') AS d1,
              sum(cost_usd) FILTER (WHERE created_at > now() - interval '7 days') AS d7,
              sum(cost_usd) AS d30
       FROM llm_calls WHERE created_at > now() - interval '30 days'`,
    ),
    pool.query(
      `SELECT l.submission_id, s.applicant_name, count(*)::int AS calls, sum(l.cost_usd) AS cost
       FROM llm_calls l JOIN submissions s ON s.id=l.submission_id
       ${where} AND l.cost_usd IS NOT NULL AND s.deleted_at IS NULL
       GROUP BY l.submission_id, s.applicant_name ORDER BY cost DESC, l.submission_id LIMIT $2`,
      [...params, TOP_SUBMISSIONS_BY_COST],
    ),
  ]);
  /** numeric arrives as a string; NULL (no priced call) stays null. */
  const usd = (v: unknown) => (v == null ? null : Number(v));
  const counts = (r: Record<string, unknown>) => ({
    calls: r.calls as number,
    failed: r.failed as number,
    inputTokens: Number(r.input),
    cacheReadTokens: Number(r.cache_read),
    cacheWriteTokens: Number(r.cache_write),
    outputTokens: Number(r.output),
    costUsd: usd(r.cost),
  });
  const tasks = byTask.rows.map((r) => ({ task: r.task as string, ...counts(r) }));
  const calls = tasks.reduce((n, t) => n + t.calls, 0);
  // Savings need the model's price, so they are worked out per task and model and summed.
  const models = byModel.rows.map((r) => ({
    task: r.task as string,
    model: r.model as string,
    ...counts(r),
    cacheSavingsUsd: cacheSavingsUsd(r.model as string, {
      cacheRead: Number(r.cache_read),
      cacheWrite: Number(r.cache_write),
      cacheWrite1h: Number(r.cache_write_1h),
    }),
  }));
  return {
    range: q.range,
    summary: {
      calls,
      inputTokens: tasks.reduce((n, t) => n + t.inputTokens, 0),
      outputTokens: tasks.reduce((n, t) => n + t.outputTokens, 0),
      cacheReadTokens: tasks.reduce((n, t) => n + t.cacheReadTokens, 0),
      cacheWriteTokens: tasks.reduce((n, t) => n + t.cacheWriteTokens, 0),
      cacheSavingsUsd: models.reduce((n, m) => n + (m.cacheSavingsUsd ?? 0), 0),
      // Null when no call in the range has a known price (unknown models, calls recorded before cost tracking).
      costUsd: tasks.some((t) => t.costUsd !== null) ? tasks.reduce((n, t) => n + (t.costUsd ?? 0), 0) : null,
      byTask: tasks,
      // One row per task and model: tasks share models, and a task can move to another model over time.
      byModel: models,
    },
    spend: { '24h': usd(spend.rows[0].d1), '7d': usd(spend.rows[0].d7), '30d': usd(spend.rows[0].d30) },
    topSubmissions: top.rows.map((r) => ({
      submissionId: String(r.submission_id),
      applicantName: (r.applicant_name as string | null) ?? null,
      calls: r.calls as number,
      costUsd: Number(r.cost),
    })),
    // The per-task counts cover the same window, so their sum is the paging total.
    requests: {
      total: calls,
      page: q.page,
      pageSize: q.pageSize,
      items: requests.rows.map((r) => ({
        id: String(r.id),
        at: new Date(r.created_at).toISOString(),
        task: r.task,
        model: r.model,
        status: r.status,
        requestedModel: r.requested_model ?? null,
        fallback: isFallbackModel(r.requested_model, r.model),
        skillName: r.skill_name,
        skillVersion: r.skill_version,
        inputTokens: r.input_tokens + r.cache_read_tokens + r.cache_write_tokens,
        cacheReadTokens: r.cache_read_tokens,
        outputTokens: r.output_tokens,
        durationMs: r.duration_ms,
        costUsd: usd(r.cost_usd),
        error: r.error,
        submissionId: r.submission_id,
        applicantName: r.applicant_name,
      })),
    },
  };
}
