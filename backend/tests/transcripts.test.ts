/**
 * LLM transcripts (spec §4): every Claude call records SHA-256 hashes of its system prompt and outbound prompt;
 * LLM_STORE_TRANSCRIPTS decides which calls also keep the full (redacted) prompt and raw output. Reports and chat
 * answers link to their call; admins read a transcript on Monitoring. The Anthropic SDK is mocked; the database is real.
 */
import { createHash } from 'node:crypto';

import type * as Sdk from '@anthropic-ai/sdk';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { config as Config } from '../src/config.js';
import type * as AnthropicSettings from '../src/services/anthropicSettings.js';
import type * as Claude from '../src/services/claude.js';
import { makeUser, registerAdmin, startTestApp, stopTestApp, testDatabaseUrl, waitFor } from './helpers/apiTestDb.js';

vi.mock('../src/services/driveStorage.js', async (orig) =>
  (await import('./helpers/fakeDrive.js')).fakeDrive(await orig()),
);

const DB_NAME = 'ims_test_transcripts';
process.env.DATABASE_URL = testDatabaseUrl(DB_NAME);

vi.mock('../src/services/anthropicSettings.js', async (orig) => ({
  ...(await orig<typeof AnthropicSettings>()),
  anthropicApiKey: () => 'sk-ant-test-key-0123456789',
  anthropicModel: () => 'claude-sonnet-5-5',
}));

