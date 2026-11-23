/**
 * Cost controls (spec §7): USD cost per Claude call, the per-submission rolling-24h token budget (never for
 * classification/extraction), the 80 % global budget alert, and spend on the Monitoring usage payload. Real database.
 */
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { registerAdmin, startTestApp, stopTestApp, testDatabaseUrl } from './helpers/apiTestDb.js';

const DB_NAME = 'ims_test_llm_cost';
process.env.DATABASE_URL = testDatabaseUrl(DB_NAME);

const { callCostUsd, assertLlmBudget, recordLlmCall, LlmBudgetError, LlmSubmissionBudgetError } = await import(
  '../src/services/llmUsage.js'
);
const { config } = await import('../src/config.js');

describe('callCostUsd', () => {
  it('prices 1M uncached input plus 1M output at the input and output prices', () => {
    // claude-opus-5-5: $4 input, $20 output per MTok.
    expect(callCostUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(24, 6);
    // Dated snapshots share their alias' price.
    expect(callCostUsd('claude-haiku-5-5-20260101', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(
      0.6,
      6,
    );
  });

  it('applies the cache read and cache write multipliers', () => {
    // Reads at 0.05 x $4; 5-minute writes at 1.25 x, 1-hour writes at 2 x the input price.
    expect(
      callCostUsd('claude-opus-5-5', {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
      }),
    ).toBeCloseTo(0.2 + 5 + 8, 6);
  });

  it('is null for an unknown model', () => {
    expect(callCostUsd('mock-model', { input_tokens: 10, output_tokens: 10 })).toBeNull();
  });
});

describe('budgets and spend (database)', () => {
  let app: Express;
  let pool: pg.Pool;
  let subA: string;
  let subB: string;
  const saved = { daily: 0, perSubmission: 0 };

  const newSubmission = async () => {
    const {
      rows: [e],
    } = await pool.query(
      `INSERT INTO emails (from_address, subject, body_text, received_at) VALUES ('broker@acme.com', 's', 'b', now()) RETURNING id`,
    );
    const {
      rows: [s],
    } = await pool.query(
      `INSERT INTO submissions (email_id, status, applicant_name) VALUES ($1, 'READY_FOR_REVIEW', 'Cost Test') RETURNING id`,
      [e.id],
    );
    return s.id as string;
  };
  const usage = (submissionId: string | null, task: string, tokens: number, model = 'claude-opus-5-5') =>
    pool.query(
      `INSERT INTO llm_calls (submission_id, task, skill_name, skill_version, model, status, input_tokens, output_tokens, duration_ms)
       VALUES ($1, $2, 'x', '1', $3, 'SUCCESS', $4, 0, 1)`,
      [submissionId, task, model, tokens],
    );

  beforeAll(async () => {
    ({ app, pool } = await startTestApp(DB_NAME));
    saved.daily = config.LLM_DAILY_TOKEN_BUDGET;
    saved.perSubmission = config.LLM_SUBMISSION_DAILY_TOKEN_BUDGET;
    subA = await newSubmission();
    subB = await newSubmission();
  });
  afterAll(async () => {
    config.LLM_DAILY_TOKEN_BUDGET = saved.daily;
    config.LLM_SUBMISSION_DAILY_TOKEN_BUDGET = saved.perSubmission;
    await stopTestApp();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM llm_calls');
    await pool.query('DELETE FROM system_errors');
    config.LLM_DAILY_TOKEN_BUDGET = 0;
    config.LLM_SUBMISSION_DAILY_TOKEN_BUDGET = 1000;
  });

  it('defaults the per-submission budget to 3,000,000 tokens', async () => {
    const { EnvSchema } = await import('../src/config.js');
    expect(EnvSchema.shape.LLM_SUBMISSION_DAILY_TOKEN_BUDGET.parse(undefined)).toBe(3_000_000);
  });

  it('refuses on-demand work for a submission over its budget, never classification or extraction', async () => {
    await usage(subA, 'extraction', 800);
    await usage(subA, 'chat', 300);
    const err = await assertLlmBudget({ submissionId: subA, task: 'chat' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmSubmissionBudgetError);
    expect(err).toBeInstanceOf(LlmBudgetError);
    expect(err).toMatchObject({ code: 'LLM_SUBMISSION_BUDGET_EXCEEDED', status: 429 });
    await expect(assertLlmBudget({ submissionId: subA, task: 'extraction' })).resolves.toBeUndefined();
    await expect(assertLlmBudget({ submissionId: subA, task: 'classification' })).resolves.toBeUndefined();
    await expect(assertLlmBudget({ submissionId: subB, task: 'chat' })).resolves.toBeUndefined();
    // No submission, or the per-submission budget off: nothing to refuse.
    await expect(assertLlmBudget()).resolves.toBeUndefined();
    config.LLM_SUBMISSION_DAILY_TOKEN_BUDGET = 0;
    await expect(assertLlmBudget({ submissionId: subA, task: 'chat' })).resolves.toBeUndefined();
  });

  it('ignores usage older than 24 hours', async () => {
    await pool.query(
      `INSERT INTO llm_calls (submission_id, task, skill_name, skill_version, model, status, input_tokens, output_tokens, duration_ms, created_at)
       VALUES ($1, 'chat', 'x', '1', 'm', 'SUCCESS', 5000, 0, 1, now() - interval '25 hours')`,
      [subA],
    );
    await expect(assertLlmBudget({ submissionId: subA, task: 'synthesis' })).resolves.toBeUndefined();
  });

  it('records one llm-budget-80 system error when global usage crosses 80 %, at most once per 24 hours', async () => {
    config.LLM_DAILY_TOKEN_BUDGET = 1000;
    await usage(null, 'chat', 700);
    await assertLlmBudget();
    const alerts = () =>
      pool
        .query(`SELECT message FROM system_errors WHERE scope = 'llm-budget-80'`)
        .then((r) => r.rows as { message: string }[]);
    expect(await alerts()).toHaveLength(0);
    await usage(null, 'chat', 110);
    await assertLlmBudget();
    const first = await alerts();
    expect(first).toHaveLength(1);
    expect(first[0]?.message).toMatch(/81 %|81%/);
    await usage(null, 'chat', 50);
    await assertLlmBudget();
    expect(await alerts()).toHaveLength(1);
  });

  it('stores cost_usd on each call, null for an unknown model', async () => {
    await recordLlmCall({
      task: 'synthesis',
      skillName: 'synthesis',
      skillVersion: '1',
      model: 'claude-opus-5-5',
      submissionId: subA,
      status: 'SUCCESS',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      durationMs: 1,
    });
    await recordLlmCall({
      task: 'chat',
      skillName: 'chat',
      skillVersion: '1',
      model: 'mock-model',
      status: 'SUCCESS',
      usage: { input_tokens: 10, output_tokens: 10 },
      durationMs: 1,
    });
    const { rows } = await pool.query(`SELECT model, cost_usd FROM llm_calls ORDER BY id`);
    expect(rows.map((r) => [r.model, r.cost_usd === null ? null : Number(r.cost_usd)])).toEqual([
      ['claude-opus-5-5', 24],
      ['mock-model', null],
    ]);
  });

  it('reports USD spend by task, by model, per period and for the top submissions', async () => {
    const auth = await registerAdmin(app);
    const cost = (submissionId: string, task: string, usd: number, at = 'now()') =>
      pool.query(
        `INSERT INTO llm_calls (submission_id, task, skill_name, skill_version, model, status, input_tokens, output_tokens, duration_ms, cost_usd, created_at)
         VALUES ($1, $2, 'x', '1', 'claude-opus-5-5', 'SUCCESS', 10, 10, 1, $3, ${at})`,
        [submissionId, task, usd],
      );
    await cost(subA, 'synthesis', 10);
    await cost(subA, 'chat', 2.34);
    await cost(subB, 'analysis', 1);
    await cost(subB, 'analysis', 5, `now() - interval '3 days'`);
    await usage(null, 'chat', 10, 'mock-model'); // no price: no cost

    const day = (await request(app).get('/api/monitoring/llm-usage?range=24h').set(auth)).body;
    expect(day.summary.costUsd).toBeCloseTo(13.34, 6);
    expect(day.spend).toEqual({
      '24h': expect.closeTo(13.34, 6),
      '7d': expect.closeTo(18.34, 6),
      '30d': expect.closeTo(18.34, 6),
    });
    const byTask = Object.fromEntries(
      day.summary.byTask.map((t: { task: string; costUsd: number | null }) => [t.task, t.costUsd]),
    );
    expect(byTask).toEqual({ synthesis: 10, chat: 2.34, analysis: 1 });
    expect(
      day.summary.byModel.find((m: { task: string; model: string }) => m.task === 'chat' && m.model === 'mock-model')
        .costUsd,
    ).toBeNull();
    expect(day.topSubmissions).toEqual([
      { submissionId: subA, applicantName: 'Cost Test', calls: 2, costUsd: 12.34 },
      { submissionId: subB, applicantName: 'Cost Test', calls: 1, costUsd: 1 },
    ]);
  });

  it('leaves deleted submissions out of the top submissions by cost', async () => {
    const auth = await registerAdmin(app);
    const gone = await newSubmission();
    await pool.query(`UPDATE submissions SET deleted_at = now() WHERE id = $1`, [gone]);
    for (const [id, usd] of [
      [gone, 50],
      [subA, 1],
    ] as const)
      await pool.query(
        `INSERT INTO llm_calls (submission_id, task, skill_name, skill_version, model, status, input_tokens, output_tokens, duration_ms, cost_usd)
         VALUES ($1, 'chat', 'x', '1', 'claude-opus-5-5', 'SUCCESS', 10, 10, 1, $2)`,
        [id, usd],
      );
    const day = (await request(app).get('/api/monitoring/llm-usage?range=24h').set(auth)).body;
    expect(day.topSubmissions.map((s: { submissionId: string }) => s.submissionId)).toEqual([subA]);
  });

  it('reports spend as null, not $0, when no call in a period has a known price', async () => {
    const auth = await registerAdmin(app);
    await usage(subA, 'chat', 10, 'mock-model');
    const day = (await request(app).get('/api/monitoring/llm-usage?range=24h').set(auth)).body;
    expect(day.spend).toEqual({ '24h': null, '7d': null, '30d': null });
  });

  it('scrubs PII from the stored error text', async () => {
    await recordLlmCall({
      task: 'chat',
      skillName: 'chat',
      skillVersion: '1',
      model: 'claude-opus-5-5',
      submissionId: subA,
      status: 'ERROR',
      durationMs: 1,
      error: new Error('Could not parse output for jane@clinic.com, NPI 1234567893, phone 555-123-4567'),
    });
    const {
      rows: [r],
    } = await pool.query(`SELECT error FROM llm_calls`);
    expect(r.error).not.toMatch(/jane@clinic\.com|1234567893|555-123-4567/);
    expect(r.error).toContain('[REDACTED-EMAIL]');
  });
});
