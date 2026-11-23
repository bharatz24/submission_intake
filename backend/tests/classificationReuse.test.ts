import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../src/services/claude.js';

const structuredCall = vi.fn();
vi.mock('../src/services/claude.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/claude.js')>()),
  claudeAvailable: () => true,
  structuredCall: (...args: unknown[]) => structuredCall(...args),
}));
// Rules that never decide on their own, so every email goes to Claude.
vi.mock('../src/services/classificationRules.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/classificationRules.js')>()),
  applyRules: () => ({ decisive: null, score: 2, reasons: ['+2: mentions malpractice'], submissionEvidence: false }),
}));

const { classifyEmail, clearRecentVerdicts } = await import('../src/services/classification.js');
const { cachedSystem, cacheTtl } =
  await vi.importActual<typeof import('../src/services/claude.js')>('../src/services/claude.js');
const { cacheSavingsUsd } = await import('../src/services/llmUsage.js');
const { SKILLS_ROOT, loadSkill } = await import('../src/services/skills.js');
const { limits } = await import('../src/services/limitsSettings.js');

const email = {
  fromAddress: 'ryzel@prms-us.com',
  subject: 'Platform UX Audit',
  bodyText: 'Same text',
  attachmentNames: [] as string[],
};
const verdict = {
  data: { classification: 'NOT_SUBMISSION', confidence: 0.95, reasons: ['Vendor pitch'] },
  usage: { inputTokens: 1, outputTokens: 1 },
  model: 'm',
};

describe("Repeat emails reuse Claude's verdict", () => {
  beforeEach(() => {
    clearRecentVerdicts();
    structuredCall.mockReset().mockResolvedValue(verdict);
  });

  it('asks Claude once for two identical emails on automatic runs', async () => {
    const first = await classifyEmail(email, undefined, { reuse: true });
    const second = await classifyEmail(email, undefined, { reuse: true });
    expect(structuredCall).toHaveBeenCalledTimes(1);
    expect(second.classification).toBe(first.classification);
    expect(second.reasons.at(-1)).toMatch(/reused/);
    expect(first.reasons.join(' ')).not.toMatch(/reused/);
  });

  it('shares a call still in flight', async () => {
    await Promise.all([
      classifyEmail(email, undefined, { reuse: true }),
      classifyEmail(email, undefined, { reuse: true }),
    ]);
    expect(structuredCall).toHaveBeenCalledTimes(1);
  });

  it('asks again when anything in the email differs', async () => {
    await classifyEmail(email, undefined, { reuse: true });
    await classifyEmail({ ...email, bodyText: 'Different text' }, undefined, { reuse: true });
    await classifyEmail({ ...email, attachmentNames: ['application.pdf'] }, undefined, { reuse: true });
    expect(structuredCall).toHaveBeenCalledTimes(3);
  });

  it("always asks Claude when reuse is off (a person's re-run)", async () => {
    await classifyEmail(email, undefined, { reuse: true });
    await classifyEmail(email, undefined, { reuse: false });
    await classifyEmail(email);
    expect(structuredCall).toHaveBeenCalledTimes(3);
  });

  it('does not remember a failed call', async () => {
    structuredCall.mockRejectedValueOnce(new Error('overloaded'));
    await expect(classifyEmail(email, undefined, { reuse: true })).rejects.toThrow('overloaded');
    await classifyEmail(email, undefined, { reuse: true });
    expect(structuredCall).toHaveBeenCalledTimes(2);
  });
});

describe('Prompt caching', () => {
  it("sends the skill text as one cached system block with the task's lifetime", () => {
    const skill = { systemPrompt: 'Skill text' } as Parameters<typeof cachedSystem>[0];
    expect(cachedSystem(skill, '1h')).toEqual([
      { type: 'text', text: 'Skill text', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    expect(cachedSystem(skill)[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('keeps bursty tasks on 5 minutes and large, recurring skills on an hour', () => {
    expect(['classification', 'extraction', 'quote'].map((t) => cacheTtl(t as Task))).toEqual(['5m', '5m', '5m']);
    expect(['synthesis', 'analysis', 'comparison', 'email_draft', 'chat'].map((t) => cacheTtl(t as Task))).toEqual([
      '1h',
      '1h',
      '1h',
      '1h',
      '1h',
    ]);
  });

  it('loads every skill as the same text each time, so its cache entry is reused', () => {
    for (const name of readdirSync(SKILLS_ROOT).filter((d) => existsSync(path.join(SKILLS_ROOT, d, 'SKILL.md')))) {
      expect(loadSkill(name).systemPrompt).toBe(loadSkill(name).systemPrompt);
    }
  });

  it('starts a new cache entry when a skill is edited in Settings, and reads the old one never again', () => {
    const before = loadSkill('email-classification').systemPrompt;
    const edited = loadSkill('email-classification', SKILLS_ROOT, {
      'SKILL.md': `${readFileSync(path.join(SKILLS_ROOT, 'email-classification', 'SKILL.md'), 'utf8')}\nOne more rule.`,
    });
    expect(edited.systemPrompt).not.toBe(before);
    expect(edited.systemPrompt.startsWith(before.slice(0, 200))).toBe(true);
  });
});

describe('Report skills', () => {
  it('name the model they run on, and cap output well above the longest report so far', () => {
    expect(loadSkill('synthesis').model).toBe('claude-sonnet-5-5');
    expect(loadSkill('underwriting-analysis').model).toBe('claude-sonnet-5-5');
    expect(limits()).toMatchObject({
      synthesisMaxTokens: 32_000,
      analysisMaxTokens: 32_000,
      comparisonMaxTokens: 32_000,
    });
  });
});

describe('Cache savings estimate', () => {
  it("counts reads as savings and write premiums as costs, at the model's price", () => {
    // Opus 5.5: $4/MTok input, reads at 0.05x. 1M read saves $3.80; 1M one-hour write costs $4 extra.
    expect(cacheSavingsUsd('claude-opus-5-5', { cacheRead: 1_000_000, cacheWrite: 0, cacheWrite1h: 0 })).toBeCloseTo(
      3.8,
    );
    expect(
      cacheSavingsUsd('claude-opus-5-5', { cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }),
    ).toBeCloseTo(-4);
    // Haiku 5.5: $0.10/MTok; a 5-minute write costs 0.25x extra.
    expect(cacheSavingsUsd('claude-haiku-5-5', { cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 0 })).toBeCloseTo(
      -0.025,
    );
    expect(
      cacheSavingsUsd('claude-opus-5-5-20260101', { cacheRead: 1_000_000, cacheWrite: 0, cacheWrite1h: 0 }),
    ).toBeCloseTo(3.8);
    expect(cacheSavingsUsd('mock-model', { cacheRead: 1, cacheWrite: 0, cacheWrite1h: 0 })).toBeNull();
  });
});