/** What the mocked API answers next, as the text of its single content block. */
const reply = vi.hoisted(() => ({ text: '{}' }));
vi.mock('@anthropic-ai/sdk', async (orig) => {
  const real = await orig<typeof Sdk>();
  class Fake extends real.default {
    constructor(opts: ConstructorParameters<typeof real.default>[0]) {
      super(opts);
      (this as unknown as { beta: unknown }).beta = {
        messages: {
          stream: (body: { model: string }) => ({
            finalMessage: async () => ({
              model: body.model,
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 5 },
              content: [{ type: 'text', text: reply.text }],
            }),
          }),
        },
      };
    }
  }
  return { ...real, default: Fake };
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const SYNTHESIS = {
  submissionOverview: 'OB/GYN submission.',
  applicantProfile: {
    name: 'Jane Smith',
    npi: null,
    specialty: 'OB/GYN',
    state: 'TX',
    practiceName: null,
    yearsInPractice: null,
    other: [],
  },
  emailAndAttachmentInventory: [],
  extractedFacts: [],
  npiVerificationSummary: 'none',
  conflicts: [],
  missingInformation: [],
  dataConfidence: { overall: 'MEDIUM', notes: '' },
  consolidatedContextForLlm: 'brief',
};

const skill = {
  name: 'test-skill',
  version: '1.0.0+abc',
  files: ['SKILL.md'],
  systemPrompt: 'You are a test skill.',
  overridden: [],
};

let app: Express;
let pool: pg.Pool;
let admin: { Authorization: string };
let claude: typeof Claude;
let config: typeof Config;

beforeAll(async () => {
  ({ app, pool } = await startTestApp(DB_NAME));
  admin = await registerAdmin(app);
  claude = await import('../src/services/claude.js');
  ({ config } = await import('../src/config.js'));
});

afterAll(stopTestApp);

beforeEach(() => {
  config.LLM_STORE_TRANSCRIPTS = 'decisions';
});

const transcript = async (callId: string | null) =>
  (await pool.query('SELECT * FROM llm_transcripts WHERE llm_call_id=$1', [callId])).rows[0];

describe('LLM transcripts', () => {
  it('stores the redacted prompt and raw output of a decision call', async () => {
    reply.text = '{"ok":true}';
    const res = await claude.structuredCall({
      skill,
      prompt: 'Applicant SSN 123-45-6789, OB/GYN in TX',
      schema: z.object({ ok: z.boolean() }),
      effort: 'high',
      task: 'synthesis',
      maxTokens: 1000,
    });
    expect(res.callId).toMatch(/^\d+$/);
    const t = await transcript(res.callId);
    expect(t.prompt).toContain('[REDACTED-SSN]');
    expect(t.prompt).not.toContain('123-45-6789');
    expect(t.output).toBe('{"ok":true}');
    expect(t.system_sha256).toBe(sha256(skill.systemPrompt));
    expect(t.prompt_sha256).toBe(sha256(t.prompt));
  });

  it('keeps hashes only for a non-decision call under "decisions"', async () => {
    reply.text = '{"ok":true}';
    const res = await claude.structuredCall({
      skill,
      prompt: 'Classify this email',
      schema: z.object({ ok: z.boolean() }),
      effort: 'low',
      task: 'classification',
      maxTokens: 1000,
    });
    const t = await transcript(res.callId);
    expect(t.prompt).toBeNull();
    expect(t.output).toBeNull();
    expect(t.prompt_sha256).toBe(sha256('Classify this email'));
    expect(t.system_sha256).toBe(sha256(skill.systemPrompt));
  });

  it('keeps hashes only for every call when "off"', async () => {
    config.LLM_STORE_TRANSCRIPTS = 'off';
    reply.text = '{"ok":true}';
    const res = await claude.structuredCall({
      skill,
      prompt: 'Synthesise',
      schema: z.object({ ok: z.boolean() }),
      effort: 'high',
      task: 'synthesis',
      maxTokens: 1000,
    });
    const t = await transcript(res.callId);
    expect(t.prompt).toBeNull();
    expect(t.output).toBeNull();
    expect(t.prompt_sha256).toBe(sha256('Synthesise'));
  });

  it('stores every call when "all"', async () => {
    config.LLM_STORE_TRANSCRIPTS = 'all';
    reply.text = '{"ok":false}';
    const res = await claude.structuredCall({
      skill,
      prompt: 'Classify me',
      schema: z.object({ ok: z.boolean() }),
      effort: 'low',
      task: 'classification',
      maxTokens: 1000,
    });
    const t = await transcript(res.callId);
    expect(t.prompt).toBe('Classify me');
    expect(t.output).toBe('{"ok":false}');
  });

  it('stores a chat transcript with every outbound turn', async () => {
    reply.text = 'The limits are 1M/3M.';
    const res = await claude.chatCall({
      skill,
      context: 'Limits 1M/3M',
      messages: [{ role: 'user', content: 'What limits?' }],
    });
    const t = await transcript(res.callId);
    expect(t.prompt).toContain('Limits 1M/3M');
    expect(t.prompt).toContain('What limits?');
    expect(t.output).toBe('The limits are 1M/3M.');
  });

  it('a transcript write failure never fails the call', async () => {
    const { logger } = await import('../src/logger.js');
    const warn = vi.spyOn(logger, 'warn');
    await pool.query('ALTER TABLE llm_transcripts RENAME TO llm_transcripts_off');
    try {
      reply.text = '{"ok":true}';
      const res = await claude.structuredCall({
        skill,
        prompt: 'Synthesise',
        schema: z.object({ ok: z.boolean() }),
        effort: 'high',
        task: 'synthesis',
        maxTokens: 1000,
      });
      expect(res.data).toEqual({ ok: true });
      expect(warn).toHaveBeenCalledWith(expect.anything(), 'Failed to record LLM transcript');
    } finally {
      await pool.query('ALTER TABLE llm_transcripts_off RENAME TO llm_transcripts');
      warn.mockRestore();
    }
  });
});

describe('report link and transcript endpoint', () => {
  let reportCallId: string;

  it('sets the report row llm_call_id', async () => {
    const {
      rows: [email],
    } = await pool.query(
      `INSERT INTO emails (from_address, subject, body_text, received_at) VALUES ('broker@acme.com','OB/GYN quote','Applicant Jane Smith, OB/GYN, TX', now()) RETURNING id`,
    );
    const {
      rows: [sub],
    } = await pool.query(
      `INSERT INTO submissions (email_id, status, classification) VALUES ($1,'READY_FOR_REVIEW','SUBMISSION') RETURNING id`,
      [email.id],
    );
    reply.text = JSON.stringify(SYNTHESIS);
    const { startReport } = await import('../src/services/reports.js');
    const reportId = await startReport(sub.id, 'SYNTHESIS', null);
    const row = await waitFor(
      async () => (await pool.query('SELECT status, llm_call_id FROM reports WHERE id=$1', [reportId])).rows[0],
      (r) => r.status !== 'RUNNING',
    );
    expect(row.status).toBe('COMPLETED');
    expect(row.llm_call_id).not.toBeNull();
    reportCallId = String(row.llm_call_id);
    const t = await transcript(reportCallId);
    expect(t.output).toBe(JSON.stringify(SYNTHESIS));
  });

  it('returns a transcript to monitoring managers and audits the view', async () => {
    const res = await request(app).get(`/api/monitoring/llm-calls/${reportCallId}/transcript`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      callId: reportCallId,
      task: 'synthesis',
      model: 'claude-sonnet-5-5',
      output: JSON.stringify(SYNTHESIS),
    });
    expect(res.body.systemSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof res.body.prompt).toBe('string');
    expect(typeof res.body.createdAt).toBe('string');
    const { rowCount } = await pool.query(
      `SELECT 1 FROM audit_events WHERE action='LLM_TRANSCRIPT_VIEWED' AND entity_id=$1`,
      [reportCallId],
    );
    expect(rowCount).toBe(1);
  });

  it('refuses users without monitoring:manage', async () => {
    const viewer = await makeUser(pool, 'viewer@example.com', 'VIEWER');
    const res = await request(app).get(`/api/monitoring/llm-calls/${reportCallId}/transcript`).set(viewer.auth);
    expect(res.status).toBe(403);
  });

  it('answers 404 for an unknown or malformed call id', async () => {
    expect((await request(app).get('/api/monitoring/llm-calls/999999999/transcript').set(admin)).status).toBe(404);
    expect((await request(app).get('/api/monitoring/llm-calls/abc/transcript').set(admin)).status).toBe(404);
  });
});
