/**
 * End-to-end API test against a real PostgreSQL database (TEST_DATABASE_URL, default
 * the docker-compose db's `ims_test` database). Claude, the NPI registry and Google Drive are mocked;
 * everything else (HTTP, auth, pipeline, storage, versioning, audit) runs for real.
 */
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Scripts (and these tests) ask for the session token in the login body; browsers get only the cookie.
const CLI = { 'X-Client': 'cli' };

vi.mock('../src/services/driveStorage.js', async (orig) =>
  (await import('./helpers/fakeDrive.js')).fakeDrive(await orig()),
);

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_test';
process.env.DATABASE_URL = TEST_DB;

// The task and output limit of every structured Claude call, for the Settings → Limits test.
const llmCalls = vi.hoisted(() => [] as { task?: string; maxTokens?: number }[]);
vi.mock('../src/services/claude.js', async () => {
  const { SynthesisSchema, AnalysisSchema, ComparisonSchema, EmailDraftSchema } = await import(
    '../src/services/reportSchemas.js'
  );
  return {
    claudeAvailable: () => true,
    claudeModel: () => 'mock-model',
    chatCall: async () => ({
      text: 'The applicant is Jane Smith (application.txt).',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'mock-model',
    }),
    structuredCall: async ({ schema, task, maxTokens }: { schema: unknown; task?: string; maxTokens?: number }) => {
      llmCalls.push({ task, maxTokens });
      // Emails the rules can't decide reach the LLM; without this they got the field-extraction shape and ended in ERROR.
      if (task === 'classification') {
        return {
          model: 'mock-model',
          usage: { inputTokens: 1, outputTokens: 1 },
          data: {
            classification: 'SUBMISSION',
            confidence: 0.9,
            reasons: ['Asks for a quote'],
          },
        };
      }
      if (schema === SynthesisSchema) {
        return {
          model: 'mock-model',
          usage: { inputTokens: 10, outputTokens: 10 },
          data: {
            submissionOverview: 'OB/GYN submission from Acme Brokers.',
            applicantProfile: {
              name: 'Jane Smith',
              npi: '1234567893',
              specialty: 'OB/GYN',
              state: 'TX',
              practiceName: null,
              yearsInPractice: null,
              other: [],
            },
            emailAndAttachmentInventory: [
              { item: 'application.txt', type: 'application', status: 'EXTRACTED', notes: '' },
            ],
            extractedFacts: [{ text: 'NPI 1234567893', source: 'application.txt', confidence: 'HIGH' }],
            npiVerificationSummary: 'MATCH',
            conflicts: [],
            missingInformation: [{ item: 'Loss runs', importance: 'CRITICAL', reason: 'not attached' }],
            dataConfidence: { overall: 'MEDIUM', notes: 'no loss runs' },
            consolidatedContextForLlm: 'brief',
          },
        };
      }
      if (schema === AnalysisSchema) {
        return {
          model: 'mock-model',
          usage: { inputTokens: 10, outputTokens: 10 },
          data: {
            executiveSummary: 'Needs loss runs.',
            overallRisk: 'MODERATE',
            recommendation: 'REQUEST_INFORMATION',
            riskIndicators: [],
            applicationCompleteness: { score: 80, summary: 'Missing loss runs', gaps: ['Loss runs'] },
            inconsistencies: [],
            potentialConcerns: [],
            missingInformation: ['Loss runs'],
            followUpQuestions: [{ question: 'Please send loss runs', rationale: 'Required', addressedTo: 'Broker' }],
            recommendedNextSteps: ['Request loss runs'],
            limitationsAndUncertainties: [],
          },
        };
      }
      if (schema === EmailDraftSchema) {
        return {
          model: 'mock-haiku',
          usage: { inputTokens: 5, outputTokens: 5 },
          data: {
            purpose: 'REQUEST_INFORMATION',
            draft: {
              to: 'broker@acme.test',
              subject: 'RE: Quote request',
              body: 'Hi,\n\n• Loss runs for the past 10 years\n\nBest regards,\n[Underwriter Name]',
              keyPoints: ['Loss runs for the past 10 years'],
            },
          },
        };
      }
      if (schema === ComparisonSchema) {
        return {
          model: 'mock-model',
          usage: { inputTokens: 5, outputTokens: 5 },
          data: {
            summary: 'Data confidence dropped.',
            overallChange: 'MINOR',
            changes: [
              {
                section: 'dataConfidence',
                fieldPath: 'dataConfidence.overall',
                changeType: 'MODIFIED',
                before: 'HIGH',
                after: 'MEDIUM',
                significance: 'MEDIUM',
                explanation: 'Less reliance on extracted facts',
                likelyCause: 'MODEL_VARIANCE',
              },
            ],
            unchangedSections: ['applicantProfile'],
            reviewerNote: 'Rely on v2.',
          },
        };
      }
      // field extraction
      return {
        model: 'mock-model',
        usage: { inputTokens: 1, outputTokens: 1 },
        data: {
          fields: [
            {
              fieldName: 'applicant_name',
              value: 'Jane Smith',
              confidence: 0.95,
              evidenceQuote: 'Applicant: Jane Smith',
              sourceLabel: 'application.txt',
            },
            {
              fieldName: 'npi',
              value: '1234567893',
              confidence: 0.95,
              evidenceQuote: 'NPI 1234567893',
              sourceLabel: 'application.txt',
            },
            {
              fieldName: 'practice_state',
              value: 'TX',
              confidence: 0.9,
              evidenceQuote: 'State: TX',
              sourceLabel: 'application.txt',
            },
          ],
        },
      };
    },
  };
});

vi.mock('../src/services/npi.js', async (orig) => {
  const real = await orig<typeof import('../src/services/npi.js')>();
  return {
    ...real,
    lookupNpi: vi.fn(async () => ({
      found: true,
      result: {
        enumeration_type: 'NPI-1',
        basic: { first_name: 'JANE', last_name: 'SMITH', status: 'A' },
        taxonomies: [{ primary: true, desc: 'Obstetrics & Gynecology', state: 'TX' }],
        addresses: [],
      },
    })),
  };
});

// Gmail is connected over OAuth and accepts every message; tests read what would have been sent.
const sentMail = vi.hoisted(() => [] as any[]);
// What a Gmail search for recent messages returns, and the searches it was asked for.
const recentGmail = vi.hoisted(() => ({
  ids: [] as string[],
  calls: [] as { days: number; automatic: boolean; after?: string }[],
}));
vi.mock('../src/services/gmail.js', async (orig) => {
  const real = await orig<typeof import('../src/services/gmail.js')>();
  return {
    ...real,
    status: async () => ({
      source: 'OAUTH',
      configured: true,
      connected: true,
      email: 'uw@insurer.com',
      mode: 'POLLING',
      lastPollAt: null,
      lastHistoryId: null,
      watchExpiresAt: null,
      error: null,
    }),
    listRecentMessageIds: async (days: number, opts: { automatic?: boolean; after?: Date } = {}) => {
      recentGmail.calls.push({
        days,
        automatic: Boolean(opts.automatic),
        ...(opts.after ? { after: opts.after.toISOString() } : {}),
      });
      return recentGmail.ids;
    },
    sendMessage: async (msg: any) => {
      sentMail.push(msg);
      return {
        transport: 'OAUTH',
        messageId: `sent-${sentMail.length}`,
        threadId: msg.threadId ?? `new-thread-${sentMail.length}`,
      };
    },
  };
});

let app: import('express').Express;
let pool: pg.Pool;
let token = '';

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout; last value: ${JSON.stringify(v).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ims_test WITH (FORCE)');
  await admin.query('CREATE DATABASE ims_test');
  await admin.end();
  const { migrate } = await import('../src/db/migrate.js');
  await migrate();
  ({ pool } = await import('../src/db/pool.js'));
  app = (await import('../src/app.js')).createApp();
});

afterAll(async () => {
  // Workers and the LISTEN connection first, so nothing touches the pool after it ends.
  await (await import('../src/services/jobQueue.js')).jobs.stop(5000);
  await (await import('../src/services/pgListen.js')).closeListener();
  if (pool) await (await import('../src/db/pool.js')).closePools();
});

describe('API flow', () => {
  it('bootstraps the first admin and logs in', async () => {
    expect((await request(app).get('/api/auth/bootstrap')).body).toEqual({
      needsSetup: true,
      setupTokenRequired: false,
    });
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'Admin@Example.com', password: 'correct-horse-battery', name: 'Ada Admin' });
    expect(reg.status).toBe(201);
    expect(reg.body.user.role).toBe('ADMIN');
    const login = await request(app)
      .post('/api/auth/login')
      .set(CLI)
      .send({ email: 'admin@example.com', password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
    token = login.body.token;
    expect(
      (await request(app).post('/api/auth/register').send({ email: 'x@y.com', password: 'abcdefghijk', name: 'X' }))
        .status,
    ).toBe(403);
  });

  it('rejects unauthenticated access', async () => {
    expect((await request(app).get('/api/submissions')).status).toBe(401);
  });

  let submissionId = '';
  // Synthesis, Analysis and comparison each get their own output limit (Settings → Limits); set by the synthesis test,
  // reset by the comparison test.
  const REPORT_LIMITS = { synthesisMaxTokens: 21_000, analysisMaxTokens: 22_000, comparisonMaxTokens: 23_000 };
  const callsOf = (task: string) => llmCalls.filter((c) => c.task === task);
  it('ingests a manual submission and processes it end-to-end', async () => {
    const res = await request(app)
      .post('/api/submissions/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('subject', 'New submission - Dr. Jane Smith OB/GYN professional liability')
      .field('fromAddress', 'broker@acme.com')
      .field('bodyText', 'Please quote. Application attached. NPI 1234567893. Effective date 2027-01-01. Limits 1M/3M.')
      .attach(
        'files',
        Buffer.from('Applicant: Jane Smith\nNPI 1234567893\nState: TX\nSpecialty: OB/GYN'),
        'application.txt',
      );
    expect(res.status).toBe(201);
    submissionId = res.body.id;

    const detail = await waitFor(
      async () =>
        (await request(app).get(`/api/submissions/${submissionId}`).set('Authorization', `Bearer ${token}`)).body,
      (b) => b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR',
    );
    expect(detail.processingError).toBeNull();
    expect(detail.status).toBe('READY_FOR_REVIEW');
    expect(detail.classification).toBe('SUBMISSION');
    expect(detail.applicantName).toBe('Jane Smith');
    expect(detail).toMatchObject({
      applicantType: 'INDIVIDUAL',
      applicantFirstName: 'Jane',
      applicantLastName: 'Smith',
      applicantEntityName: null,
    });
    expect(detail.documents[0].extractionStatus).toBe('EXTRACTED');
    expect(detail.extractedFields).toHaveLength(3);
    expect(detail.npiVerifications[0].status).toBe('MATCH');
    expect(detail.npiVerifications[0]).toMatchObject({
      claimedType: 'INDIVIDUAL',
      claimedFirstName: 'Jane',
      claimedLastName: 'Smith',
      claimedEntityName: null,
      registryType: 'INDIVIDUAL',
      registryFirstName: 'JANE',
      registryLastName: 'SMITH',
      registryEntityName: null,
    });
    expect(detail.contextVersion).toBe(1);
  });

  it('generates versioned synthesis then analysis reports', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request(app).post(`/api/submissions/${submissionId}/analysis`).set(auth).send({})).status).toBe(409);
    // No completed analysis yet: nothing to draft from.
    const noDraft = await request(app)
      .post(`/api/submissions/${submissionId}/email-drafts`)
      .set(auth)
      .send({ audience: 'broker' });
    expect(noDraft.status).toBe(409);
    expect(noDraft.body.error.code).toBe('NO_ANALYSIS');

    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('limits_settings', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify(REPORT_LIMITS)],
    );
    await (await import('../src/services/limitsSettings.js')).refreshLimitsSettings();
    llmCalls.length = 0;
    const s1 = await request(app).post(`/api/submissions/${submissionId}/synthesis`).set(auth);
    expect(s1.status).toBe(202);
    const syn = await waitFor(
      async () => (await request(app).get(`/api/reports/${s1.body.id}`).set(auth)).body,
      (b) => b.status !== 'RUNNING',
    );
    expect(syn.status).toBe('COMPLETED');
    expect(syn.version).toBe(1);
    expect(syn.skillVersion).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{10}$/);
    expect(syn.markdown).toContain('Synthesis Report v1');

    // Same evidence and skill version: the completed v1 is returned unless the request forces a new run.
    const same = await request(app).post(`/api/submissions/${submissionId}/synthesis`).set(auth).send({});
    expect(same.body).toMatchObject({ id: s1.body.id, version: 1, status: 'COMPLETED' });
    const s2 = await request(app).post(`/api/submissions/${submissionId}/synthesis`).set(auth).send({ force: true });
    await waitFor(
      async () => (await request(app).get(`/api/reports/${s2.body.id}`).set(auth)).body,
      (b) => b.status !== 'RUNNING',
    );
    expect(s2.body.version).toBe(2);

    const a1 = await request(app).post(`/api/submissions/${submissionId}/analysis`).set(auth).send({});
    expect(a1.status).toBe(202);
    const ana = await waitFor(
      async () => (await request(app).get(`/api/reports/${a1.body.id}`).set(auth)).body,
      (b) => b.status !== 'RUNNING',
    );
    expect(ana.status).toBe('COMPLETED');
    expect(ana.basedOnReportId).toBe(s2.body.id);
    expect(ana.content.recommendation).toBe('REQUEST_INFORMATION');
    expect(callsOf('synthesis')).toEqual([
      { task: 'synthesis', maxTokens: 21_000 },
      { task: 'synthesis', maxTokens: 21_000 },
    ]);
    expect(callsOf('analysis')).toEqual([{ task: 'analysis', maxTokens: 22_000 }]);

    const list = await request(app).get(`/api/submissions/${submissionId}/reports?kind=SYNTHESIS`).set(auth);
    expect(list.body.items.map((r: { version: number }) => r.version)).toEqual([2, 1]);

    // Nothing generated yet.
    const draftState = async () =>
      (await request(app).get(`/api/submissions/${submissionId}/email-drafts?audience=broker`).set(auth)).body;
    expect(await draftState()).toEqual({ draft: null, run: null });
    // Generate queues a job (202); the dialog polls until the run is no longer PENDING. Waits for a draft other than
    // the one shown before, and a failed run fails the test with its error (QA-007: flaky when the run failed).
    const generated = async (previousId: string | null = null) => {
      const res = await request(app)
        .post(`/api/submissions/${submissionId}/email-drafts`)
        .set(auth)
        .send({ audience: 'broker' });
      expect(res.status).toBe(202);
      expect(res.body.run).toMatchObject({ status: 'PENDING', error: null });
      const state = await waitFor(
        draftState,
        (s) => s.run?.status === 'FAILED' || (s.run === null && !!s.draft && s.draft.id !== previousId),
      );
      expect(state.run?.error ?? null).toBeNull();
      return state;
    };
    // Draft calls are recorded under their own task (Claude is mocked here, so the row is written directly, then
    // rolled back to keep the usage totals the monitoring test expects).
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(`INSERT INTO llm_calls (task, skill_name, skill_version, model, status, input_tokens, output_tokens, duration_ms)
        VALUES ('email_draft', 'email-draft', 'test', 'mock-haiku', 'SUCCESS', 1, 1, 1)`);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
    const drafts = { body: (await generated()).draft };
    expect(drafts.body).toMatchObject({
      purpose: 'REQUEST_INFORMATION',
      analysisReportId: a1.body.id,
      analysisVersion: ana.version,
      synthesisVersion: 2,
      newerAnalysisVersion: null,
      stale: false,
      model: 'mock-haiku',
      createdBy: { name: expect.any(String) },
      audience: 'broker',
      draft: { to: 'broker@acme.test', keyPoints: ['Loss runs for the past 10 years'] },
    });
    // An unknown audience is rejected.
    expect(
      (await request(app).post(`/api/submissions/${submissionId}/email-drafts`).set(auth).send({ audience: 'nobody' }))
        .status,
    ).toBe(400);
    // Saved: reopening reads the same drafts, without another Claude call.
    const callsBefore = (
      await pool.query(`SELECT count(*)::int AS n FROM email_drafts WHERE submission_id=$1`, [submissionId])
    ).rows[0].n;
    expect(await draftState()).toEqual({ draft: drafts.body, run: null });
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM email_drafts WHERE submission_id=$1`, [submissionId])).rows[0]
        .n,
    ).toBe(callsBefore);
    // Regenerate saves a new set, which becomes the one shown.
    const again = { body: (await generated(drafts.body.id)).draft };
    expect(again.body.id).not.toBe(drafts.body.id);
    expect((await draftState()).draft.id).toBe(again.body.id);
    // Manual edits are saved onto the draft, with no new Claude call or row.
    const rowsBefore = (
      await pool.query(`SELECT count(*)::int AS n FROM email_drafts WHERE submission_id=$1`, [submissionId])
    ).rows[0].n;
    const edited = await request(app)
      .put(`/api/submissions/${submissionId}/email-drafts/${again.body.id}`)
      .set(auth)
      .send({ subject: 'Edited', body: 'My own words' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id: again.body.id, draft: { subject: 'Edited', body: 'My own words' } });
    expect((await draftState()).draft.draft).toMatchObject({ subject: 'Edited', body: 'My own words' });
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM email_drafts WHERE submission_id=$1`, [submissionId])).rows[0]
        .n,
    ).toBe(rowsBefore);
    expect(
      (
        await request(app)
          .put(`/api/submissions/${submissionId}/email-drafts/00000000-0000-4000-8000-000000000000`)
          .set(auth)
          .send({ subject: 'x', body: 'y' })
      ).status,
    ).toBe(404);
    // Drafts are never sent; generating one is audited.
    expect(
      (await request(app).get(`/api/submissions/${submissionId}/outbound-emails`).set(auth)).body.items,
    ).toHaveLength(0);
    const trail = await request(app).get(`/api/submissions/${submissionId}/audit`).set(auth);
    expect(trail.body.items.filter((e: { action: string }) => e.action === 'EMAIL_DRAFT_GENERATED')).toHaveLength(2);
  });

  it('records assessments, chat, versions and an immutable audit trail', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const a = await request(app)
      .post(`/api/submissions/${submissionId}/assessments`)
      .set(auth)
      .send({ decision: 'REQUEST_INFORMATION', riskRating: 'MODERATE', notes: 'Need loss runs' });
    expect(a.status).toBe(201);
    expect(a.body.version).toBe(1);

    // Asking answers 202 with the question and a PENDING answer, which a job fills in.
    const chat = await request(app)
      .post(`/api/submissions/${submissionId}/chat`)
      .set(auth)
      .send({ message: 'Who is the applicant?' });
    expect(chat.status).toBe(202);
    expect(chat.body.map((m: { role: string; status: string }) => [m.role, m.status])).toEqual([
      ['user', 'COMPLETED'],
      ['assistant', 'PENDING'],
    ]);
    const thread = await waitFor(
      async () => (await request(app).get(`/api/submissions/${submissionId}/chat`).set(auth)).body.items,
      (ms: { status: string }[]) => ms.every((m) => m.status !== 'PENDING'),
    );
    expect(thread).toHaveLength(2);
    expect(thread[1]).toMatchObject({ id: chat.body[1].id, role: 'assistant', status: 'COMPLETED', error: null });
    expect(thread[1].content).toContain('Jane Smith');

    const versions = await request(app).get(`/api/submissions/${submissionId}/versions`).set(auth);
    expect(versions.body.contextVersions[0].version).toBe(1);
    expect(versions.body.reports).toHaveLength(3);

    const audit = await request(app).get(`/api/submissions/${submissionId}/audit`).set(auth);
    const actions = audit.body.items.map((e: { action: string }) => e.action);
    for (const act of [
      'EMAIL_RECEIVED',
      'DOCUMENT_STORED',
      'EMAIL_CLASSIFIED',
      'DOCUMENT_EXTRACTED',
      'NPI_VERIFIED',
      'CONTEXT_VERSION_CREATED',
      'SYNTHESIS_COMPLETED',
      'ANALYSIS_COMPLETED',
      'ASSESSMENT_RECORDED',
      'CHAT_QUESTION',
    ]) {
      expect(actions).toContain(act);
    }
    await expect(pool.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
  });

  it('exposes monitoring, skills and document download', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const stats = await request(app).get('/api/monitoring/stats').set(auth);
    expect(stats.body.reports.SYNTHESIS).toBe(2);
    await pool.query(
      `INSERT INTO llm_calls (submission_id, task, skill_name, skill_version, model, status, input_tokens, output_tokens, cache_read_tokens, duration_ms)
       VALUES ($1,'synthesis','synthesis','1.0.0','mock-model','SUCCESS',1000,200,500,1500)`,
      [submissionId],
    );
    await pool.query(
      `INSERT INTO llm_calls (task, skill_name, skill_version, model, status, input_tokens, output_tokens, duration_ms, created_at)
       VALUES ('chat','workspace-chat','1.0.0','mock-model','SUCCESS',300,40,900, now() - interval '3 days')`,
    );
    const llm = (await request(app).get('/api/monitoring/llm-usage').set(auth)).body;
    expect(llm.summary).toMatchObject({ calls: 1, inputTokens: 1500, outputTokens: 200 });
    expect(llm.requests.total).toBe(1);
    expect(llm.requests.items[0]).toMatchObject({
      task: 'synthesis',
      inputTokens: 1500,
      cacheReadTokens: 500,
      outputTokens: 200,
      submissionId,
    });
    const week = (await request(app).get('/api/monitoring/llm-usage?range=7d&pageSize=1&page=2').set(auth)).body;
    expect(week.summary).toMatchObject({ calls: 2, inputTokens: 1800, outputTokens: 240 });
    expect(week.summary.byModel).toEqual([
      {
        task: 'chat',
        model: 'mock-model',
        calls: 1,
        failed: 0,
        inputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 40,
        cacheSavingsUsd: null,
        costUsd: null,
      },
      {
        task: 'synthesis',
        model: 'mock-model',
        calls: 1,
        failed: 0,
        inputTokens: 1500,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        outputTokens: 200,
        cacheSavingsUsd: null,
        costUsd: null,
      },
    ]);
    // No price is known for the mock model, so nothing is claimed as saved.
    expect(week.summary).toMatchObject({ cacheReadTokens: 500, cacheWriteTokens: 0, cacheSavingsUsd: 0 });
    expect(week.requests).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(week.requests.items[0].task).toBe('chat');
    const byOutput = (await request(app).get('/api/monitoring/llm-usage?range=7d&sort=output&order=asc').set(auth))
      .body;
    expect(byOutput.requests.items.map((c: { outputTokens: number }) => c.outputTokens)).toEqual([40, 200]);
    expect((await request(app).get('/api/monitoring/llm-usage?sort=bogus').set(auth)).status).toBe(400);
    const skills = await request(app).get('/api/skills').set(auth);
    expect(skills.body.map((s: { name: string }) => s.name).sort()).toEqual([
      'auto-quote',
      'email-classification',
      'email-draft',
      'field-extraction',
      'report-comparison',
      'synthesis',
      'underwriting-analysis',
      'workspace-chat',
    ]);
    const detail = (await request(app).get(`/api/submissions/${submissionId}`).set(auth)).body;
    const dl = await request(app).get(`/api/documents/${detail.documents[0].id}/download`).set(auth);
    expect(dl.status).toBe(200);
    expect(dl.text ?? dl.body.toString()).toContain('Jane Smith');
    const view = await request(app).get(`/api/documents/${detail.documents[0].id}/view`).set(auth);
    expect(view.status).toBe(200);
    expect(view.headers['content-disposition']).toMatch(/^inline/);
    expect(view.headers['content-security-policy']).toContain('sandbox');
    expect(view.text).toContain('Jane Smith');
  });

  it('compares two versions of the same report kind only', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const syn = (await request(app).get(`/api/submissions/${submissionId}/reports?kind=SYNTHESIS`).set(auth)).body
      .items;
    const [ana] = (await request(app).get(`/api/submissions/${submissionId}/reports?kind=ANALYSIS`).set(auth)).body
      .items;
    const [v2, v1] = syn;
    const compare = (body: object) =>
      request(app).post(`/api/submissions/${submissionId}/comparisons`).set(auth).send(body);

    // Synthesis vs Analysis, a kind that doesn't match, the same version twice: all rejected.
    expect((await compare({ kind: 'SYNTHESIS', baseReportId: v1.id, targetReportId: ana.id })).status).toBe(400);
    expect((await compare({ kind: 'ANALYSIS', baseReportId: v1.id, targetReportId: v2.id })).status).toBe(400);
    expect((await compare({ kind: 'SYNTHESIS', baseReportId: v1.id, targetReportId: v1.id })).status).toBe(400);
    expect((await compare({ kind: 'BOTH', baseReportId: v1.id, targetReportId: v2.id })).status).toBe(400);

    // The mock writes identical syntheses: completed at once, no LLM call, base is the lower version whatever the order sent.
    const same = await compare({ kind: 'SYNTHESIS', baseReportId: v2.id, targetReportId: v1.id });
    expect(same.status).toBe(202);
    expect(same.body).toMatchObject({ status: 'COMPLETED', baseVersion: 1, targetVersion: 2, changeCount: 0 });
    expect((await request(app).get(`/api/comparisons/${same.body.id}`).set(auth)).body.content.overallChange).toBe(
      'NONE',
    );
    await pool.query('DELETE FROM report_comparisons WHERE id=$1', [same.body.id]);

    // Make v1 differ, then the skill explains the field diff.
    await pool.query(
      `UPDATE reports SET content_json = jsonb_set(content_json, '{dataConfidence,overall}', '"HIGH"') WHERE id=$1`,
      [v1.id],
    );
    llmCalls.length = 0;
    const diff = await compare({ kind: 'SYNTHESIS', baseReportId: v1.id, targetReportId: v2.id });
    expect(diff.status).toBe(202);
    const done = await waitFor(
      async () => (await request(app).get(`/api/comparisons/${diff.body.id}`).set(auth)).body,
      (b) => b.status !== 'RUNNING',
    );
    expect(done.status).toBe('COMPLETED');
    expect(done.fieldDiff).toEqual([
      {
        section: 'dataConfidence',
        path: 'dataConfidence.overall',
        changeType: 'MODIFIED',
        before: 'HIGH',
        after: 'MEDIUM',
      },
    ]);
    expect(done.content.changes[0].significance).toBe('MEDIUM');
    expect(done.markdown).toContain('# Synthesis v1 → v2 comparison');
    expect(callsOf('comparison')).toEqual([{ task: 'comparison', maxTokens: 23_000 }]);

    // The same pair is cached, and listed under its kind only.
    expect((await compare({ kind: 'SYNTHESIS', baseReportId: v1.id, targetReportId: v2.id })).body.id).toBe(
      diff.body.id,
    );
    expect(
      (await request(app).get(`/api/submissions/${submissionId}/comparisons?kind=SYNTHESIS`).set(auth)).body.items,
    ).toHaveLength(1);
    expect(
      (await request(app).get(`/api/submissions/${submissionId}/comparisons?kind=ANALYSIS`).set(auth)).body.items,
    ).toHaveLength(0);
    await pool.query(
      `UPDATE reports SET content_json = jsonb_set(content_json, '{dataConfidence,overall}', '"MEDIUM"') WHERE id=$1`,
      [v1.id],
    );
    await pool.query(`DELETE FROM app_settings WHERE key='limits_settings'`);
    await (await import('../src/services/limitsSettings.js')).refreshLimitsSettings();
  });

  it('views and edits skill files, admins only, with history and reset', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const url = '/api/skills/workspace-chat/files';
    const file = (await request(app).get(`${url}?path=SKILL.md`).set(auth)).body;
    expect(file).toMatchObject({ skill: 'workspace-chat', path: 'SKILL.md', overridden: false });
    expect(file.content).toBe(file.defaultContent);
    expect((await request(app).get(`${url}?path=../../package.json`).set(auth)).status).toBe(404);
    expect((await request(app).get('/api/skills/no-such-skill/files?path=SKILL.md').set(auth)).status).toBe(404);

    // A viewer can read but not save. Inserted and signed directly: no login (logins are rate limited).
    const { signToken } = await import('../src/http.js');
    await pool.query(
      "INSERT INTO users (id, email, name, password_hash, role) VALUES ('00000000-0000-4000-8000-000000000001', 'viewer@example.com', 'Vic Viewer', 'x', 'VIEWER') ON CONFLICT DO NOTHING",
    );
    const viewer = {
      Authorization: `Bearer ${signToken({ id: '00000000-0000-4000-8000-000000000001', email: 'viewer@example.com', name: 'Vic Viewer', role: 'VIEWER' })}`,
    };
    expect((await request(app).get(`${url}?path=SKILL.md`).set(viewer)).status).toBe(200);
    expect(
      (await request(app).put(url).set(viewer).send({ path: 'SKILL.md', content: 'x', baseHash: file.hash })).status,
    ).toBe(403);

    // Broken frontmatter and an invalid effort are rejected.
    expect(
      (await request(app).put(url).set(auth).send({ path: 'SKILL.md', content: 'no frontmatter', baseHash: file.hash }))
        .status,
    ).toBe(400);
    const badEffort = file.content.replace(/effort: \w+/, 'effort: turbo');
    expect(badEffort).not.toBe(file.content);
    expect(
      (await request(app).put(url).set(auth).send({ path: 'SKILL.md', content: badEffort, baseHash: file.hash }))
        .status,
    ).toBe(400);

    const edited = `${file.content}\n\nAlways answer in one paragraph.\n`;
    const saved = await request(app)
      .put(url)
      .set(auth)
      .send({ path: 'SKILL.md', content: edited, baseHash: file.hash, note: 'Shorter answers' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ overridden: true, content: edited });
    expect(saved.body.skillVersion).not.toBe(file.skillVersion);
    const skills = (await request(app).get('/api/skills').set(auth)).body;
    expect(skills.find((s: { name: string }) => s.name === 'workspace-chat').overridden).toEqual(['SKILL.md']);

    // Saving against the old hash is a conflict.
    expect(
      (await request(app).put(url).set(auth).send({ path: 'SKILL.md', content: 'x', baseHash: file.hash })).status,
    ).toBe(409);

    const reset = await request(app).post(`${url}/reset`).set(auth).send({ path: 'SKILL.md' });
    expect(reset.body).toMatchObject({ overridden: false, skillVersion: file.skillVersion });
    const revisions = (await request(app).get(`${url}/revisions?path=SKILL.md`).set(auth)).body;
    expect(revisions.map((r: { reset: boolean; note: string }) => [r.reset, r.note])).toEqual([
      [true, ''],
      [false, 'Shorter answers'],
    ]);
    expect(revisions[1].createdBy.name).toBe('Ada Admin');
    const actions = (await request(app).get('/api/audit?action=SKILL_FILE_UPDATED').set(auth)).body.items;
    expect(actions[0]).toMatchObject({ entityType: 'skill', entityId: 'workspace-chat/SKILL.md' });
  });

  it('refuses NUL characters in an upload with a 400, never a 500', async () => {
    const send = (subject: string, body: string, content: Buffer, name: string) =>
      request(app)
        .post('/api/submissions/upload')
        .set('Authorization', `Bearer ${token}`)
        .field('subject', subject)
        .field('fromAddress', 'broker@acme.com')
        .field('bodyText', body)
        .attach('files', content, name);
    // A NUL in the file name (the "evil.exe\0.txt" trick), the subject or the body cannot be stored.
    for (const [subject, body, name] of [
      ['NUL file name', 'body', 'evil.exe\0.txt'],
      ['NUL\0subject', 'body', 'ok.txt'],
      ['NUL body', 'bo\0dy', 'ok.txt'],
    ]) {
      const r = await send(subject!, body!, Buffer.from('hello'), name!);
      expect(r.status).toBe(400);
    }
    // A well-formed part whose encoded file name decodes to a NUL.
    const raw = [
      '--b0undary',
      'Content-Disposition: form-data; name="subject"',
      '',
      'Encoded NUL file name',
      '--b0undary',
      'Content-Disposition: form-data; name="fromAddress"',
      '',
      'broker@acme.com',
      '--b0undary',
      `Content-Disposition: form-data; name="files"; filename*=UTF-8''evil.exe%00.txt`,
      'Content-Type: text/plain',
      '',
      'hello',
      '--b0undary--',
      '',
    ].join('\r\n');
    const encoded = await request(app)
      .post('/api/submissions/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'multipart/form-data; boundary=b0undary')
      .send(raw);
    expect(encoded.status).toBe(400);
    expect(encoded.body.error.code).toBe('INVALID_FILENAME');
    // NUL bytes inside a file are its content: stored, and stripped from the text read out of it.
    const stored = await send('NUL content', 'body', Buffer.from('MZ\0\0 evil\0text'), 'nulbyte.txt');
    expect(stored.status).toBe(201);
    // Out of the inbox again, so the unread counts later in this suite are unchanged.
    await pool.query('UPDATE submissions SET deleted_at=now() WHERE id=$1', [stored.body.id]);
    // JSON bodies too.
    expect((await request(app).post('/api/auth/login').send({ email: 'a\0@example.com', password: 'x' })).status).toBe(
      400,
    );
  });

  it('answers a non-multipart request to an upload route at once with a 415', async () => {
    for (const type of ['application/json', 'text/plain', 'application/x-www-form-urlencoded']) {
      const r = await request(app)
        .post('/api/submissions/upload')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', type)
        .timeout(5000)
        .send(type === 'application/json' ? '{}' : 'a=b');
      expect(r.status).toBe(415);
      expect(r.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('answers an IMS 2 sync with no queue set up as a 409, not a server error', async () => {
    const r = await request(app).post('/api/ims2-queue/sync').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IMS2_QUEUE_NOT_CONFIGURED');
  });

  it('stores an email whose text holds NUL characters, without them', async () => {
    const { ingestEmail } = await import('../src/services/pipeline.js');
    const { submissionId } = await ingestEmail(
      {
        gmailMessageId: null,
        threadId: null,
        fromAddress: 'broker@nul.test',
        toAddress: 'uw@insurer.com',
        subject: 'Broken\0 encoding',
        bodyText: 'Body with a\0 NUL',
        receivedAt: new Date(),
        attachments: [{ filename: 'odd\0name.txt', mimeType: 'text/plain', data: Buffer.from('hi') }],
      },
      null,
    );
    const {
      rows: [e],
    } = await pool.query(
      `SELECT e.subject, e.body_text, (SELECT filename FROM documents WHERE submission_id=s.id) AS filename
       FROM submissions s JOIN emails e ON e.id=s.email_id WHERE s.id=$1`,
      [submissionId],
    );
    expect(e).toEqual({ subject: 'Broken encoding', body_text: 'Body with a NUL', filename: 'oddname.txt' });
    await pool.query('UPDATE submissions SET deleted_at=now() WHERE id=$1', [submissionId]);
  });

  it('validates input', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request(app).get('/api/submissions/not-a-uuid').set(auth)).status).toBe(404);
    expect(
      (await request(app).post(`/api/submissions/${submissionId}/assessments`).set(auth).send({ decision: 'MAYBE' }))
        .status,
    ).toBe(400);
  });

  it('shows the best NPI status: one matching NPI verifies the submission', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    await pool.query(
      `INSERT INTO npi_verifications (submission_id, npi, status, mismatches, verified_at)
       VALUES ($1, '1111111112', 'MISMATCH', '{}', now() - interval '1 hour')`,
      [submissionId],
    );

    const detail = (await request(app).get(`/api/submissions/${submissionId}`).set(auth)).body;
    expect(detail.npiVerifications[0]).toMatchObject({ npi: '1234567893', status: 'MATCH' });
    expect(detail.npiStatus).toBe('MATCH');
    const list = (await request(app).get('/api/submissions').set(auth)).body;
    expect(list.items.find((s: { id: string }) => s.id === submissionId)).toMatchObject({
      npiStatus: 'MATCH',
      npiVerifiedCount: 1,
      npiFailedCount: 1,
    });
  });

  it('drops checks for NPIs no longer on the submission when re-verifying', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const verify = await request(app).post(`/api/submissions/${submissionId}/npi/verify`).set(auth).send({});
    expect(verify.status).toBe(200);
    expect(verify.body).toHaveLength(1);
    expect(verify.body[0]).toMatchObject({ npi: '1234567893', status: 'MATCH' });

    const detail = (await request(app).get(`/api/submissions/${submissionId}`).set(auth)).body;
    expect(detail.npiStatus).toBe('MATCH');
    const audit = (await request(app).get(`/api/submissions/${submissionId}/audit`).set(auth)).body.items;
    const removed = audit.find((e: { action: string }) => e.action === 'NPI_VERIFICATIONS_REMOVED');
    // The audit trail keeps an NPI's last four digits only (services/audit.ts, DB-01).
    expect(removed.details.removed).toEqual([{ npiLast4: '1112', status: 'MISMATCH' }]);
  });

  it('counts unread submissions and clears them when opened', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const unread = async () => (await request(app).get('/api/submissions/unread-count').set(auth)).body.unread;
    expect(await unread()).toBe(1);
    const before = (await request(app).get('/api/submissions').set(auth)).body;
    expect(before.items.find((s: { id: string }) => s.id === submissionId).isRead).toBe(false);

    const read = await request(app).post(`/api/submissions/${submissionId}/read`).set(auth);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ unread: 0 });
    // Opening it again is idempotent.
    expect((await request(app).post(`/api/submissions/${submissionId}/read`).set(auth)).body).toEqual({ unread: 0 });
    const after = (await request(app).get('/api/submissions').set(auth)).body;
    expect(after.items.find((s: { id: string }) => s.id === submissionId).isRead).toBe(true);
    expect(
      (await request(app).post('/api/submissions/00000000-0000-0000-0000-000000000000/read').set(auth)).status,
    ).toBe(404);
  });

  it('reopens a submission as unread and marks a whole tab read', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const readAll = (view: string, body: object = {}) =>
      request(app).post(`/api/submissions/${view}/read-all`).set(auth).send(body);
    // Read state is per user: another user's read survives this user's mark-unread and mark-all-read.
    await request(app)
      .post('/api/auth/register')
      .set(auth)
      .send({ email: 'reader@example.com', password: 'reader-pass-123', name: 'Rae Reader' });
    const other = {
      Authorization: `Bearer ${(await request(app).post('/api/auth/login').set(CLI).send({ email: 'reader@example.com', password: 'reader-pass-123' })).body.token}`,
    };
    await request(app).post(`/api/submissions/${submissionId}/read`).set(other);

    const unread = await request(app).delete(`/api/submissions/${submissionId}/read`).set(auth);
    expect(unread.status).toBe(200);
    expect(unread.body).toEqual({ unread: 1 });
    expect(
      (await request(app).delete('/api/submissions/00000000-0000-0000-0000-000000000000/read').set(auth)).status,
    ).toBe(404);

    // Searches and filters that match nothing, or only another tab, mark nothing; the tab-wide call marks the rest, then has nothing left.
    expect((await readAll('submissions', { q: 'no-such-email' })).body).toEqual({ marked: 0, unread: 1 });
    expect((await readAll('submissions', { status: 'ERROR' })).body).toEqual({ marked: 0, unread: 1 });
    expect((await readAll('ignored')).body).toEqual({ marked: 0, unread: 1 });
    expect((await readAll('submissions')).body).toEqual({ marked: 1, unread: 0 });
    expect((await readAll('submissions')).body).toEqual({ marked: 0, unread: 0 });
    expect((await request(app).get('/api/submissions/unread-count').set(other)).body).toEqual({ unread: 0 });
    expect((await readAll('bogus')).status).toBe(400);
  });
});

describe('Ignored and duplicate emails', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const APP = 'Applicant: Jane Smith\nNPI 1234567893\nState: TX\nSpecialty: OB/GYN';
  const SUBJECT = 'New submission - Dr. Jane Smith OB/GYN professional liability';
  const BODY = 'Please quote. Application attached. NPI 1234567893. Effective date 2027-01-01. Limits 1M/3M.';
  const upload = (fields: Record<string, string>, files: [string, string][] = []) => {
    let r = request(app).post('/api/submissions/upload').set(auth());
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    for (const [content, name] of files) r = r.attach('files', Buffer.from(content), name);
    return r;
  };
  const detail = async (id: string) => (await request(app).get(`/api/submissions/${id}`).set(auth())).body;
  const settled = (id: string) =>
    waitFor(
      () => detail(id),
      (b) => !['NEW', 'PROCESSING'].includes(b.status),
    );
  const actions = async (id: string) =>
    (await request(app).get(`/api/submissions/${id}/audit`).set(auth())).body.items as {
      action: string;
      details: any;
    }[];

  let originalId = '';
  let duplicateId = '';
  let possibleId = '';
  let processedId = '';

  it('holds back the same package sent twice without classifying or processing it', async () => {
    originalId = (await request(app).get('/api/submissions').set(auth()).query({ q: 'Dr. Jane Smith' })).body.items.at(
      -1,
    ).id;
    const res = await upload({ subject: `FW: ${SUBJECT}`, fromAddress: 'broker@acme.com', bodyText: BODY }, [
      [APP, 'application.txt'],
    ]);
    expect(res.status).toBe(201);
    duplicateId = res.body.id;
    expect(res.body).toMatchObject({
      status: 'DUPLICATE',
      classification: null,
      duplicateOf: { id: originalId, subject: SUBJECT },
    });
    expect(res.body.duplicateBasis).toMatchObject({
      rule: 'R2',
      strength: 'CERTAIN',
      originalId,
      method: 'AUTO',
      sharedAttachments: ['application.txt'],
    });
    expect(res.body.duplicateBasis.explanation).toMatch(
      /^Same subject, same text and the same 1 attachment \(application\.txt\) as "New submission/,
    );
    await new Promise((r) => setTimeout(r, 500));
    const d = await detail(duplicateId);
    expect(d.status).toBe('DUPLICATE');
    expect(d.extractedFields).toEqual([]);
    expect(d.documents[0].extractionStatus).toBe('PENDING');
    expect((await detail(originalId)).duplicates).toEqual([expect.objectContaining({ id: duplicateId })]);
    const audit = await actions(duplicateId);
    expect(audit.map((e) => e.action)).not.toContain('EMAIL_CLASSIFIED');
    expect(audit.find((e) => e.action === 'DUPLICATE_DETECTED')!.details).toMatchObject({
      rule: 'R2',
      outcome: 'DUPLICATE',
    });
  });

  it('processes a re-send that adds an attachment', async () => {
    const res = await upload({ subject: SUBJECT, fromAddress: 'broker@acme.com', bodyText: BODY }, [
      [APP, 'application.txt'],
      ['Loss runs 2021-2026: no claims', 'loss_runs.txt'],
    ]);
    processedId = res.body.id;
    expect(res.body.duplicateOf).toBeNull();
    expect((await settled(processedId)).status).toBe('READY_FOR_REVIEW');
  });

  it('ignores a repeat of an ignored email without classifying it again', async () => {
    // An automated sender is structural evidence; marketing words alone would go to Claude.
    const news = {
      subject: 'Monthly webinar newsletter',
      fromAddress: 'noreply@vendor.com',
      bodyText:
        'Join our webinar newsletter this month for great promotion offers on software. Click to unsubscribe from these emails at any time you like.',
    };
    const first = (await upload(news)).body;
    expect((await settled(first.id)).status).toBe('NOT_SUBMISSION');
    const second = (await upload(news)).body;
    expect(second).toMatchObject({ status: 'NOT_SUBMISSION', classification: 'NOT_SUBMISSION', duplicateOf: null });
    expect(second.classificationReasons).toHaveLength(1);
    expect(second.classificationReasons[0]).toMatch(
      /^Repeat of an ignored email\. Same subject and the same text \(\d+ words\) as "Monthly webinar newsletter"/,
    );
  });

  it('holds back an attachment subset as a possible duplicate', async () => {
    const res = await upload(
      {
        subject: 'Malpractice application for Dr. Smith',
        fromAddress: 'broker@acme.com',
        bodyText:
          'New submission: resending only the application for this malpractice account; loss runs follow from the insured. Effective date 2027-01-01.',
      },
      [[APP, 'application.txt']],
    );
    possibleId = res.body.id;
    expect(res.body).toMatchObject({
      status: 'DUPLICATE',
      duplicateOf: { id: originalId },
      duplicateBasis: { rule: 'R5', strength: 'POSSIBLE' },
    });
  });

  it('lists each tab with counts, the strength filter and unread across all tabs', async () => {
    const list = async (query: Record<string, string>) =>
      (await request(app).get('/api/submissions').set(auth()).query(query)).body;
    const dups = await list({ view: 'duplicates' });
    expect(dups.items.map((s: { id: string }) => s.id).sort()).toEqual([duplicateId, possibleId].sort());
    expect(dups.counts).toEqual({
      submissions: expect.any(Number),
      ignored: 2,
      duplicates: 2,
      errors: expect.any(Number),
    });
    expect(dups.unread.duplicates).toBe(2);
    expect((await list({ view: 'duplicates', strength: 'POSSIBLE' })).items.map((s: { id: string }) => s.id)).toEqual([
      possibleId,
    ]);
    expect(
      (await list({ view: 'ignored' })).items.every((s: { status: string }) => s.status === 'NOT_SUBMISSION'),
    ).toBe(true);
    const subs = await list({ view: 'submissions' });
    expect(subs.items.some((s: { status: string }) => ['NOT_SUBMISSION', 'DUPLICATE'].includes(s.status))).toBe(false);
    const unread = (await request(app).get('/api/submissions/unread-count').set(auth())).body.unread;
    expect(unread).toBe(subs.unread.submissions + subs.unread.ignored + subs.unread.duplicates);
    expect(subs.unread.ignored).toBe(2);
  });

  it('refuses to process, report on or set DUPLICATE outside the duplicate endpoint', async () => {
    const post = (url: string, body: object = {}) => request(app).post(url).set(auth()).send(body);
    const patch = (url: string, body: object) => request(app).patch(url).set(auth()).send(body);
    expect((await patch(`/api/submissions/${processedId}`, { status: 'DUPLICATE' })).status).toBe(400);
    expect((await patch(`/api/submissions/${duplicateId}`, { status: 'IN_REVIEW' })).body.error.code).toBe(
      'IS_DUPLICATE',
    );
    expect((await post(`/api/submissions/${duplicateId}/reprocess`)).status).toBe(409);
    expect((await post(`/api/submissions/${duplicateId}/synthesis`)).body.error.code).toBe('NOT_PROCESSABLE');
    expect(
      (
        await post(`/api/submissions/${duplicateId}/external-results`, {
          classification: 'SUBMISSION',
          confidence: 1,
          reasons: [],
          fields: [],
        })
      ).status,
    ).toBe(409);
    expect((await post(`/api/submissions/${processedId}/duplicate`, { duplicateOfId: null, reason: 'x' })).status).toBe(
      409,
    );
  });

  it('marks a submission as a duplicate of the original behind a duplicate', async () => {
    const mark = (id: string, duplicateOfId: string) =>
      request(app)
        .post(`/api/submissions/${id}/duplicate`)
        .set(auth())
        .send({ duplicateOfId, reason: 'Same account, broker re-sent' });
    const res = await mark(processedId, duplicateId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'DUPLICATE',
      duplicateOf: { id: originalId },
      duplicateBasis: { rule: 'MANUAL', method: 'MANUAL' },
    });
    expect((await mark(originalId, duplicateId)).status).toBe(400);
  });

  it('releases a duplicate into the full pipeline, classification included', async () => {
    const res = await request(app)
      .post(`/api/submissions/${possibleId}/duplicate`)
      .set(auth())
      .send({ duplicateOfId: null, reason: 'Different policy period' });
    expect(res.status).toBe(200);
    expect(res.body.duplicateOf).toBeNull();
    expect(await settled(possibleId)).toMatchObject({
      status: 'READY_FOR_REVIEW',
      classification: 'SUBMISSION',
      duplicateBasis: null,
    });
    expect((await actions(possibleId)).find((e) => e.action === 'DUPLICATE_CLEARED')!.details).toMatchObject({
      originalId,
      reason: 'Different policy period',
    });
  });

  it('overrides a duplicate to Ignored, and a submission to Duplicate, like any other classification', async () => {
    const toIgnored = await request(app)
      .post(`/api/submissions/${duplicateId}/classification`)
      .set(auth())
      .send({ classification: 'NOT_SUBMISSION', reason: 'Internal test copy' });
    expect(toIgnored.status).toBe(200);
    expect(toIgnored.body).toMatchObject({
      status: 'NOT_SUBMISSION',
      classification: 'NOT_SUBMISSION',
      duplicateOf: null,
      duplicateBasis: null,
    });
    expect((await actions(duplicateId)).map((e) => e.action)).toEqual(
      expect.arrayContaining(['DUPLICATE_CLEARED', 'CLASSIFICATION_OVERRIDDEN']),
    );

    const toDuplicate = await request(app)
      .post(`/api/submissions/${possibleId}/duplicate`)
      .set(auth())
      .send({ duplicateOfId: originalId, reason: 'Same renewal, broker re-sent it' });
    expect(toDuplicate.body).toMatchObject({
      status: 'DUPLICATE',
      duplicateOf: { id: originalId },
      duplicateBasis: {
        rule: 'MANUAL',
        explanation: 'Marked as a duplicate by Ada Admin: Same renewal, broker re-sent it',
      },
    });
  });

  it('holds the same package from a second broker as a possible duplicate, naming both senders', async () => {
    const res = await upload({ subject: SUBJECT, fromAddress: 'Rival Broker <rival@other.com>', bodyText: BODY }, [
      [APP, 'application.txt'],
    ]);
    expect(res.body).toMatchObject({
      status: 'DUPLICATE',
      duplicateBasis: { rule: 'R2', strength: 'POSSIBLE', differentSender: true },
    });
    expect(res.body.duplicateBasis.explanation).toContain(
      'different address (rival@other.com; the original came from broker@acme.com)',
    );
  });

  it('keeps exactly one original when identical emails arrive together', async () => {
    const send = () =>
      upload({ subject: 'Concurrent submission for Dr. Lee', fromAddress: 'broker@acme.com', bodyText: BODY }, [
        ['Applicant: Dr. Lee', 'application_lee.txt'],
      ]);
    const results = (await Promise.all([send(), send(), send()])).map((r) => r.body);
    const held = results.filter((b) => b.status === 'DUPLICATE');
    expect(held).toHaveLength(2);
    const original = results.find((b) => b.status !== 'DUPLICATE')!.id;
    expect(held.every((b) => b.duplicateOf.id === original)).toBe(true);
  });

  let ignoredId = '';

  it('ignores copies that arrived while their original was still being classified', async () => {
    const alert = {
      subject: 'Scheduled maintenance this weekend for the vendor portal',
      fromAddress: 'noreply@portal-vendor.com',
      bodyText:
        'The vendor portal will be unavailable on Saturday night between ten and midnight while we upgrade the servers for everyone.',
    };
    const ids = (await Promise.all([upload(alert), upload(alert)])).map((r) => r.body.id as string);
    // Whichever arrived second was held as a duplicate or ignored at once: either way both end up Ignored.
    for (const id of ids)
      expect(
        await waitFor(
          () => detail(id),
          (b) => b.status === 'NOT_SUBMISSION',
        ),
      ).toMatchObject({ status: 'NOT_SUBMISSION', classification: 'NOT_SUBMISSION', duplicateOf: null });
    ignoredId = ids[0]!;
  });

  it('never runs the pipeline on an ignored email, by re-run or by releasing it from Duplicates', async () => {
    const post = (url: string, body: object = {}) => request(app).post(url).set(auth()).send(body);
    expect((await post(`/api/submissions/${ignoredId}/reprocess`)).body.error.code).toBe('NOT_PROCESSABLE');
    expect(
      (await post(`/api/submissions/${ignoredId}/duplicate`, { duplicateOfId: originalId, reason: 'Test mark' }))
        .status,
    ).toBe(200);
    expect(
      (await post(`/api/submissions/${ignoredId}/duplicate`, { duplicateOfId: null, reason: 'Test release' })).status,
    ).toBe(200);
    const d = await settled(ignoredId);
    expect(d).toMatchObject({ status: 'NOT_SUBMISSION', classification: 'NOT_SUBMISSION' });
    expect(d.extractedFields).toEqual([]);
  });
});

describe('manual fields and NPIs', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const detail = async (id: string) => (await request(app).get(`/api/submissions/${id}`).set(auth())).body;
  const actions = async (id: string) =>
    ((await request(app).get(`/api/submissions/${id}/audit`).set(auth())).body.items as { action: string }[]).map(
      (e) => e.action,
    );
  let id = '';

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/submissions/upload')
      .set(auth())
      // Worded so the classification rules decide it (the Claude mock only answers extraction and reports).
      .field('subject', "New submission - Houston women's clinic medical malpractice application")
      .field('fromAddress', 'agent@manual-entry.test')
      .field(
        'bodyText',
        'Please quote professional liability for our Houston clinic. Application and loss runs attached. ' +
          'Renewal of the expiring policy; the physician has practised for twelve years with no open claims.',
      )
      .attach(
        'files',
        Buffer.from('Applicant: Jane Smith\nNPI 1234567893\nState: TX\nClinic in Houston'),
        'manual-app.txt',
      );
    id = res.body.id;
    const d = await waitFor(
      () => detail(id),
      (b) => b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR',
    );
    expect(d).toMatchObject({ status: 'READY_FOR_REVIEW', processingError: null });
  });

  it('validates manual field input', async () => {
    const post = (body: object) => request(app).post(`/api/submissions/${id}/fields`).set(auth()).send(body);
    expect((await post({ fields: [] })).status).toBe(400);
    expect((await post({ fields: [{ fieldName: '1st field', value: 'x' }] })).status).toBe(400);
    expect((await post({ fields: [{ fieldName: 'specialty', value: '   ' }] })).status).toBe(400);
    expect(
      (await post({ fields: Array.from({ length: 51 }, () => ({ fieldName: 'procedures', value: 'x' })) })).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch(`/api/submissions/${id}/fields/00000000-0000-0000-0000-000000000000`)
          .set(auth())
          .send({ value: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post('/api/submissions/00000000-0000-0000-0000-000000000000/fields')
          .set(auth())
          .send({ fields: [{ fieldName: 'specialty', value: 'x' }] })
      ).status,
    ).toBe(404);
  });

  it('adds, edits and removes manual fields, which outrank extracted values', async () => {
    const before = await detail(id);
    const add = await request(app)
      .post(`/api/submissions/${id}/fields`)
      .set(auth())
      .send({
        fields: [
          { fieldName: 'Applicant Name', value: 'Janet Smythe', note: 'Corrected per the broker call' },
          { fieldName: 'practice_state', value: 'CA' },
        ],
      });
    expect(add.status).toBe(201);
    expect(add.body.manualFields.map((f: { fieldName: string }) => f.fieldName).sort()).toEqual([
      'applicant_name',
      'practice_state',
    ]);
    expect(add.body.manualFields[0].createdBy.name).toBe('Ada Admin');
    expect(add.body.extractedFields).toHaveLength(before.extractedFields.length);
    expect(add.body).toMatchObject({
      applicantName: 'Janet Smythe',
      applicantFirstName: 'Janet',
      applicantLastName: 'Smythe',
    });
    expect(add.body.coverage.values.practice_state).toMatchObject({ value: 'CA', sourceLabel: 'manual entry' });
    expect(add.body.contextVersion).toBeGreaterThan(before.contextVersion);

    const state = add.body.manualFields.find((f: { fieldName: string }) => f.fieldName === 'practice_state');
    const edit = await request(app)
      .patch(`/api/submissions/${id}/fields/${state.id}`)
      .set(auth())
      .send({ value: 'NV', note: 'second location' });
    expect(edit.status).toBe(200);
    expect(edit.body.manualFields.find((f: { id: string }) => f.id === state.id)).toMatchObject({
      value: 'NV',
      note: 'second location',
    });
    expect(edit.body.contextVersion).toBeGreaterThan(add.body.contextVersion);

    const del = await request(app).delete(`/api/submissions/${id}/fields/${state.id}`).set(auth());
    expect(del.status).toBe(200);
    expect(del.body.manualFields).toHaveLength(1);
    expect(del.body.coverage.values.practice_state.value).toBe('TX');
    expect(await actions(id)).toEqual(
      expect.arrayContaining(['MANUAL_FIELD_ADDED', 'MANUAL_FIELD_UPDATED', 'MANUAL_FIELD_DELETED']),
    );
  });

  it('adds a manual NPI and only lets manual NPIs be removed', async () => {
    const manual = (body: object) => request(app).post(`/api/submissions/${id}/npi/manual`).set(auth()).send(body);
    expect((await manual({ npi: '12345' })).status).toBe(400);
    const typo = await manual({ npi: '1234567890' });
    expect(typo.status).toBe(400);
    expect(typo.body.error.code).toBe('INVALID_NPI');

    const added = await manual({
      npi: '1000015838',
      claimedName: 'Jane Smith',
      claimedState: 'tx',
      note: 'From the broker',
    });
    expect(added.status).toBe(201);
    const row = added.body.find((v: { npi: string }) => v.npi === '1000015838');
    expect(row).toMatchObject({
      source: 'MANUAL',
      status: 'MATCH',
      claimedName: 'Jane Smith',
      claimedState: 'TX',
      note: 'From the broker',
    });
    expect(row.addedBy.name).toBe('Ada Admin');

    const extracted = added.body.find((v: { npi: string }) => v.npi === '1234567893');
    expect(extracted.source).toBe('EXTRACTED');
    const refused = await request(app).delete(`/api/submissions/${id}/npi/${extracted.id}`).set(auth());
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NOT_MANUAL');

    const removed = await request(app).delete(`/api/submissions/${id}/npi/${row.id}`).set(auth());
    expect(removed.status).toBe(200);
    expect(removed.body.map((v: { npi: string }) => v.npi)).toEqual(['1234567893']);
    expect(await actions(id)).toEqual(expect.arrayContaining(['NPI_ADDED', 'NPI_REMOVED']));
  });

  it('lets an underwriter decide a partial match, and keeps the decision until the differences change', async () => {
    const partialNpi = '1538293840';
    const added = await request(app)
      .post(`/api/submissions/${id}/npi/manual`)
      .set(auth())
      .send({ npi: partialNpi, claimedName: 'Jane Smith', claimedState: 'CA' });
    const row = added.body.find((v: { npi: string }) => v.npi === partialNpi);
    expect(row).toMatchObject({ status: 'PARTIAL_MATCH', autoStatus: null, overrideBy: null });
    const override = (verificationId: string, body: object) =>
      request(app).put(`/api/submissions/${id}/npi/${verificationId}/override`).set(auth()).send(body);
    const undo = (verificationId: string) =>
      request(app).delete(`/api/submissions/${id}/npi/${verificationId}/override`).set(auth());
    const find = (body: { npi: string }[]) => body.find((v) => v.npi === partialNpi);

    expect((await override(row.id, { status: 'MATCH', note: '   ' })).status).toBe(400);
    expect((await override(row.id, { status: 'NOT_FOUND', note: 'x' })).status).toBe(400);
    const clean = added.body.find((v: { npi: string }) => v.npi === '1234567893');
    const refused = await override(clean.id, { status: 'MISMATCH', note: 'x' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NOT_PARTIAL_MATCH');
    expect((await undo(row.id)).body.error.code).toBe('NOT_OVERRIDDEN');

    const before = (await request(app).get(`/api/submissions/${id}`).set(auth())).body.contextVersion;
    const confirmed = await override(row.id, { status: 'MATCH', note: 'Moved to CA; confirmed with the broker' });
    expect(confirmed.status).toBe(200);
    expect(find(confirmed.body)).toMatchObject({
      status: 'MATCH',
      autoStatus: 'PARTIAL_MATCH',
      overrideNote: 'Moved to CA; confirmed with the broker',
      overrideBy: { name: 'Ada Admin' },
    });
    expect((await request(app).get(`/api/submissions/${id}`).set(auth())).body.contextVersion).toBeGreaterThan(before);
    const evidence = await (await import('../src/services/reports.js')).buildEvidence(id);
    expect(evidence).toContain(
      `NPI ${partialNpi} (entered by an underwriter): MATCH (set by an underwriter; registry check said PARTIAL_MATCH; reason: "Moved to CA; confirmed with the broker")`,
    );

    // A decision can be changed while it stands, and survives re-verification with the same differences.
    const rejected = await override(row.id, { status: 'MISMATCH', note: 'Wrong provider' });
    expect(find(rejected.body)).toMatchObject({
      status: 'MISMATCH',
      autoStatus: 'PARTIAL_MATCH',
      overrideNote: 'Wrong provider',
    });
    await override(row.id, { status: 'MATCH', note: 'Right provider after all' });
    // The reason is evidence too: changing only the reason is a new context.
    const beforeReason = (await request(app).get(`/api/submissions/${id}`).set(auth())).body.contextVersion;
    await override(row.id, { status: 'MATCH', note: 'Right provider, license checked' });
    expect((await request(app).get(`/api/submissions/${id}`).set(auth())).body.contextVersion).toBeGreaterThan(
      beforeReason,
    );
    await override(row.id, { status: 'MATCH', note: 'Right provider after all' });
    const kept = await request(app).post(`/api/submissions/${id}/npi/verify`).set(auth()).send({});
    expect(find(kept.body)).toMatchObject({
      status: 'MATCH',
      autoStatus: 'PARTIAL_MATCH',
      overrideNote: 'Right provider after all',
    });

    // A registry outage says nothing about the NPI: the decision and the stored record stay.
    const { lookupNpi } = await import('../src/services/npi.js');
    vi.mocked(lookupNpi).mockRejectedValueOnce(new Error('NPI registry HTTP 503'));
    const outage = await request(app)
      .post(`/api/submissions/${id}/npi/verify`)
      .set(auth())
      .send({ npi: partialNpi, claimedName: 'Jane Smith', claimedState: 'CA' });
    expect(find(outage.body)).toMatchObject({
      status: 'MATCH',
      autoStatus: 'PARTIAL_MATCH',
      registryName: 'JANE SMITH',
    });

    // New differences need a fresh look: the decision is cleared and the check is back to partial.
    const changed = await request(app)
      .post(`/api/submissions/${id}/npi/verify`)
      .set(auth())
      .send({ npi: partialNpi, claimedName: 'Jane Smith', claimedState: 'NV' });
    expect(find(changed.body)).toMatchObject({
      status: 'PARTIAL_MATCH',
      autoStatus: null,
      overrideNote: null,
      overrideBy: null,
    });

    await override(row.id, { status: 'MISMATCH', note: 'Wrong provider' });
    const undone = await undo(row.id);
    expect(undone.status).toBe(200);
    expect(find(undone.body)).toMatchObject({ status: 'PARTIAL_MATCH', autoStatus: null, overrideNote: null });
    expect(await actions(id)).toEqual(
      expect.arrayContaining(['NPI_MATCH_OVERRIDDEN', 'NPI_OVERRIDE_CLEARED', 'NPI_OVERRIDE_REMOVED']),
    );

    await request(app).delete(`/api/submissions/${id}/npi/${row.id}`).set(auth());
  });

  it('verifies an NPI saved as a manual field', async () => {
    const res = await request(app)
      .post(`/api/submissions/${id}/fields`)
      .set(auth())
      .send({ fields: [{ fieldName: 'npi', value: '1000-158-380' }] });
    expect(res.status).toBe(201);
    // Claimed with the manual applicant name, which the (mocked) registry record for Jane Smith does not match.
    expect(res.body.npiVerifications.find((v: { npi: string }) => v.npi === '1000158380')).toMatchObject({
      source: 'MANUAL',
      claimedName: 'Janet Smythe',
      status: 'MISMATCH',
    });
  });

  it('keeps manual fields and NPIs through reprocessing', async () => {
    const extractions = async () => (await actions(id)).filter((a) => a === 'FIELDS_EXTRACTED').length;
    const runs = await extractions();
    expect((await request(app).post(`/api/submissions/${id}/reprocess`).set(auth())).status).toBe(202);
    await waitFor(extractions, (n) => n > runs);
    const d = await waitFor(
      () => detail(id),
      (b) => b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR',
    );
    expect(d.applicantName).toBe('Janet Smythe');
    expect(d.manualFields.map((f: { fieldName: string }) => f.fieldName).sort()).toEqual(['applicant_name', 'npi']);
    expect(d.npiVerifications.map((v: { npi: string; source: string }) => `${v.npi}:${v.source}`).sort())
      // The manual npi field supersedes the extracted one, so the extracted check is dropped as stale; the manual stays.
      .toEqual(['1000158380:MANUAL']);
  });

  it('feeds manual entries into report evidence', async () => {
    const { buildEvidence } = await import('../src/services/reports.js');
    const evidence = await buildEvidence(id);
    expect(evidence).toContain(
      '- applicant_name: Janet Smythe [source: manual entry by an underwriter, supersedes extracted values] note: "Corrected per the broker call"',
    );
    expect(evidence).not.toContain('applicant_name: Jane Smith');
    // 1000158380 is a MISMATCH: reports leave it out entirely, chat still sees it.
    expect(evidence).not.toContain('NPI 1000158380');
    expect(evidence).toContain('(no registry-matched NPI; NPI is not part of this report)');
    expect(await buildEvidence(id, { npi: 'all' })).toContain('NPI 1000158380 (entered by an underwriter): MISMATCH');
  });
});

describe('reply and forward', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const send = (id: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/submissions/${id}/outbound-emails`)
      .set(auth())
      .send({ subject: 'Re: Quote', body: 'Thanks', ...body });
  let gmailId = '';
  let manualId = '';
  const FILE = 'Loss runs 2020-2025: no claims';

  beforeAll(async () => {
    const gm = await request(app)
      .post('/api/submissions/upload')
      .set(auth())
      .field('subject', 'Quote request: Dr. Lee cardiology')
      .field('fromAddress', 'Pat Broker <pat@brokerage.test>')
      .field('toAddress', 'uw@insurer.com, Sam CC <sam@brokerage.test>')
      .field('bodyText', 'Please quote Dr. Lee, cardiology, loss runs attached.')
      .field('gmailMessageId', 'gm-reply-1')
      .field('threadId', 'thread-reply-1')
      .field('rfcMessageId', '<rfc-reply-1@mail.test>')
      .attach('files', Buffer.from(FILE), 'loss-runs.txt');
    gmailId = gm.body.id;
    const manual = await request(app)
      .post('/api/submissions/upload')
      .set(auth())
      .field('subject', 'Walk-in submission for Dr. Patel')
      .field('fromAddress', 'office@patel.test')
      .field('bodyText', 'Paper application scanned in.')
      .attach('files', Buffer.from('Applicant: Dr. Patel'), 'patel.txt');
    manualId = manual.body.id;
  });

  it('sends a threaded reply and records it', async () => {
    const res = await send(gmailId, { mode: 'REPLY', to: ['pat@brokerage.test'] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      mode: 'REPLY',
      to: ['pat@brokerage.test'],
      cc: [],
      transport: 'OAUTH',
      gmailThreadId: 'thread-reply-1',
    });
    expect(res.body.sentBy.name).toBe('Ada Admin');
    expect(sentMail.at(-1)).toMatchObject({
      threadId: 'thread-reply-1',
      inReplyTo: '<rfc-reply-1@mail.test>',
      attachments: [],
    });

    const list = (await request(app).get(`/api/submissions/${gmailId}/outbound-emails`).set(auth())).body.items;
    expect(list).toHaveLength(1);
    const audit = (await request(app).get(`/api/submissions/${gmailId}/audit`).set(auth())).body.items;
    expect(audit.find((e: { action: string }) => e.action === 'EMAIL_REPLIED').details).toMatchObject({
      mode: 'REPLY',
      threaded: true,
    });
  });

  it('sends reply all with Cc and stores the Cc list', async () => {
    const cc = ['Sam CC <sam@brokerage.test>', 'ops@brokerage.test'];
    const res = await send(gmailId, { mode: 'REPLY_ALL', to: ['pat@brokerage.test'], cc });
    expect(res.status).toBe(201);
    expect(res.body.cc).toEqual(cc);
    expect(sentMail.at(-1).cc).toEqual(cc);
    const {
      rows: [row],
    } = await pool.query('SELECT cc_addresses FROM outbound_emails WHERE id=$1', [res.body.id]);
    expect(row.cc_addresses).toEqual(cc);
    const audit = (await request(app).get(`/api/submissions/${gmailId}/audit`).set(auth())).body.items;
    expect(
      audit.find(
        (e: { action: string; details: any }) => e.action === 'EMAIL_REPLIED' && e.details.mode === 'REPLY_ALL',
      ).details.cc,
      // Addresses are scrubbed from audit details (DB-01); outbound_emails keeps them until the retention purge.
    ).toEqual(['Sam CC <[REDACTED-EMAIL]>', '[REDACTED-EMAIL]']);
  });

  it('forwards with stored attachments and rejects foreign documents', async () => {
    const doc = (await request(app).get(`/api/submissions/${gmailId}`).set(auth())).body.documents[0];
    const fwd = await send(gmailId, {
      mode: 'FORWARD',
      to: ['reinsurer@re.test'],
      subject: 'Fwd: Quote request',
      documentIds: [doc.id],
    });
    expect(fwd.status).toBe(201);
    expect(fwd.body.documentIds).toEqual([doc.id]);
    const sent = sentMail.at(-1);
    expect(sent.threadId).toBeNull();
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0]).toMatchObject({ filename: 'loss-runs.txt' });
    expect(Buffer.from(sent.attachments[0].data).toString()).toBe(FILE);

    const foreign = (await request(app).get(`/api/submissions/${manualId}`).set(auth())).body.documents[0];
    const rejected = await send(gmailId, { mode: 'FORWARD', to: ['reinsurer@re.test'], documentIds: [foreign.id] });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('FOREIGN_DOCUMENT');
    const audit = (await request(app).get(`/api/submissions/${gmailId}/audit`).set(auth())).body.items;
    // File names stay out of the audit trail (DB-01): the forward records how many were attached.
    expect(audit.find((e: { action: string }) => e.action === 'EMAIL_FORWARDED').details.attachmentsCount).toBe(1);
  });

  it('rejects bad recipients, an empty subject and attachments over 18 MB', async () => {
    const count = sentMail.length;
    const bad = await send(gmailId, { mode: 'REPLY', to: ['pat@brokerage.test', 'not an address'] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'INVALID_ADDRESS', details: { invalid: ['not an address'] } });
    expect((await send(gmailId, { mode: 'REPLY', to: [] })).status).toBe(400);
    expect((await send(gmailId, { mode: 'REPLY', to: ['pat@brokerage.test'], subject: '  ' })).status).toBe(400);

    const doc = (await request(app).get(`/api/submissions/${gmailId}`).set(auth())).body.documents[0];
    await pool.query('UPDATE documents SET size_bytes=$2 WHERE id=$1', [doc.id, 19 * 1024 * 1024]);
    const large = await send(gmailId, { mode: 'FORWARD', to: ['reinsurer@re.test'], documentIds: [doc.id] });
    await pool.query('UPDATE documents SET size_bytes=$2 WHERE id=$1', [doc.id, doc.sizeBytes]);
    expect(large.status).toBe(400);
    expect(large.body.error.code).toBe('ATTACHMENTS_TOO_LARGE');
    expect(sentMail.length).toBe(count);
  });

  it('starts a new thread when replying to a manual submission', async () => {
    const res = await send(manualId, { mode: 'REPLY', to: ['office@patel.test'] });
    expect(res.status).toBe(201);
    expect(sentMail.at(-1)).toMatchObject({ threadId: null, inReplyTo: null });
  });
});

describe('real-time email notifications', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  let server: import('node:http').Server;
  let base = '';

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  /** Reads the stream until `done(text)` holds, then disconnects. `onReady` runs once the server says it is subscribed. */
  async function readStream(query: string, done: (text: string) => boolean, onReady?: () => Promise<unknown>) {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events/stream${query}`, { headers: auth(), signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let readyHandled = false;
    const deadline = Date.now() + 15_000;
    while (!done(text)) {
      if (Date.now() > deadline) throw new Error(`stream timeout; got: ${text.slice(0, 1000)}`);
      const { value, done: ended } = await reader.read();
      if (ended) break;
      text += decoder.decode(value, { stream: true });
      if (!readyHandled && onReady && text.includes('event: ready')) {
        readyHandled = true;
        await onReady();
      }
    }
    ctrl.abort();
    return text;
  }

  const gmailEmail = (n: number) => ({
    gmailMessageId: `gm-notify-${n}`,
    threadId: null,
    fromAddress: `sender${n}@notify.test`,
    toAddress: 'uw@insurer.com',
    subject: `Notification test ${n}: new quote request ${n * 7919}`,
    bodyText: `Unique body ${n} ${n * 104729}`,
    receivedAt: new Date(),
    attachments: [],
  });

  it('requires a token and a valid cursor', async () => {
    expect((await fetch(`${base}/api/events/stream`)).status).toBe(401);
    expect((await fetch(`${base}/api/events/stream?since=yesterday`, { headers: auth() })).status).toBe(400);
  });

  it('replays missed Gmail emails since the cursor and skips manual uploads', async () => {
    const { ingestEmail } = await import('../src/services/pipeline.js');
    const since = new Date(Date.now() - 1000).toISOString();
    await ingestEmail(gmailEmail(1), null);
    await request(app)
      .post('/api/submissions/upload')
      .set(auth())
      .field('subject', 'Notification test manual upload')
      .field('fromAddress', 'walkin@notify.test')
      .field('bodyText', 'Paper copy');

    const text = await readStream(`?since=${encodeURIComponent(since)}`, (t) => t.includes('Notification test 1'));
    expect(text).toContain('event: new-email');
    expect(text).not.toContain('Notification test manual upload');
    const data = JSON.parse(/data: (\{.*"Notification test 1.*\})/.exec(text)![1]!);
    expect(data).toMatchObject({ fromAddress: 'sender1@notify.test' });
    expect(text).toContain(`id: ${data.ingestedAt}`);
  });

  it('pushes a Gmail email to connected clients as it is ingested', async () => {
    const { ingestEmail } = await import('../src/services/pipeline.js');
    const text = await readStream(
      '',
      (t) => t.includes('Notification test 2'),
      () => ingestEmail(gmailEmail(2), null),
    );
    expect(text).toContain('"fromAddress":"sender2@notify.test"');
  });

  it('counts a new email as unread until that user opens it', async () => {
    const unread = async () =>
      (await request(app).get('/api/submissions/unread-count').set(auth())).body.unread as number;
    const { ingestEmail } = await import('../src/services/pipeline.js');
    // Earlier emails are still being classified in the background; one finishing mid-test would shift the count.
    await (await import('../src/services/jobQueue.js')).jobs.drain();
    const before = await unread();
    const { submissionId } = await ingestEmail(gmailEmail(3), null);
    // An email still being classified is not counted yet (queries.ts CLASSIFYING).
    await (await import('../src/services/jobQueue.js')).jobs.drain();
    expect(await unread()).toBe(before + 1);
    await request(app).post(`/api/submissions/${submissionId}/read`).set(auth());
    expect(await unread()).toBe(before);
  });

  it('events/since returns emails newer than cursor', async () => {
    const { ingestEmail } = await import('../src/services/pipeline.js');
    const first = await request(app).get('/api/events/since').set(auth()).expect(200);
    expect(first.body.events).toEqual([]);
    expect(typeof first.body.cursor).toBe('string');
    await ingestEmail(gmailEmail(4), null);
    const res = await request(app)
      .get(`/api/events/since?since=${encodeURIComponent(first.body.cursor)}`)
      .set(auth())
      .expect(200);
    const subjects = (res.body.events as { subject: string }[]).map((e) => e.subject);
    expect(subjects.some((s) => s.startsWith('Notification test 4'))).toBe(true);
    expect(res.body.cursor).toBe(res.body.events.at(-1).ingestedAt);
    // The next poll from that cursor sees nothing again; the cursor stays where it was.
    const again = await request(app)
      .get(`/api/events/since?since=${encodeURIComponent(res.body.cursor)}`)
      .set(auth())
      .expect(200);
    expect(again.body).toEqual({ events: [], cursor: res.body.cursor });
  });

  it('events/since requires auth', async () => {
    await request(app).get('/api/events/since').expect(401);
    await request(app).get('/api/events/since?since=yesterday').set(auth()).expect(400);
  });
});

describe('manual documents and supporting documents', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const detail = async (id: string) => (await request(app).get(`/api/submissions/${id}`).set(auth())).body;
  let id = '';
  let otherDocId = '';

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/submissions/upload')
      .set(auth())
      .field('subject', 'New submission - Austin pediatrics group medical malpractice application')
      .field('fromAddress', 'agent@docs-test.test')
      .field(
        'bodyText',
        'Please quote professional liability for the Austin pediatrics group. Application attached. ' +
          'Loss runs will follow under separate cover once the carrier releases them next week.',
      )
      .attach('files', Buffer.from('Applicant: Jane Smith\nNPI 1234567893\nState: TX'), 'austin-app.txt');
    id = res.body.id;
    await waitFor(
      () => detail(id),
      (b) => b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR',
    );
    const other = (await request(app).get('/api/submissions').set(auth())).body.items.find(
      (s: { id: string; documentCount: number }) => s.id !== id && s.documentCount > 0,
    );
    otherDocId = (await detail(other.id)).documents[0].id;
  });

  it('uploads documents to an existing submission and extracts their text', async () => {
    const before = await detail(id);
    // No form at all is refused as not multipart; a form without files as missing its files.
    expect((await request(app).post(`/api/submissions/${id}/documents`).set(auth())).status).toBe(415);
    expect(
      (await request(app).post(`/api/submissions/${id}/documents`).set(auth()).field('note', 'no files here')).status,
    ).toBe(400);
    const res = await request(app)
      .post(`/api/submissions/${id}/documents`)
      .set(auth())
      .attach('files', Buffer.from('Loss runs 2021-2026: no claims reported.'), 'loss-runs.txt');
    expect(res.status).toBe(201);
    expect(res.body.documentIds).toHaveLength(1);
    expect(res.body.submission.documents).toHaveLength(before.documents.length + 1);
    const docId = res.body.documentIds[0];
    const d = await waitFor(
      () => detail(id),
      (b) => b.documents.find((x: { id: string }) => x.id === docId)?.extractionStatus !== 'PENDING',
    );
    expect(d.documents.find((x: { id: string }) => x.id === docId)).toMatchObject({
      filename: 'loss-runs.txt',
      source: 'UPLOAD',
      extractionStatus: 'EXTRACTED',
    });
    expect(d.documents.find((x: { id: string }) => x.id === docId).textPreview).toContain('no claims reported');
    const versions = await waitFor(
      async () => (await detail(id)).contextVersion,
      (v) => v > before.contextVersion,
    );
    expect(versions).toBeGreaterThan(before.contextVersion);
    const audit = (await request(app).get(`/api/submissions/${id}/audit`).set(auth())).body.items;
    expect(
      audit.find((e: { action: string; entityId: string }) => e.action === 'DOCUMENT_STORED' && e.entityId === docId)
        .actor.name,
    ).toBe('Ada Admin');
  });

  it('adds a missing required field with its supporting document', async () => {
    const doc = (await detail(id)).documents.find((x: { filename: string }) => x.filename === 'loss-runs.txt');
    const foreign = await request(app)
      .post(`/api/submissions/${id}/fields`)
      .set(auth())
      .send({ fields: [{ fieldName: 'claims_count_5yr', value: '0', documentId: otherDocId }] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe('FOREIGN_DOCUMENT');

    const added = await request(app)
      .post(`/api/submissions/${id}/fields`)
      .set(auth())
      .send({ fields: [{ fieldName: 'claims_count_5yr', value: '0', documentId: doc.id }] });
    expect(added.status).toBe(201);
    const field = added.body.manualFields.find((f: { fieldName: string }) => f.fieldName === 'claims_count_5yr');
    expect(field.documentId).toBe(doc.id);
    const { buildEvidence } = await import('../src/services/reports.js');
    expect(await buildEvidence(id)).toContain(
      '- claims_count_5yr: 0 [source: manual entry by an underwriter, supersedes extracted values; supporting document: loss-runs.txt]',
    );

    const cleared = await request(app)
      .patch(`/api/submissions/${id}/fields/${field.id}`)
      .set(auth())
      .send({ documentId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.manualFields.find((f: { id: string }) => f.id === field.id).documentId).toBeNull();
  });
});

describe('Gmail import', () => {
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('starts automatic ingestion at the moment it first runs, and keeps that date', async () => {
    expect((await request(app).get('/api/gmail/import-settings').set(as(token))).body).toEqual({
      minDays: 1,
      maxDays: 365,
      autoImportSince: null,
      pollIntervalSeconds: 60,
      minPollIntervalSeconds: 10,
      maxPollIntervalSeconds: 3600,
      awaitingProcess: 0,
    });

    const { gmailAutoImportSince, resetGmailAutoImportSince } = await import('../src/services/appSettings.js');
    // Only new mail: the start is "now", not the start of today.
    const before = Date.now();
    const first = (await gmailAutoImportSince())!.getTime();
    expect(first).toBeGreaterThanOrEqual(before);
    expect(first).toBeLessThanOrEqual(Date.now());
    await pool.query(`UPDATE app_settings SET value='"2026-01-05T00:00:00.000Z"' WHERE key='gmail_auto_import_since'`);
    expect(await gmailAutoImportSince()).toEqual(new Date('2026-01-05T00:00:00.000Z'));
    expect((await request(app).get('/api/gmail/import-settings').set(as(token))).body.autoImportSince).toBe(
      '2026-01-05T00:00:00.000Z',
    );

    // Connecting a mailbox moves it to the moment of connecting.
    const connectedAt = Date.now();
    await resetGmailAutoImportSince(null);
    const reset = (await gmailAutoImportSince({ create: false }))!.getTime();
    expect(reset).toBeGreaterThanOrEqual(connectedAt);
    expect(reset).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the daily check to automatic searches', async () => {
    recentGmail.ids = [];
    recentGmail.calls.length = 0;
    const { reconcileGmail } = await import('../src/services/reconcile.js');
    await reconcileGmail();
    expect(recentGmail.calls).toEqual([{ days: 7, automatic: true }]);
  });

  it('stores the poll interval set by an admin, 0 or 10–3600 seconds', async () => {
    for (const seconds of [undefined, 5, 3601, 2.5, '60', -1]) {
      expect((await request(app).put('/api/gmail/poll-interval').set(as(token)).send({ seconds })).status).toBe(400);
    }
    expect((await request(app).put('/api/gmail/poll-interval').set(as(token)).send({ seconds: 120 })).body).toEqual({
      pollIntervalSeconds: 120,
    });
    expect((await request(app).get('/api/gmail/import-settings').set(as(token))).body.pollIntervalSeconds).toBe(120);
    expect((await request(app).put('/api/gmail/poll-interval').set(as(token)).send({ seconds: 0 })).status).toBe(200);
    const { gmailPollIntervalSeconds } = await import('../src/services/appSettings.js');
    expect(await gmailPollIntervalSeconds()).toBe(0);
    const { rows } = await pool.query(
      `SELECT details FROM audit_events WHERE action='GMAIL_POLL_INTERVAL_CHANGED' ORDER BY id`,
    );
    expect(rows.map((r) => r.details)).toEqual([
      { previous: 60, seconds: 120 },
      { previous: 120, seconds: 0 },
    ]);
    await pool.query(`DELETE FROM app_settings WHERE key='gmail_poll_interval_seconds'`);
  });

  it('validates the number of days and only lets admins import', async () => {
    for (const days of [undefined, 0, 366, 2.5, '30']) {
      expect((await request(app).post('/api/gmail/import').set(as(token)).send({ days })).status).toBe(400);
    }
    for (const body of [{ today: false }, { today: 'yes' }, { today: true, days: 30 }]) {
      expect((await request(app).post('/api/gmail/import').set(as(token)).send(body)).status).toBe(400);
    }
    await request(app)
      .post('/api/auth/register')
      .set(as(token))
      .send({ email: 'uw@example.com', password: 'underwriter-pass', name: 'Uma Underwriter' });
    const uw = (
      await request(app)
        .post('/api/auth/login')
        .set(CLI)
        .send({ email: 'uw@example.com', password: 'underwriter-pass' })
    ).body.token;
    expect((await request(app).get('/api/gmail/import-settings').set(as(uw))).status).toBe(200);
    expect((await request(app).post('/api/gmail/import').set(as(uw)).send({ days: 30 })).status).toBe(403);
    expect((await request(app).post('/api/gmail/import').set(as(uw)).send({ today: true })).status).toBe(403);
    expect((await request(app).put('/api/gmail/poll-interval').set(as(uw)).send({ seconds: 30 })).status).toBe(403);
  });

  it('imports past emails for the entered number of days, skipping ones already here', async () => {
    recentGmail.ids = ['gm-old-1', 'gm-old-2', 'gm-reply-1'];
    recentGmail.calls.length = 0;
    const res = await request(app).post('/api/gmail/import').set(as(token)).send({ days: 30 });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ days: 30, found: 3, enqueued: 2 });
    expect(recentGmail.calls).toEqual([{ days: 30, automatic: false }]);
    const queued = await pool.query(
      `SELECT gmail_message_id, imported FROM gmail_ingest_queue WHERE gmail_message_id LIKE 'gm-old-%' ORDER BY 1`,
    );
    // Queued as imported: classified on arrival, the rest waits for Process.
    expect(queued.rows).toEqual([
      { gmail_message_id: 'gm-old-1', imported: true },
      { gmail_message_id: 'gm-old-2', imported: true },
    ]);
    const {
      rows: [audited],
    } = await pool.query(`SELECT details FROM audit_events WHERE action='GMAIL_IMPORT_REQUESTED'`);
    expect(audited.details).toEqual({ days: 30, found: 3, enqueued: 2 });

    // Running it again finds nothing new to queue.
    expect((await request(app).post('/api/gmail/import').set(as(token)).send({ days: 30 })).body).toEqual({
      days: 30,
      found: 3,
      enqueued: 0,
    });
    await pool.query(`DELETE FROM gmail_ingest_queue WHERE gmail_message_id LIKE 'gm-old-%'`);
  });

  it("imports today's emails from midnight US Eastern", async () => {
    recentGmail.ids = ['gm-today-1', 'gm-reply-1'];
    recentGmail.calls.length = 0;
    const {
      rows: [{ start }],
    } = await pool.query<{ start: Date }>(
      `SELECT date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' AS start`,
    );
    const since = start.toISOString();
    const res = await request(app).post('/api/gmail/import').set(as(token)).send({ today: true });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ today: true, since, found: 2, enqueued: 1 });
    expect(recentGmail.calls).toEqual([{ days: 1, automatic: false, after: since }]);
    const {
      rows: [audited],
    } = await pool.query(
      `SELECT details FROM audit_events WHERE action='GMAIL_IMPORT_REQUESTED' ORDER BY id DESC LIMIT 1`,
    );
    expect(audited.details).toEqual({ today: true, since, found: 2, enqueued: 1 });
    await pool.query(`DELETE FROM gmail_ingest_queue WHERE gmail_message_id = 'gm-today-1'`);
  });
});

describe('Gmail emails classified before storing', () => {
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const gmailEmail = (id: string, extra: Record<string, unknown> = {}) => ({
    gmailMessageId: id,
    threadId: `thread-${id}`,
    fromAddress: 'noreply@vendor.test',
    toAddress: 'uw@insurer.com',
    subject: `Your weekly digest ${id}`,
    bodyText: `Digest body ${id}`,
    receivedAt: new Date(),
    attachments: [],
    ...extra,
  });

  it('never stores an email classified as not a submission, and does not queue it again', async () => {
    const { ingestGmailEmail } = await import('../src/services/pipeline.js');
    const { enqueueMessages } = await import('../src/services/ingestQueue.js');
    const email = gmailEmail('gm-skip-1', { signals: { autoSubmitted: 'auto-generated' } });
    expect(await ingestGmailEmail(email)).toBe('SKIPPED');

    expect((await pool.query(`SELECT 1 FROM emails WHERE gmail_message_id='gm-skip-1'`)).rowCount).toBe(0);
    const {
      rows: [skipped],
    } = await pool.query(`SELECT * FROM skipped_emails WHERE gmail_message_id='gm-skip-1'`);
    expect(skipped).toMatchObject({
      from_address: 'noreply@vendor.test',
      subject: 'Your weekly digest gm-skip-1',
      method: 'RULES',
    });
    expect(
      (await pool.query(`SELECT 1 FROM audit_events WHERE action='EMAIL_SKIPPED' AND entity_id='gm-skip-1'`)).rowCount,
    ).toBe(1);

    // Seen again by a poll, reconciliation or import: neither queued nor classified a second time.
    expect(await enqueueMessages(pool, ['gm-skip-1'], 'OAUTH')).toBe(0);
    expect(await ingestGmailEmail(email)).toBe('SKIPPED');
    expect(
      (await pool.query(`SELECT 1 FROM audit_events WHERE action='EMAIL_SKIPPED' AND entity_id='gm-skip-1'`)).rowCount,
    ).toBe(1);
  });

  it('lists skipped emails for the Ignored tab and processes one as a submission on request', async () => {
    const { ingestSkippedEmail } = await import('../src/services/pipeline.js');
    const list = (await request(app).get('/api/skipped-emails?q=digest%20gm-skip-1').set(as(token))).body;
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      gmailMessageId: 'gm-skip-1',
      fromAddress: 'noreply@vendor.test',
      method: 'RULES',
    });
    expect(list.items[0].reasons.length).toBeGreaterThan(0);
    expect((await request(app).get('/api/skipped-emails?q=no-such-subject').set(as(token))).body).toEqual({
      items: [],
      total: 0,
    });
    expect((await request(app).post('/api/skipped-emails/gm-not-skipped/process').set(as(token))).status).toBe(404);

    // The route fetches the email from Gmail again; here it is handed over directly.
    const {
      rows: [admin],
    } = await pool.query(`SELECT id, name FROM users WHERE email='admin@example.com'`);
    const id = await ingestSkippedEmail(
      gmailEmail('gm-skip-1', { signals: { autoSubmitted: 'auto-generated' } }),
      admin,
    );
    const {
      rows: [sub],
    } = await pool.query('SELECT classification, classification_reasons FROM submissions WHERE id=$1', [id]);
    expect(sub.classification).toBe('SUBMISSION');
    expect(sub.classification_reasons.at(-1)).toMatch(
      /^Manual override by .*: Processed as a submission from the Ignored tab$/,
    );
    expect((await pool.query(`SELECT 1 FROM skipped_emails WHERE gmail_message_id='gm-skip-1'`)).rowCount).toBe(0);
    expect(
      (
        await pool.query(`SELECT 1 FROM audit_events WHERE action='CLASSIFICATION_OVERRIDDEN' AND submission_id=$1`, [
          id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('deletes skipped emails from the Ignored tab, and Gmail still never imports them again', async () => {
    const { ingestGmailEmail } = await import('../src/services/pipeline.js');
    const { enqueueMessages } = await import('../src/services/ingestQueue.js');
    for (const id of ['gm-del-1', 'gm-del-2', 'gm-del-3']) {
      expect(await ingestGmailEmail(gmailEmail(id, { signals: { autoSubmitted: 'auto-generated' } }))).toBe('SKIPPED');
    }
    const total = async (q: string) =>
      (await request(app).get(`/api/skipped-emails?q=${q}`).set(as(token))).body.total as number;

    // One by one.
    expect((await request(app).delete('/api/skipped-emails/gm-del-1').set(as(token))).body).toEqual({ deleted: 1 });
    expect(await total('gm-del-1')).toBe(0);
    expect((await request(app).delete('/api/skipped-emails/gm-del-1').set(as(token))).status).toBe(404);
    expect((await request(app).post('/api/skipped-emails/gm-del-1/process').set(as(token))).status).toBe(404);

    // Every one matching the search.
    expect(await total('gm-del-')).toBe(2);
    const bulk = await request(app).post('/api/skipped-emails/delete').set(as(token)).send({ q: 'gm-del-' });
    expect(bulk.body).toEqual({ deleted: 2 });
    expect(await total('gm-del-')).toBe(0);

    // The rows stay, so a poll neither queues nor classifies them again; each delete is audited.
    expect(await enqueueMessages(pool, ['gm-del-1', 'gm-del-2', 'gm-del-3'], 'OAUTH')).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM skipped_emails WHERE gmail_message_id LIKE 'gm-del-%' AND deleted_by IS NOT NULL`,
        )
      ).rowCount,
    ).toBe(3);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM audit_events WHERE action='SKIPPED_EMAIL_DELETED' AND entity_id LIKE 'gm-del-%'`,
        )
      ).rowCount,
    ).toBe(3);
  });

  it('stores a submission with the verdict already saved, so processing does not classify it again', async () => {
    const { ingestGmailEmail } = await import('../src/services/pipeline.js');
    expect(
      await ingestGmailEmail(
        gmailEmail('gm-keep-1', {
          fromAddress: 'jane@acmebrokers.test',
          subject: 'New quote request for Dr. Kim',
          bodyText: 'Please quote this OB/GYN.',
        }),
      ),
    ).toBe('CREATED');
    const {
      rows: [sub],
    } = await pool.query(
      `SELECT s.id, s.classification FROM submissions s JOIN emails e ON e.id=s.email_id WHERE e.gmail_message_id='gm-keep-1'`,
    );
    expect(sub.classification).not.toBe('NOT_SUBMISSION');
    expect(sub.classification).not.toBeNull();
    await waitFor(
      async () => (await pool.query('SELECT status FROM submissions WHERE id=$1', [sub.id])).rows[0].status,
      (s) => s === 'READY_FOR_REVIEW' || s === 'ERROR',
    );
    const { rows } = await pool.query(
      `SELECT 1 FROM audit_events WHERE action='EMAIL_CLASSIFIED' AND submission_id=$1`,
      [sub.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('only classifies an imported email, and processes it when a person presses Process', async () => {
    const { ingestGmailEmail } = await import('../src/services/pipeline.js');
    const importedEmail = (id: string) =>
      gmailEmail(id, {
        fromAddress: 'jane@acmebrokers.test',
        subject: `Imported quote request ${id}`,
        bodyText: `Please quote this OB/GYN, imported ${id}.`,
      });
    expect(await ingestGmailEmail(importedEmail('gm-imp-1'), { imported: true })).toBe('CREATED');
    expect(await ingestGmailEmail(importedEmail('gm-imp-2'), { imported: true })).toBe('CREATED');
    const ids = (
      await pool.query<{ id: string; gid: string }>(
        `SELECT s.id, e.gmail_message_id AS gid FROM submissions s JOIN emails e ON e.id=s.email_id
         WHERE e.gmail_message_id IN ('gm-imp-1','gm-imp-2') ORDER BY e.gmail_message_id`,
      )
    ).rows.map((r) => r.id);
    const [first, second] = ids as [string, string];
    const row = async (id: string) =>
      (
        await pool.query(
          `SELECT status, classification, held_for_import, pipeline_progress, context_version FROM submissions WHERE id=$1`,
          [id],
        )
      ).rows[0];

    // Classified and stored, but no processing job: nothing else ran.
    for (const id of ids) {
      expect(await row(id)).toMatchObject({ status: 'READY_FOR_REVIEW', held_for_import: true, context_version: 0 });
      expect((await row(id)).classification).not.toBeNull();
      expect((await pool.query(`SELECT 1 FROM jobs WHERE dedupe_key=$1`, [`process:${id}`])).rowCount).toBe(0);
    }
    const detail = (await request(app).get(`/api/submissions/${first}`).set(as(token))).body;
    expect(detail.heldForImport).toBe(true);
    expect((await request(app).get('/api/gmail/import-settings').set(as(token))).body.awaitingProcess).toBe(2);

    // Process one: released and run.
    expect((await request(app).post(`/api/submissions/${first}/process`).set(as(token))).status).toBe(202);
    await waitFor(
      async () => (await row(first)).status,
      (s) => s === 'READY_FOR_REVIEW' || s === 'ERROR',
    );
    await waitFor(
      async () => (await row(first)).context_version,
      (v) => v > 0,
    );
    expect((await row(first)).held_for_import).toBe(false);
    // Not held any more: pressing it again is refused.
    expect((await request(app).post(`/api/submissions/${first}/process`).set(as(token))).status).toBe(409);

    // Process all: the rest.
    expect((await request(app).post('/api/submissions/imported/process-all').set(as(token))).body).toEqual({
      queued: 1,
    });
    await waitFor(
      async () => (await row(second)).context_version,
      (v) => v > 0,
    );
    expect((await request(app).get('/api/gmail/import-settings').set(as(token))).body.awaitingProcess).toBe(0);
    expect((await request(app).post('/api/submissions/imported/process-all').set(as(token))).body).toEqual({
      queued: 0,
    });
  });

  it('marks emails queued by a manual import, and not those queued automatically', async () => {
    const { enqueueMessages } = await import('../src/services/ingestQueue.js');
    await enqueueMessages(pool, ['gm-q-auto'], 'OAUTH');
    await enqueueMessages(pool, ['gm-q-imp', 'gm-q-auto'], 'OAUTH', { imported: true });
    const { rows } = await pool.query(
      `SELECT gmail_message_id, imported FROM gmail_ingest_queue WHERE gmail_message_id LIKE 'gm-q-%' ORDER BY 1`,
    );
    // Already queued automatically: it stays automatic.
    expect(rows).toEqual([
      { gmail_message_id: 'gm-q-auto', imported: false },
      { gmail_message_id: 'gm-q-imp', imported: true },
    ]);
    await pool.query(`DELETE FROM gmail_ingest_queue WHERE gmail_message_id LIKE 'gm-q-%'`);
  });
});

describe('Errors tab', () => {
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('lists failed submissions apart from the Submissions tab and retries them', async () => {
    const { ingestEmail } = await import('../src/services/pipeline.js');
    const { submissionId } = await ingestEmail(
      {
        gmailMessageId: null,
        threadId: null,
        fromAddress: 'broker@errors.test',
        toAddress: 'uw@insurer.com',
        subject: 'Errors tab quote request 6151',
        bodyText: 'Unique errors body 6151',
        receivedAt: new Date(),
        attachments: [],
      },
      null,
    );
    await waitFor(
      async () => (await pool.query('SELECT status FROM submissions WHERE id=$1', [submissionId])).rows[0].status,
      (s) => s === 'READY_FOR_REVIEW' || s === 'ERROR' || s === 'NOT_SUBMISSION',
    );
    await pool.query(`UPDATE submissions SET status='ERROR', processing_error='Drive unavailable' WHERE id=$1`, [
      submissionId,
    ]);

    const list = async (view: string) =>
      (await request(app).get('/api/submissions').set(as(token)).query({ view, q: 'Errors tab quote' })).body;
    const errors = await list('errors');
    expect(errors.items.map((s: { id: string }) => s.id)).toEqual([submissionId]);
    expect(errors.items[0].processingError).toBe('Drive unavailable');
    expect(errors.counts.errors).toBe(1);
    expect((await list('submissions')).items).toEqual([]);

    const res = await request(app).post('/api/submissions/errors/retry-all').set(as(token));
    expect(res.status).toBe(202);
    expect(res.body.queued).toBeGreaterThanOrEqual(1);
    await waitFor(
      async () => (await pool.query('SELECT status FROM submissions WHERE id=$1', [submissionId])).rows[0].status,
      (s) => s === 'READY_FOR_REVIEW',
    );
  });

  it('lists Gmail messages that failed to import and retries one on request', async () => {
    await pool.query(
      `INSERT INTO gmail_ingest_queue (gmail_message_id, source, attempts, last_error, next_attempt_at)
       VALUES ('gm-failed-1', 'OAUTH', 3, 'Claude API overloaded', now() + interval '1 hour'),
              ('gm-pending-1', 'OAUTH', 0, NULL, now() + interval '1 hour')`,
    );
    const { body } = await request(app).get('/api/ingest-queue/failed').set(as(token));
    expect(body.items.map((m: { gmailMessageId: string }) => m.gmailMessageId)).toEqual(['gm-failed-1']);
    expect(body.items[0]).toMatchObject({ attempts: 3, lastError: 'Claude API overloaded', source: 'OAUTH' });

    expect((await request(app).post('/api/ingest-queue/gm-failed-1/retry').set(as(token))).status).toBe(202);
    expect((await request(app).post('/api/ingest-queue/gm-unknown/retry').set(as(token))).status).toBe(404);
    expect((await request(app).post('/api/ingest-queue/bad%20id/retry').set(as(token))).status).toBe(400);
    expect(
      (await pool.query(`SELECT 1 FROM audit_events WHERE action='INGEST_RETRY_REQUESTED' AND entity_id='gm-failed-1'`))
        .rowCount,
    ).toBe(1);
    await pool.query(`DELETE FROM gmail_ingest_queue WHERE gmail_message_id IN ('gm-failed-1', 'gm-pending-1')`);
  });
});

describe('Claude API settings', () => {
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const KEY = 'sk-ant-test-0123456789abcdef-WXYZ';

  it('stores the key encrypted, shows only its last characters, and validates the model', async () => {
    const settings = await import('../src/services/anthropicSettings.js');
    await pool.query(`DELETE FROM app_settings WHERE key LIKE 'anthropic_%'`);
    await settings.refreshAnthropicSettings();
    expect((await request(app).get('/api/settings/anthropic').set(as(token))).body).toMatchObject({
      keySet: false,
      keyHint: null,
      model: 'claude-sonnet-5-5',
    });

    for (const body of [{ model: 'gpt-4' }, { model: 'claude-haiku-5-5', apiKey: 'short' }, {}]) {
      expect((await request(app).put('/api/settings/anthropic').set(as(token)).send(body)).status).toBe(400);
    }
    const saved = await request(app)
      .put('/api/settings/anthropic')
      .set(as(token))
      .send({ model: 'claude-haiku-5-5', apiKey: KEY });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ keySet: true, keyHint: '…WXYZ', model: 'claude-haiku-5-5' });
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    const {
      rows: [raw],
    } = await pool.query(`SELECT value FROM app_settings WHERE key='anthropic_api_key'`);
    expect(JSON.stringify(raw.value)).not.toContain(KEY);
    expect(settings.anthropicApiKey()).toBe(KEY);
    expect(settings.anthropicModel()).toBe('claude-haiku-5-5');

    // Omitting the key keeps it; null removes it.
    await request(app).put('/api/settings/anthropic').set(as(token)).send({ model: 'claude-sonnet-5-5' });
    expect(settings.anthropicApiKey()).toBe(KEY);
    await request(app).put('/api/settings/anthropic').set(as(token)).send({ model: 'claude-sonnet-5-5', apiKey: null });
    expect(settings.anthropicApiKey()).toBeNull();
    expect((await request(app).post('/api/settings/anthropic/test').set(as(token)).send({})).body).toEqual({
      ok: false,
      model: 'claude-sonnet-5-5',
      detail: 'No API key entered or saved',
    });

    const { rows } = await pool.query(
      `SELECT details FROM audit_events WHERE action='ANTHROPIC_SETTINGS_CHANGED' ORDER BY id`,
    );
    expect(rows.map((r) => r.details.key)).toEqual(['replaced', 'unchanged', 'removed']);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it('no longer holds the report output limit: it is left out of the view and a sent value is ignored', async () => {
    const settings = await import('../src/services/anthropicSettings.js');
    try {
      const view = (await request(app).get('/api/settings/anthropic').set(as(token))).body;
      expect(view).not.toHaveProperty('reportMaxTokens');
      expect(view).not.toHaveProperty('reportMaxTokensLimits');
      const saved = await request(app)
        .put('/api/settings/anthropic')
        .set(as(token))
        .send({ model: 'claude-opus-5-5', reportMaxTokens: 40_000 });
      expect(saved.status).toBe(200);
      expect(saved.body).not.toHaveProperty('reportMaxTokens');
      expect((await pool.query(`SELECT 1 FROM app_settings WHERE key='anthropic_report_max_tokens'`)).rowCount).toBe(0);
      const {
        rows: [last],
      } = await pool.query(
        `SELECT details FROM audit_events WHERE action='ANTHROPIC_SETTINGS_CHANGED' ORDER BY id DESC LIMIT 1`,
      );
      expect(last.details).not.toHaveProperty('reportMaxTokens');
    } finally {
      await pool.query(`DELETE FROM app_settings WHERE key LIKE 'anthropic_%'`);
      await settings.refreshAnthropicSettings();
    }
  });

  it('loads the saved settings on startup', async () => {
    const settings = await import('../src/services/anthropicSettings.js');
    await request(app).put('/api/settings/anthropic').set(as(token)).send({ model: 'claude-sonnet-5-5', apiKey: KEY });
    await pool.query(`UPDATE app_settings SET value='"claude-haiku-5-5"' WHERE key='anthropic_model'`);
    try {
      await settings.startAnthropicSettings();
      expect(settings.anthropicApiKey()).toBe(KEY);
      expect(settings.anthropicModel()).toBe('claude-haiku-5-5');
    } finally {
      settings.stopAnthropicSettingsSync();
      await pool.query(`DELETE FROM app_settings WHERE key LIKE 'anthropic_%'`);
      await settings.refreshAnthropicSettings();
    }
  });

  it('lets only admins change or test the settings', async () => {
    const uw = (
      await request(app)
        .post('/api/auth/login')
        .set(CLI)
        .send({ email: 'uw@example.com', password: 'underwriter-pass' })
    ).body.token;
    await request(app).put('/api/settings/anthropic').set(as(token)).send({ model: 'claude-sonnet-5-5', apiKey: KEY });
    try {
      const view = await request(app).get('/api/settings/anthropic').set(as(uw));
      expect(view.status).toBe(200);
      // Whether a key is set, but not its last characters: those are for settings managers.
      expect(view.body).toMatchObject({ keySet: true, keyHint: null });
      expect((await request(app).get('/api/settings/anthropic').set(as(token))).body.keyHint).toBe('…WXYZ');
    } finally {
      await request(app)
        .put('/api/settings/anthropic')
        .set(as(token))
        .send({ model: 'claude-sonnet-5-5', apiKey: null });
    }
    expect(
      (await request(app).put('/api/settings/anthropic').set(as(uw)).send({ model: 'claude-haiku-5-5' })).status,
    ).toBe(403);
    expect((await request(app).post('/api/settings/anthropic/test').set(as(uw)).send({})).status).toBe(403);
  });
});

describe('Automation settings', () => {
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  // vitest.config.ts sets AUTO_REPORTS=false, so with nothing saved the three report steps are manual.
  const DEFAULTS = {
    classification: 'AUTO',
    fieldExtraction: 'AUTO',
    npiVerification: 'AUTO',
    synthesis: 'MANUAL',
    analysis: 'MANUAL',
    autoQuote: 'MANUAL',
  };
  const reset = () => pool.query(`DELETE FROM app_settings WHERE key='automation_modes'`);

  it('defaults from AUTO_REPORTS, saves only the steps sent, and audits the change', async () => {
    await reset();
    expect((await request(app).get('/api/settings/automation').set(as(token))).body).toEqual(DEFAULTS);
    const saved = await request(app).put('/api/settings/automation').set(as(token)).send({ synthesis: 'AUTO' });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ...DEFAULTS, synthesis: 'AUTO' });
    // A second save of another step keeps the first.
    await request(app).put('/api/settings/automation').set(as(token)).send({ autoQuote: 'AUTO' });
    expect((await request(app).get('/api/settings/automation').set(as(token))).body).toEqual({
      ...DEFAULTS,
      synthesis: 'AUTO',
      autoQuote: 'AUTO',
    });
    const {
      rows: [ev],
    } = await pool.query(
      `SELECT details FROM audit_events WHERE action='AUTOMATION_SETTINGS_CHANGED' ORDER BY id DESC LIMIT 1`,
    );
    expect(ev.details).toEqual({ autoQuote: { from: 'MANUAL', to: 'AUTO' } });
    await reset();
  });

  it('rejects unknown steps, bad modes and empty bodies, and lets only admins save', async () => {
    for (const body of [{}, { synthesis: 'SOMETIMES' }, { unknownStep: 'AUTO' }]) {
      expect((await request(app).put('/api/settings/automation').set(as(token)).send(body)).status).toBe(400);
    }
    const uw = (
      await request(app)
        .post('/api/auth/login')
        .set(CLI)
        .send({ email: 'uw@example.com', password: 'underwriter-pass' })
    ).body.token;
    expect((await request(app).get('/api/settings/automation').set(as(uw))).status).toBe(200);
    expect((await request(app).put('/api/settings/automation').set(as(uw)).send({ synthesis: 'MANUAL' })).status).toBe(
      403,
    );
  });

  it('manual steps do not run when a new email arrives, and the button runs them in full', async () => {
    await request(app).put('/api/settings/automation').set(as(token)).send({
      fieldExtraction: 'MANUAL',
      npiVerification: 'MANUAL',
      synthesis: 'MANUAL',
      analysis: 'MANUAL',
      autoQuote: 'MANUAL',
    });
    try {
      const res = await request(app)
        .post('/api/submissions/upload')
        .set(as(token))
        .field('subject', 'New submission - Dr. Manual Mode OB/GYN professional liability')
        .field('fromAddress', 'broker@acme.com')
        .field(
          'bodyText',
          'Please quote. Application attached. NPI 1234567893. Effective date 2027-01-01. Limits 1M/3M.',
        )
        .attach('files', Buffer.from('Applicant: Manual Mode\nNPI 1234567893\nState: TX'), 'manual-application.txt');
      expect(res.status).toBe(201);
      const d = await waitFor(
        async () => (await request(app).get(`/api/submissions/${res.body.id}`).set(as(token))).body,
        (b) => b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR',
      );
      // On arrival: no fields, no NPI check, no reports. The documents are still read so they can be viewed.
      expect(d.status).toBe('READY_FOR_REVIEW');
      expect(d.extractedFields).toHaveLength(0);
      expect(d.npiVerifications).toHaveLength(0);
      expect(d.documents[0].extractionStatus).toBe('EXTRACTED');
      const reports = async () =>
        (await pool.query(`SELECT count(*)::int AS n FROM reports WHERE submission_id=$1`, [res.body.id])).rows[0].n;
      expect(await reports()).toBe(0);

      // "Re-run extraction + NPI" while the settings are still Manual: Claude extracts the fields and the NPI is checked.
      expect((await request(app).post(`/api/submissions/${res.body.id}/reprocess`).set(as(token))).status).toBe(202);
      const again = await waitFor(
        async () => (await request(app).get(`/api/submissions/${res.body.id}`).set(as(token))).body,
        (b) => b.contextVersion > d.contextVersion && (b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR'),
      );
      expect(again.status).toBe('READY_FOR_REVIEW');
      expect(again.extractedFields.map((f: { fieldName: string }) => f.fieldName).sort()).toEqual([
        'applicant_name',
        'npi',
        'practice_state',
      ]);
      expect(again.npiVerifications[0]).toMatchObject({ npi: '1234567893', status: 'MATCH' });
      // A re-run is not a request for reports: Synthesis is Manual, so none is generated.
      expect(await reports()).toBe(0);
    } finally {
      await reset();
    }
  });

  it('with classification manual, Claude is not asked and an underwriter decides', async () => {
    await request(app).put('/api/settings/automation').set(as(token)).send({ classification: 'MANUAL' });
    try {
      const res = await request(app)
        .post('/api/submissions/upload')
        .set(as(token))
        .field('subject', 'Quick question')
        .field('fromAddress', 'someone@example.com')
        .field('bodyText', 'Hello, could you call me back about our account?');
      expect(res.status).toBe(201);
      const d = await waitFor(
        async () => (await request(app).get(`/api/submissions/${res.body.id}`).set(as(token))).body,
        (b) => !['NEW', 'PROCESSING'].includes(b.status),
      );
      // Rules that are sure still decide on their own; anything else waits for a person instead of going to Claude
      // (the mocked Claude would have answered SUBMISSION).
      expect(d.classification).not.toBe('SUBMISSION');
      if (d.classification === 'REVIEW_REQUIRED') {
        expect(d.classificationReasons.join(' ')).toMatch(/Classification is manual/);
      }
    } finally {
      await reset();
    }
  });

  describe('held for classification (classification manual, uncertain email)', () => {
    const get = async (id: string) => (await request(app).get(`/api/submissions/${id}`).set(as(token))).body;
    const audits = async (id: string, action: string) =>
      (
        await pool.query(`SELECT details FROM audit_events WHERE submission_id=$1 AND action=$2 ORDER BY id`, [
          id,
          action,
        ])
      ).rows;
    const reportCount = async (id: string) =>
      (await pool.query(`SELECT count(*)::int AS n FROM reports WHERE submission_id=$1`, [id])).rows[0].n;
    const npiLookups = async () => vi.mocked((await import('../src/services/npi.js')).lookupNpi).mock.calls.length;
    // The rules can't decide (no submission words, an attachment name that says nothing), so manual classification
    // leaves it REVIEW_REQUIRED.
    const uncertain = (n: string) =>
      request(app)
        .post('/api/submissions/upload')
        .set(as(token))
        .field('subject', `Quick question ${n}`)
        .field('fromAddress', 'someone@example.com')
        // Unique text and file, so it is never taken for a duplicate of the others.
        .field('bodyText', `Hello, could you call me back about our account? Ref ${n}`)
        .attach('files', Buffer.from(`Applicant: Jane Smith\nNPI 1234567893\nState: TX\nRef ${n}`), `notes-${n}.txt`);
    const held = async (n: string) => {
      const res = await uncertain(n);
      expect(res.status).toBe(201);
      const d = await waitFor(
        () => get(res.body.id),
        (b) => !['NEW', 'PROCESSING'].includes(b.status),
      );
      expect(d.classification).toBe('REVIEW_REQUIRED');
      return d;
    };
    const manual = (extra: Record<string, string> = {}) =>
      request(app)
        .put('/api/settings/automation')
        .set(as(token))
        .send({ classification: 'MANUAL', synthesis: 'AUTO', ...extra });

    it('holds the email: documents read, but no extraction, NPI check, context version or reports', async () => {
      await manual();
      try {
        llmCalls.length = 0;
        const lookups = await npiLookups();
        const d = await held('held-1');
        expect(d.status).toBe('READY_FOR_REVIEW');
        expect(d.heldForClassification).toBe(true);
        expect(d.documents[0].extractionStatus).toBe('EXTRACTED');
        expect(d.extractedFields).toHaveLength(0);
        expect(d.npiVerifications).toHaveLength(0);
        expect(d.contextVersion).toBe(0);
        expect(llmCalls).toEqual([]);
        expect(await npiLookups()).toBe(lookups);
        expect(await reportCount(d.id)).toBe(0);
        expect(await audits(d.id, 'FIELDS_EXTRACTED')).toHaveLength(0);
        expect(await audits(d.id, 'PROCESSING_HELD')).toEqual([{ details: { reason: 'classification manual' } }]);
        // The inbox row carries the flag too.
        const list = await request(app).get('/api/submissions').set(as(token)).query({ q: 'held-1' });
        expect(list.body.items.find((i: { id: string }) => i.id === d.id)).toMatchObject({
          heldForClassification: true,
        });

        // REVIEW_REQUIRED again: still held, nothing runs.
        expect(
          (
            await request(app)
              .post(`/api/submissions/${d.id}/classification`)
              .set(as(token))
              .send({ classification: 'REVIEW_REQUIRED', reason: 'Still unsure' })
          ).status,
        ).toBe(200);
        expect(await get(d.id)).toMatchObject({
          heldForClassification: true,
          status: 'READY_FOR_REVIEW',
          extractedFields: [],
        });
      } finally {
        await reset();
      }
    });

    it('a rules-decisive submission is not held under manual classification', async () => {
      await manual({ synthesis: 'MANUAL' });
      try {
        const res = await request(app)
          .post('/api/submissions/upload')
          .set(as(token))
          .field('subject', 'New submission - Dr. Rules Decide OB/GYN professional liability quote request')
          .field('fromAddress', 'broker@acme.com')
          .field(
            'bodyText',
            'Please quote. Application and loss runs attached. NPI 1234567893. Effective date 2027-01-01. Limits 1M/3M.',
          )
          .attach('files', Buffer.from('Applicant: Rules Decide\nNPI 1234567893\nState: TX'), 'application.txt')
          .attach('files', Buffer.from('No losses for Dr. Rules Decide'), 'loss-runs.txt');
        const d = await waitFor(
          () => get(res.body.id),
          (b) => b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR',
        );
        expect(d.classification).toBe('SUBMISSION');
        expect(d.heldForClassification).toBe(false);
        expect(d.extractedFields.length).toBeGreaterThan(0);
        expect(await audits(d.id, 'PROCESSING_HELD')).toHaveLength(0);
      } finally {
        await reset();
      }
    });

    it('automatic classification never holds', async () => {
      await reset();
      const res = await uncertain('held-auto');
      // The mocked Claude answers SUBMISSION, so it is processed in full.
      const d = await waitFor(
        () => get(res.body.id),
        (b) => b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR',
      );
      expect(d.heldForClassification).toBe(false);
      expect(d.extractedFields.length).toBeGreaterThan(0);
      expect(await audits(d.id, 'PROCESSING_HELD')).toHaveLength(0);
    });

    it('override to SUBMISSION releases it; the remaining steps follow their own modes', async () => {
      await manual({ synthesis: 'MANUAL' });
      try {
        const d = await held('held-release');
        expect(
          (
            await request(app)
              .post(`/api/submissions/${d.id}/classification`)
              .set(as(token))
              .send({ classification: 'SUBMISSION', reason: 'It is a submission' })
          ).status,
        ).toBe(200);
        const done = await waitFor(
          () => get(d.id),
          (b) => b.status === 'READY_FOR_REVIEW' && b.extractedFields.length > 0,
        );
        expect(done.heldForClassification).toBe(false);
        expect(done.npiVerifications[0]).toMatchObject({ npi: '1234567893', status: 'MATCH' });

        // With extraction Manual, the release does not extract: the queued run is not a person's re-run.
        await request(app).put('/api/settings/automation').set(as(token)).send({ fieldExtraction: 'MANUAL' });
        const second = await held('held-release-manual');
        expect(
          (
            await request(app)
              .post(`/api/submissions/${second.id}/classification`)
              .set(as(token))
              .send({ classification: 'SUBMISSION', reason: 'It is a submission' })
          ).status,
        ).toBe(200);
        await waitFor(
          () => audits(second.id, 'FIELDS_EXTRACTED'),
          (r) => r.length > 0,
        );
        const after = await waitFor(
          () => get(second.id),
          (b) => b.status === 'READY_FOR_REVIEW',
        );
        expect(after.heldForClassification).toBe(false);
        expect(after.extractedFields).toHaveLength(0);
        expect((await audits(second.id, 'FIELDS_EXTRACTED'))[0].details).toMatchObject({ skipped: 'MANUAL' });
      } finally {
        await reset();
      }
    });

    it('override to NOT_SUBMISSION releases it as ignored', async () => {
      await manual();
      try {
        const d = await held('held-ignore');
        expect(
          (
            await request(app)
              .post(`/api/submissions/${d.id}/classification`)
              .set(as(token))
              .send({ classification: 'NOT_SUBMISSION', reason: 'Not a submission' })
          ).status,
        ).toBe(200);
        expect(await get(d.id)).toMatchObject({
          status: 'NOT_SUBMISSION',
          heldForClassification: false,
          extractedFields: [],
        });
      } finally {
        await reset();
      }
    });

    it('"Re-run extraction + NPI" on a held email runs every step and clears the hold', async () => {
      await manual({ synthesis: 'MANUAL' });
      try {
        const d = await held('held-rerun');
        expect((await request(app).post(`/api/submissions/${d.id}/reprocess`).set(as(token))).status).toBe(202);
        const again = await waitFor(
          () => get(d.id),
          (b) => b.contextVersion > d.contextVersion && (b.status === 'READY_FOR_REVIEW' || b.status === 'ERROR'),
        );
        expect(again.status).toBe('READY_FOR_REVIEW');
        expect(again.heldForClassification).toBe(false);
        expect(again.extractedFields.length).toBeGreaterThan(0);
        expect(again.npiVerifications[0]).toMatchObject({ npi: '1234567893', status: 'MATCH' });
      } finally {
        await reset();
      }
    });
  });
});

describe('Connection tests', () => {
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('lists every service and tests one live', async () => {
    const list = await request(app).get('/api/settings/connections').set(as(token));
    expect(list.body.map((c: { key: string }) => c.key)).toEqual([
      'database',
      'llm',
      'gmail',
      'drive',
      'npi',
      'ims2Queue',
    ]);
    const db = await request(app).post('/api/settings/connections/database/test').set(as(token));
    expect(db.body).toMatchObject({ key: 'database', ok: true, configured: true });
    expect(db.body.detail).toMatch(/PostgreSQL/);
    expect((await request(app).post('/api/settings/connections/nothing/test').set(as(token))).status).toBe(404);
  });

  it('lets only admins run a test', async () => {
    const uw = (
      await request(app)
        .post('/api/auth/login')
        .set(CLI)
        .send({ email: 'uw@example.com', password: 'underwriter-pass' })
    ).body.token;
    expect((await request(app).get('/api/settings/connections').set(as(uw))).status).toBe(200);
    expect((await request(app).post('/api/settings/connections/database/test').set(as(uw))).status).toBe(403);
  });
});

describe('Monitoring errors', () => {
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('lets an admin clear errors, keeping the rows for reconciliation', async () => {
    const { recordSystemError } = await import('../src/services/audit.js');
    await recordSystemError('gmail:poll', new Error('poll failed'));
    await recordSystemError('reconcile:gm-1', new Error('attachment mismatch'));
    const before = (await request(app).get('/api/monitoring/stats').set(as(token))).body.recentErrors;
    expect(before.map((e: { scope: string }) => e.scope)).toEqual(
      expect.arrayContaining(['gmail:poll', 'reconcile:gm-1']),
    );

    const uw = (
      await request(app)
        .post('/api/auth/login')
        .set(CLI)
        .send({ email: 'uw@example.com', password: 'underwriter-pass' })
    ).body.token;
    expect((await request(app).post('/api/monitoring/errors/clear').set(as(uw))).status).toBe(403);
    // Raw errors, LLM usage and the global audit trail are for admins only.
    for (const url of ['/api/monitoring/stats', '/api/monitoring/llm-usage', '/api/audit']) {
      expect((await request(app).get(url).set(as(uw))).status).toBe(403);
    }

    const cleared = await request(app).post('/api/monitoring/errors/clear').set(as(token));
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toBe(before.length);
    expect((await request(app).get('/api/monitoring/stats').set(as(token))).body.recentErrors).toEqual([]);
    expect((await request(app).post('/api/monitoring/errors/clear').set(as(token))).body).toEqual({ cleared: 0 });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM system_errors WHERE scope='reconcile:gm-1' AND cleared_at IS NOT NULL`,
    );
    expect(rows[0].n).toBe(1);
    const {
      rows: [audited],
    } = await pool.query(`SELECT details FROM audit_events WHERE action='SYSTEM_ERRORS_CLEARED'`);
    expect(audited.details).toEqual({ cleared: before.length });

    // A new error shows up again after a clear.
    await recordSystemError('gmail:poll', new Error('poll failed again'));
    expect((await request(app).get('/api/monitoring/stats').set(as(token))).body.recentErrors).toHaveLength(1);
  });
});

describe('Monitoring range', () => {
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('counts only the chosen period, defaulting to today', async () => {
    await pool.query(
      `INSERT INTO system_errors (scope, message, created_at) VALUES ('old:scope', 'three days old', now() - interval '3 days')`,
    );
    await pool.query(`INSERT INTO system_errors (scope, message) VALUES ('new:scope', 'just now')`);
    const stats = (range?: string, tz?: string) =>
      request(app)
        .get(`/api/monitoring/stats?${new URLSearchParams({ ...(range ? { range } : {}), ...(tz ? { tz } : {}) })}`)
        .set(as(token));
    const scopes = (b: { recentErrors: { scope: string }[] }) => b.recentErrors.map((e) => e.scope);

    const today = (await stats()).body;
    expect(today.range).toBe('today');
    expect(scopes(today)).toContain('new:scope');
    expect(scopes(today)).not.toContain('old:scope');
    // The viewer's time zone sets where today starts; an unknown zone falls back to UTC instead of failing.
    expect((await stats('today', 'America/New_York')).status).toBe(200);
    expect((await stats('today', 'Not/AZone')).status).toBe(200);

    const day = (await stats('24h')).body;
    expect(day.range).toBe('24h');
    expect(scopes(day)).not.toContain('old:scope');
    expect(scopes((await stats('7d')).body)).toContain('old:scope');

    const all = (await stats('all')).body;
    const total = (b: { byStatus: Record<string, number> }) => Object.values(b.byStatus).reduce((n, v) => n + v, 0);
    const {
      rows: [{ n }],
    } = await pool.query('SELECT count(*)::int AS n FROM submissions WHERE deleted_at IS NULL');
    expect(total(all)).toBe(n);
    expect(all.emails).toBeGreaterThanOrEqual(day.emails);
    expect((await stats('1y')).status).toBe(400);
  });
});

describe('Deleting ignored emails', () => {
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const ignoredList = async (q?: string) =>
    (
      await request(app)
        .get('/api/submissions')
        .set(as(token))
        .query({ view: 'ignored', pageSize: 100, ...(q ? { q } : {}) })
    ).body;
  const newsletter = async (subject: string, from: string) => {
    const { body } = await request(app)
      .post('/api/submissions/upload')
      .set(as(token))
      .field('subject', subject)
      .field('fromAddress', from)
      .field(
        'bodyText',
        'Our monthly newsletter with promotion offers on software. Click to unsubscribe from these emails at any time.',
      );
    return (
      await waitFor(
        async () => (await request(app).get(`/api/submissions/${body.id}`).set(as(token))).body,
        (b) => b.status === 'NOT_SUBMISSION',
      )
    ).id as string;
  };

  it('hides one ignored email, admins only, and keeps the row and its audit trail', async () => {
    const id = await newsletter('Gadget digest one', 'noreply@gadgets.test');
    const uw = (
      await request(app)
        .post('/api/auth/login')
        .set(CLI)
        .send({ email: 'uw@example.com', password: 'underwriter-pass' })
    ).body.token;
    expect((await request(app).delete(`/api/submissions/${id}`).set(as(uw))).status).toBe(403);

    const res = await request(app).delete(`/api/submissions/${id}`).set(as(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1 });
    expect((await request(app).get(`/api/submissions/${id}`).set(as(token))).status).toBe(404);
    expect((await ignoredList()).items.map((s: { id: string }) => s.id)).not.toContain(id);
    expect((await request(app).delete(`/api/submissions/${id}`).set(as(token))).status).toBe(404);

    const {
      rows: [row],
    } = await pool.query('SELECT deleted_at, email_id FROM submissions WHERE id=$1', [id]);
    expect(row.deleted_at).not.toBeNull();
    expect((await pool.query('SELECT 1 FROM emails WHERE id=$1', [row.email_id])).rowCount).toBe(1);
    expect(
      (await pool.query(`SELECT 1 FROM audit_events WHERE action='SUBMISSION_DELETED' AND submission_id=$1`, [id]))
        .rowCount,
    ).toBe(1);
  });

  it('deletes a submission with the copies held as its duplicates, never one still processing', async () => {
    const send = () =>
      request(app)
        .post('/api/submissions/upload')
        .set(as(token))
        .field('subject', 'New submission - Dr. Omar Delete cardiology professional liability')
        .field('fromAddress', 'broker@delete.test')
        .field(
          'bodyText',
          'Please quote. Application and loss runs attached. NPI 1234567893. Effective 2027-03-01. Limits 1M/3M.',
        )
        .attach('files', Buffer.from('Applicant: Omar Delete\nNPI 1234567893\nState: NY'), 'delete-application.txt');
    const original = (await send()).body.id as string;
    await waitFor(
      async () => (await request(app).get(`/api/submissions/${original}`).set(as(token))).body,
      (b) => !['NEW', 'PROCESSING'].includes(b.status),
    );
    const copy = (await send()).body;
    expect(copy).toMatchObject({ status: 'DUPLICATE', duplicateOf: { id: original } });

    await pool.query(`UPDATE submissions SET status='PROCESSING' WHERE id=$1`, [original]);
    const busy = await request(app).delete(`/api/submissions/${original}`).set(as(token));
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('STILL_PROCESSING');
    expect(
      (
        await request(app)
          .post('/api/submissions/submissions/delete')
          .set(as(token))
          .send({ ids: [original] })
      ).body,
    ).toEqual({ deleted: 0 });
    await pool.query(`UPDATE submissions SET status='READY_FOR_REVIEW' WHERE id=$1`, [original]);

    expect((await request(app).delete(`/api/submissions/${original}`).set(as(token))).body).toEqual({ deleted: 2 });
    for (const id of [original, copy.id])
      expect((await request(app).get(`/api/submissions/${id}`).set(as(token))).status).toBe(404);
    const {
      rows: [audited],
    } = await pool.query(`SELECT details FROM audit_events WHERE action='SUBMISSION_DELETED' AND submission_id=$1`, [
      copy.id,
    ]);
    expect(audited.details).toMatchObject({ copyOf: original });

    // A resend is no longer held as a copy of the deleted submission.
    const resend = (await send()).body;
    expect(resend.status).not.toBe('DUPLICATE');
    expect(resend.duplicateOf).toBeNull();
  });

  it('deletes from the Duplicates tab by filter, leaving other tabs alone', async () => {
    // The previous test's resend may still be processing; let it settle so the tab counts hold still.
    await (await import('../src/services/jobQueue.js')).jobs.drain();
    const dupBefore = (await request(app).get('/api/submissions').set(as(token)).query({ view: 'duplicates' })).body;
    const res = await request(app).post('/api/submissions/duplicates/delete').set(as(token)).send({});
    expect(res.body.deleted).toBe(dupBefore.total);
    const after = (await request(app).get('/api/submissions').set(as(token)).query({ view: 'duplicates' })).body;
    expect(after.total).toBe(0);
    expect(after.counts.submissions).toBe(dupBefore.counts.submissions);
    expect((await request(app).post('/api/submissions/everything/delete').set(as(token)).send({})).status).toBe(400);
  });

  it('deletes only the selected ignored emails', async () => {
    const a = await newsletter('Camera digest', 'noreply@camera.test');
    const b = await newsletter('Kitchen weekly', 'noreply@kitchen.test');
    const { items } = (await request(app).get('/api/submissions').set(as(token)).query({ view: 'submissions' })).body;
    const res = await request(app)
      .post('/api/submissions/ignored/delete')
      .set(as(token))
      .send({ ids: [a, items[0].id] });
    expect(res.body).toEqual({ deleted: 1 }); // the non-ignored id is skipped
    const left = (await ignoredList()).items.map((s: { id: string }) => s.id);
    expect(left).not.toContain(a);
    expect(left).toContain(b);
    expect((await request(app).get(`/api/submissions/${items[0].id}`).set(as(token))).status).toBe(200);
  });

  it('deletes every ignored email matching the search, then all of them', async () => {
    await newsletter('Gadget digest two', 'noreply@gadgets.test');
    await newsletter('Garden weekly', 'noreply@garden.test');
    expect(
      (await request(app).post('/api/submissions/ignored/delete').set(as(token)).send({ q: 'Gadget digest' })).body,
    ).toEqual({ deleted: 1 });
    expect((await ignoredList('Gadget digest')).total).toBe(0);
    expect((await ignoredList('Garden weekly')).total).toBe(1);

    const before = (await ignoredList()).total;
    const all = await request(app).post('/api/submissions/ignored/delete').set(as(token)).send({});
    expect(all.body).toEqual({ deleted: before });
    expect((await ignoredList()).total).toBe(0);
    expect((await ignoredList()).counts.ignored).toBe(0);
  });
});

describe('production guardrails', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  let id = '';
  const upload = (subject: string, extra: Record<string, string> = {}, who = auth()) => {
    let r = request(app)
      .post('/api/submissions/upload')
      .set(who)
      .field('subject', subject)
      .field('fromAddress', `guard-${subject.length}@guard-broker.test`)
      .field('bodyText', `${subject}: please quote, NPI 1234567893. Reference ${Math.random()}`);
    for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
    // Distinct bytes per upload, so duplicate detection never holds one back.
    return r.attach(
      'files',
      Buffer.from(`Applicant: Dr. Guard\nNPI 1234567893\n${subject} ${Math.random()}`),
      'guard.txt',
    );
  };
  const send = (body: Record<string, unknown>, key?: string) => {
    const r = request(app).post(`/api/submissions/${id}/outbound-emails`).set(auth());
    return (key ? r.set('Idempotency-Key', key) : r).send({
      mode: 'REPLY',
      to: ['pat@brokerage.test'],
      subject: 'Re: Guard',
      body: 'Thanks',
      ...body,
    });
  };

  beforeAll(async () => {
    id = (await upload('Guardrail submission for Dr. Guard')).body.id;
    await waitFor(
      async () => (await request(app).get(`/api/submissions/${id}`).set(auth())).body,
      (b) => b.status === 'READY_FOR_REVIEW',
    );
  });

  it('sends once per idempotency key and returns the same email on a retry', async () => {
    const before = sentMail.length;
    const first = await send({}, 'guard-key-0001');
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('SENT');
    const retry = await send({ body: 'edited, but the key was already used' }, 'guard-key-0001');
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ id: first.body.id, body: 'Thanks' });
    expect(sentMail.length).toBe(before + 1);
    // The key also works as a body field.
    const viaBody = await send({ idempotencyKey: 'guard-key-0002' });
    expect((await send({ idempotencyKey: 'guard-key-0002' })).body.id).toBe(viaBody.body.id);
    expect(sentMail.length).toBe(before + 2);

    // An attempt whose outcome was never recorded is never sent again.
    await pool.query(`UPDATE outbound_emails SET status='PENDING' WHERE id=$1`, [first.body.id]);
    const stuck = await send({}, 'guard-key-0001');
    expect(stuck.status).toBe(409);
    expect(stuck.body.error.code).toBe('SEND_IN_PROGRESS');
    expect(sentMail.length).toBe(before + 2);
    await pool.query(`UPDATE outbound_emails SET status='SENT' WHERE id=$1`, [first.body.id]);

    const list = (await request(app).get(`/api/submissions/${id}/outbound-emails`).set(auth())).body.items;
    expect(list.filter((m: { id: string }) => [first.body.id, viaBody.body.id].includes(m.id))).toHaveLength(2);
  });

  it('refuses recipients outside OUTBOUND_ALLOWED_DOMAINS', async () => {
    const { config } = await import('../src/config.js');
    const saved = config.OUTBOUND_ALLOWED_DOMAINS;
    const before = sentMail.length;
    try {
      config.OUTBOUND_ALLOWED_DOMAINS = ['brokerage.test'];
      const res = await send({ to: ['pat@brokerage.test'], cc: ['leak@elsewhere.test'] }, 'guard-key-0003');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'RECIPIENT_NOT_ALLOWED',
        details: { rejected: ['leak@elsewhere.test'], allowedDomains: ['brokerage.test'] },
      });
      expect(res.body.error.message).toContain('leak@elsewhere.test');
      expect((await send({ to: ['ops@mail.brokerage.test'] }, 'guard-key-0004')).status).toBe(201);
    } finally {
      config.OUTBOUND_ALLOWED_DOMAINS = saved;
    }
    expect(sentMail.length).toBe(before + 1);
  });

  it('allows only review-state changes by hand (409 otherwise)', async () => {
    const patch = (status: string) => request(app).patch(`/api/submissions/${id}`).set(auth()).send({ status });
    for (const status of ['NEW', 'PROCESSING', 'ERROR', 'NOT_SUBMISSION']) {
      const res = await patch(status);
      expect(res.status, status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
    }
    expect((await patch('IN_REVIEW')).body.status).toBe('IN_REVIEW');
    expect((await patch('COMPLETED')).body.status).toBe('COMPLETED');
    expect((await patch('READY_FOR_REVIEW')).status).toBe(409);
    expect((await patch('IN_REVIEW')).body.status).toBe('IN_REVIEW');
  });

  it('records concurrent assessments as consecutive versions', async () => {
    const post = (n: number) =>
      request(app)
        .post(`/api/submissions/${id}/assessments`)
        .set(auth())
        .send({ decision: 'REFER', riskRating: 'MODERATE', notes: `parallel ${n}` });
    const results = await Promise.all([post(1), post(2), post(3)]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(results.map((r) => r.body.version).sort()).toEqual([1, 2, 3]);
  });

  it('keeps Gmail ids on uploads for admins only', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const { signToken } = await import('../src/http.js');
    const {
      rows: [u],
    } = await pool.query(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('uw-guard@example.com', 'Uma', $1, 'UNDERWRITER') RETURNING *`,
      [await bcrypt.hash('x-password-123', 4)],
    );
    const uw = {
      Authorization: `Bearer ${signToken({ id: u.id, email: u.email, name: u.name, role: 'UNDERWRITER' }, u.token_version)}`,
    };
    const res = await upload('Underwriter upload with a Gmail id', { gmailMessageId: 'gm-guard-1' }, uw);
    expect(res.status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM emails WHERE gmail_message_id='gm-guard-1'`)).rowCount).toBe(0);
    expect((await upload('Underwriter upload without ids', {}, uw)).status).toBe(201);
  });

  it('serves documents uncached, and nothing of a deleted submission', async () => {
    const other = (await upload('Guardrail submission to delete')).body.id;
    const detail = await waitFor(
      async () => (await request(app).get(`/api/submissions/${other}`).set(auth())).body,
      (b) => b.status === 'READY_FOR_REVIEW',
    );
    const docId = detail.documents[0].id;
    const dl = await request(app).get(`/api/documents/${docId}/download`).set(auth());
    expect(dl.status).toBe(200);
    expect(dl.headers['cache-control']).toBe('private, no-store');
    expect(dl.headers['content-type']).toMatch(/^text\/plain/);
    const s = await request(app).post(`/api/submissions/${other}/synthesis`).set(auth()).send({});
    await waitFor(
      async () => (await request(app).get(`/api/reports/${s.body.id}`).set(auth())).body,
      (b) => b.status !== 'RUNNING',
    );

    // A sender-supplied type that is not a valid media type is served as octet-stream.
    await pool.query(`UPDATE documents SET mime_type=$2 WHERE id=$1`, [docId, 'text/html\nX-Evil: 1']);
    expect((await request(app).get(`/api/documents/${docId}/download`).set(auth())).headers['content-type']).toBe(
      'application/octet-stream',
    );

    expect((await request(app).delete(`/api/submissions/${other}`).set(auth())).status).toBe(200);
    for (const url of [
      `/api/documents/${docId}/download`,
      `/api/documents/${docId}/view`,
      `/api/reports/${s.body.id}`,
      `/api/submissions/${other}/reports`,
      `/api/submissions/${other}/chat`,
      `/api/submissions/${other}/outbound-emails`,
    ]) {
      expect((await request(app).get(url).set(auth())).status, url).toBe(404);
    }
  });

  it('refuses AI work over the daily token budget', async () => {
    const { config } = await import('../src/config.js');
    const saved = config.LLM_DAILY_TOKEN_BUDGET;
    try {
      config.LLM_DAILY_TOKEN_BUDGET = 1;
      await pool.query(`INSERT INTO llm_calls (task, skill_name, skill_version, model, status, input_tokens, output_tokens, duration_ms)
        VALUES ('chat', 'workspace-chat', 'test', 'mock-model', 'SUCCESS', 10, 10, 1)`);
      const res = await request(app).post(`/api/submissions/${id}/synthesis`).set(auth()).send({ force: true });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('LLM_BUDGET_EXCEEDED');
      const chat = await request(app).post(`/api/submissions/${id}/chat`).set(auth()).send({ message: 'Anything?' });
      expect(chat.status).toBe(429);
      expect((await request(app).get(`/api/submissions/${id}/chat`).set(auth())).body.items).toHaveLength(0);
    } finally {
      config.LLM_DAILY_TOKEN_BUDGET = saved;
    }
  });
});

describe('Auth and sessions', () => {
  // Runs last: it revokes tokens, but never the admin `token` the other suites use.
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const NIL = '00000000-0000-0000-0000-000000000000';
  const password = 'session-pass-123';

  /** A user inserted directly (logins are rate limited) and a token for them. */
  async function makeUser(email: string, role: 'ADMIN' | 'UNDERWRITER' | 'VIEWER') {
    const bcrypt = (await import('bcryptjs')).default;
    const { signToken } = await import('../src/http.js');
    const {
      rows: [u],
    } = await pool.query('INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *', [
      email,
      email.split('@')[0],
      await bcrypt.hash(password, 4),
      role,
    ]);
    return { id: u.id as string, token: signToken({ id: u.id, email, name: u.name, role }, u.token_version) };
  }
  const freshToken = async (id: string) => {
    const { signToken } = await import('../src/http.js');
    const {
      rows: [u],
    } = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
    return signToken({ id, email: u.email, name: u.name, role: u.role }, u.token_version);
  };

  it('rejects the Gmail OAuth state token (and an old-style one) as a login token', async () => {
    const { signOAuthState } = await import('../src/services/gmail.js');
    const {
      rows: [admin],
    } = await pool.query(`SELECT id FROM users WHERE email='admin@example.com'`);
    expect(
      (
        await request(app)
          .get('/api/submissions')
          .set(bearer(signOAuthState(admin.id)))
      ).status,
    ).toBe(401);
    const jwt = (await import('jsonwebtoken')).default;
    const legacy = jwt.sign({ sub: admin.id, purpose: 'gmail-oauth' }, process.env.JWT_SECRET!, { expiresIn: '10m' });
    expect((await request(app).get('/api/submissions').set(bearer(legacy))).status).toBe(401);
    expect((await request(app).get('/api/submissions').set(bearer(token))).status).toBe(200);
  });

  it('audits failed sign-ins without storing the attempted email', async () => {
    const u = await makeUser('failed-login@example.com', 'UNDERWRITER');
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .set(CLI)
          .send({ email: 'failed-login@example.com', password: 'not-the-password' })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .set(CLI)
          .send({ email: 'nobody-here@example.com', password: 'not-the-password' })
      ).status,
    ).toBe(401);
    const { rows } = await pool.query(
      `SELECT entity_id, actor_type, details FROM audit_events WHERE action='USER_LOGIN_FAILED' ORDER BY created_at DESC LIMIT 2`,
    );
    expect(rows.map((r) => r.details.reason)).toEqual(['UNKNOWN_EMAIL', 'WRONG_PASSWORD']);
    expect(rows[1].entity_id).toBe(u.id);
    expect(rows[0].entity_id).toBeNull();
    expect(rows.every((r) => r.actor_type === 'SYSTEM' && /^[0-9a-f]{16}$/.test(r.details.emailHash))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('nobody-here');
  });

  it('signs in with an httpOnly cookie, requires the CSRF header on unsafe requests, and signs out', async () => {
    const u = await makeUser('cookie@example.com', 'UNDERWRITER');
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ email: 'cookie@example.com', password });
    expect(login.status).toBe(200);
    // A browser gets the token only in the httpOnly cookie, never in the body a page script could read.
    expect(login.body).not.toHaveProperty('token');
    expect(login.body.user.email).toBe('cookie@example.com');
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/ims_session=/);
    const cookieToken = /ims_session=([^;]+)/.exec(setCookie)![1];
    // A script that asks for it gets the token in the body as well.
    const script = await request(app).post('/api/auth/login').set(CLI).send({ email: 'cookie@example.com', password });
    expect(typeof script.body.token).toBe('string');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect((await agent.get('/api/auth/me')).body.email).toBe('cookie@example.com');

    // Cookie POST without the header is refused; with it, it goes through (404: no such submission).
    expect((await agent.post(`/api/submissions/${NIL}/read`)).status).toBe(403);
    expect((await agent.post(`/api/submissions/${NIL}/read`).set('X-Requested-With', 'fetch')).status).toBe(404);
    // Bearer requests need no CSRF header.
    expect((await request(app).post(`/api/submissions/${NIL}/read`).set(bearer(u.token))).status).toBe(404);

    expect((await agent.post('/api/auth/logout')).status).toBe(403); // a cross-site sign-out is refused too
    const out = await agent.post('/api/auth/logout').set('X-Requested-With', 'fetch');
    expect(out.status).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/ims_session=;.*Expires=Thu, 01 Jan 1970/i);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    // Signing out revokes every token of that user, the script token from the login response included.
    expect((await request(app).get('/api/auth/me').set(bearer(script.body.token))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(401);
    // A stale cookie can still be cleared.
    expect(
      (
        await request(app)
          .post('/api/auth/logout')
          .set('Cookie', `ims_session=${cookieToken}`)
          .set('X-Requested-With', 'fetch')
      ).status,
    ).toBe(204);
  });

  it('rejects a disabled user and their tokens, and enabling does not revive old tokens', async () => {
    const u = await makeUser('disabled@example.com', 'UNDERWRITER');
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(200);
    const off = await request(app).patch(`/api/users/${u.id}`).set(bearer(token)).send({ disabled: true });
    expect(off.status).toBe(200);
    expect(off.body.disabledAt).toEqual(expect.any(String));
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(401);
    // Even a token with the current version is refused while disabled.
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set(bearer(await freshToken(u.id)))
      ).status,
    ).toBe(401);
    const login = await request(app).post('/api/auth/login').set(CLI).send({ email: 'disabled@example.com', password });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_DISABLED');

    expect(
      (await request(app).patch(`/api/users/${u.id}`).set(bearer(token)).send({ disabled: false })).body.disabledAt,
    ).toBeNull();
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set(bearer(await freshToken(u.id)))
      ).status,
    ).toBe(200);
    const { rows } = await pool.query('SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY id', [u.id]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['USER_DISABLED', 'USER_ENABLED']));
  });

  it('revokes old tokens on a role change, and shows non-admins only names', async () => {
    const u = await makeUser('demoted@example.com', 'UNDERWRITER');
    const res = await request(app).patch(`/api/users/${u.id}`).set(bearer(token)).send({ role: 'VIEWER' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('VIEWER');
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(401);
    const viewer = bearer(await freshToken(u.id));
    expect((await request(app).get('/api/auth/me').set(viewer)).body.role).toBe('VIEWER');
    expect((await request(app).patch(`/api/users/${u.id}`).set(viewer).send({ role: 'ADMIN' })).status).toBe(403);

    const list = (await request(app).get('/api/users').set(viewer)).body;
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) expect(Object.keys(entry).sort()).toEqual(['id', 'name', 'role']);
    const full = (await request(app).get('/api/users').set(bearer(token))).body;
    expect(full.find((x: { id: string }) => x.id === u.id)).toMatchObject({
      email: 'demoted@example.com',
      disabledAt: null,
    });
  });

  it('protects the default admin and refuses self-disable', async () => {
    const {
      rows: [admin],
    } = await pool.query(`SELECT id FROM users WHERE email='admin@example.com'`);
    const demote = await request(app).patch(`/api/users/${admin.id}`).set(bearer(token)).send({ role: 'UNDERWRITER' });
    expect(demote.status).toBe(403);
    expect(demote.body.error.code).toBe('DEFAULT_ADMIN_PROTECTED');
    expect(
      (await request(app).patch(`/api/users/${admin.id}`).set(bearer(token)).send({ disabled: true })).status,
    ).toBe(400);
    // Another admin cannot change it either: not its role, status or password.
    const other = await makeUser('admin2@example.com', 'ADMIN');
    for (const body of [{ role: 'VIEWER' }, { disabled: true }]) {
      expect(
        (await request(app).patch(`/api/users/${admin.id}`).set(bearer(other.token)).send(body)).body.error.code,
      ).toBe('DEFAULT_ADMIN_PROTECTED');
    }
    expect(
      (
        await request(app)
          .post(`/api/users/${admin.id}/password`)
          .set(bearer(other.token))
          .send({ password: 'taken-over-123' })
      ).status,
    ).toBe(403);
    const list = (await request(app).get('/api/users').set(bearer(other.token))).body as {
      id: string;
      isDefaultAdmin: boolean;
    }[];
    expect(list.filter((u) => u.isDefaultAdmin).map((u) => u.id)).toEqual([admin.id]);
    // Other admins can still be demoted.
    expect(
      (await request(app).patch(`/api/users/${other.id}`).set(bearer(token)).send({ role: 'VIEWER' })).status,
    ).toBe(200);
    expect((await request(app).get('/api/auth/me').set(bearer(token))).status).toBe(200);
  });

  it('lets an admin reset a password and a user change their own, revoking old tokens', async () => {
    const u = await makeUser('pw@example.com', 'UNDERWRITER');
    expect(
      (await request(app).post(`/api/users/${u.id}/password`).set(bearer(token)).send({ password: 'short' })).status,
    ).toBe(400);
    expect(
      (await request(app).post(`/api/users/${u.id}/password`).set(bearer(token)).send({ password: 'reset-by-admin-1' }))
        .status,
    ).toBe(200);
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(401);

    const current = bearer(await freshToken(u.id));
    const wrong = await request(app)
      .post('/api/auth/password')
      .set(CLI)
      .set(current)
      .send({ currentPassword: password, newPassword: 'my-own-password-2' });
    expect(wrong.status).toBe(400);
    const changed = await request(app)
      .post('/api/auth/password')
      .set(CLI)
      .set(current)
      .send({ currentPassword: 'reset-by-admin-1', newPassword: 'my-own-password-2' });
    expect(changed.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(current)).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(bearer(changed.body.token))).status).toBe(200);
    const { rows } = await pool.query('SELECT action FROM audit_events WHERE entity_id=$1', [u.id]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['USER_PASSWORD_RESET', 'USER_PASSWORD_CHANGED']));
  });

  it('checks the Gmail push token', async () => {
    const { config } = await import('../src/config.js');
    const saved = config.GMAIL_PUSH_TOKEN;
    try {
      expect((await request(app).post('/api/gmail/push?token=anything')).status).toBe(403);
      config.GMAIL_PUSH_TOKEN = 'push-secret-value';
      expect((await request(app).post('/api/gmail/push?token=push-secret-valu')).status).toBe(403);
      expect((await request(app).post('/api/gmail/push')).status).toBe(403);
      expect((await request(app).post('/api/gmail/push?token=push-secret-value')).status).toBe(204);
    } finally {
      config.GMAIL_PUSH_TOKEN = saved;
    }
  });
});

describe('request hardening', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const detail = async (id: string) => (await request(app).get(`/api/submissions/${id}`).set(auth())).body;
  const settled = (id: string) =>
    waitFor(
      () => detail(id),
      (b) => !['NEW', 'PROCESSING'].includes(b.status),
    );
  const upload = (subject: string, body: string) =>
    request(app)
      .post('/api/submissions/upload')
      .set(auth())
      .field('subject', subject)
      .field('fromAddress', 'broker@hardening.com')
      .field('bodyText', body)
      .attach('files', Buffer.from(`Applicant: ${subject}\nNPI 1234567893\nState: TX`), 'application.txt');

  it('answers malformed JSON and bad uploads with a 4xx in the usual error shape', async () => {
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email": ');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({
      error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON', requestId: expect.any(String) },
    });
    const big = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'x'.repeat(1_100_000) }));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    let many = request(app)
      .post('/api/submissions/upload')
      .set(auth())
      .field('subject', 'Too many files')
      .field('fromAddress', 'a@b.com');
    for (let i = 0; i < 21; i++) many = many.attach('files', Buffer.from(`file ${i}`), `f${i}.txt`);
    const tooMany = await many;
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('TOO_MANY_FILES');
    const wrongField = await request(app)
      .post('/api/submissions/upload')
      .set(auth())
      .field('subject', 'Wrong field')
      .field('fromAddress', 'a@b.com')
      .attach('attachment', Buffer.from('x'), 'x.txt');
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.error).toMatchObject({ code: 'UNEXPECTED_FILE_FIELD', details: { field: 'attachment' } });
  });

  it('redirects a cancelled or malformed Gmail sign-in back to Settings, and binds it to the starting browser', async () => {
    const errorPage = /\/settings\?gmail=error&popup=1$/;
    const cancelled = await request(app).get('/api/gmail/oauth/callback?error=access_denied&state=abc');
    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.location).toMatch(errorPage);
    const noCode = await request(app).get('/api/gmail/oauth/callback');
    expect(noCode.status).toBe(302);
    expect(noCode.headers.location).toMatch(errorPage);

    const start = await request(app).get('/api/gmail/auth-url').set(auth());
    expect(start.status).toBe(200);
    const cookie = String(start.headers['set-cookie']);
    expect(cookie).toMatch(/ims_gmail_oauth=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // A state from another browser's sign-in (no cookie) is refused before Google is asked for a token.
    const state = new URL(start.body.url).searchParams.get('state')!;
    const foreign = await request(app).get(`/api/gmail/oauth/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(foreign.headers.location).toMatch(errorPage);
  });

  it('assigns work only to active users', async () => {
    const {
      rows: [{ id: subId }],
    } = await pool.query('SELECT id FROM submissions WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1');
    const {
      rows: [u],
    } = await pool.query(
      `INSERT INTO users (email, name, password_hash, role, disabled_at) VALUES ('gone@example.com', 'Gone', 'x', 'UNDERWRITER', now()) RETURNING id`,
    );
    const res = await request(app).patch(`/api/submissions/${subId}`).set(auth()).send({ assignedToId: u.id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Unknown or disabled user');
  });

  it('refuses a classification override while the email is still being processed', async () => {
    const id = (
      await upload(
        'Hardening classification Dr. Rao malpractice submission',
        'Please quote Dr. Rao. Application attached. Effective 2027-02-01.',
      )
    ).body.id;
    const before = await settled(id);
    await pool.query(`UPDATE submissions SET status='PROCESSING' WHERE id=$1`, [id]);
    try {
      const res = await request(app)
        .post(`/api/submissions/${id}/classification`)
        .set(auth())
        .send({ classification: 'NOT_SUBMISSION', reason: 'test' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('STILL_PROCESSING');
    } finally {
      await pool.query('UPDATE submissions SET status=$2 WHERE id=$1', [id, before.status]);
    }
  });

  it('404s every change to a deleted submission', async () => {
    const id = (
      await upload(
        'Hardening deleted Dr. Okafor malpractice submission',
        'Please quote Dr. Okafor. Application attached. Effective 2027-03-01.',
      )
    ).body.id;
    const live = (
      await upload(
        'Hardening live Dr. Mendes malpractice submission',
        'Please quote Dr. Mendes, new account. Effective 2027-04-01.',
      )
    ).body.id;
    await Promise.all([settled(id), settled(live)]);
    const added = await request(app)
      .post(`/api/submissions/${id}/fields`)
      .set(auth())
      .send({ fields: [{ fieldName: 'specialty', value: 'Cardiology' }] });
    expect(added.status).toBe(201);
    const fieldId = added.body.manualFields[0].id;
    const {
      rows: [npi],
    } = await pool.query('SELECT id FROM npi_verifications WHERE submission_id=$1 LIMIT 1', [id]);
    await pool.query('UPDATE submissions SET deleted_at=now() WHERE id=$1', [id]);

    expect(
      (await request(app).patch(`/api/submissions/${id}/fields/${fieldId}`).set(auth()).send({ value: 'x' })).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/submissions/${id}/fields/${fieldId}`).set(auth())).status).toBe(404);
    if (npi) {
      expect(
        (
          await request(app)
            .put(`/api/submissions/${id}/npi/${npi.id}/override`)
            .set(auth())
            .send({ status: 'MATCH', note: 'x' })
        ).status,
      ).toBe(404);
      expect((await request(app).delete(`/api/submissions/${id}/npi/${npi.id}/override`).set(auth())).status).toBe(404);
      expect((await request(app).delete(`/api/submissions/${id}/npi/${npi.id}`).set(auth())).status).toBe(404);
    }
    expect(
      (
        await request(app)
          .post(`/api/submissions/${id}/external-report`)
          .set(auth())
          .send({ kind: 'SYNTHESIS', content: {} })
      ).status,
    ).toBe(404);
    const mark = await request(app)
      .post(`/api/submissions/${live}/duplicate`)
      .set(auth())
      .send({ duplicateOfId: id, reason: 'Same account' });
    expect(mark.status).toBe(404);
    expect((await detail(live)).status).not.toBe('DUPLICATE');
  });
});

describe('Limits & timeouts settings', () => {
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const DEFAULTS = {
    synthesisMaxTokens: 32000,
    analysisMaxTokens: 32000,
    comparisonMaxTokens: 32000,
    classificationMaxTokens: 16000,
    extractionMaxTokens: 64000,
    chatMaxTokens: 16000,
    emailDraftMaxTokens: 16000,
    autoQuoteMaxTokens: 16000,
    claudeResponseTimeoutMinutes: 15,
    uploadMaxFileMb: 25,
    uploadMaxFiles: 20,
    rateWorkbookMaxMb: 20,
    npiTimeoutSeconds: 15,
    driveTimeoutSeconds: 120,
    gmailTimeoutSeconds: 60,
    connectionTestTimeoutSeconds: 25,
    ocrMaxPages: 10,
    reportPerDocChars: 80000,
    extractionPerDocChars: 60000,
    classificationBodyChars: 8000,
  };
  const reset = async () => {
    await pool.query(`DELETE FROM app_settings WHERE key='limits_settings'`);
    await (await import('../src/services/limitsSettings.js')).refreshLimitsSettings();
  };

  it('shows the defaults and bounds to any signed-in user, and lets only admins change them', async () => {
    await reset();
    const { signToken } = await import('../src/http.js');
    await pool.query(
      "INSERT INTO users (id, email, name, password_hash, role) VALUES ('00000000-0000-4000-8000-000000000001', 'viewer@example.com', 'Vic Viewer', 'x', 'VIEWER') ON CONFLICT DO NOTHING",
    );
    const viewer = {
      Authorization: `Bearer ${signToken({ id: '00000000-0000-4000-8000-000000000001', email: 'viewer@example.com', name: 'Vic Viewer', role: 'VIEWER' })}`,
    };
    const got = await request(app).get('/api/settings/limits').set(viewer);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ values: DEFAULTS, defaults: DEFAULTS, updatedAt: null, updatedBy: null });
    expect(Object.keys(got.body.bounds)).toEqual(Object.keys(DEFAULTS));
    expect(got.body.bounds.uploadMaxFileMb).toEqual({ min: 1, max: 100 });
    expect(got.body.bounds.reportPerDocChars).toEqual({ min: 10_000, max: 400_000 });
    expect(got.body.bounds.extractionPerDocChars).toEqual({ min: 10_000, max: 400_000 });
    expect(got.body.bounds.classificationBodyChars).toEqual({ min: 1000, max: 50_000 });
    expect(got.body.fixed).toEqual({ outboundAttachmentMaxBytes: 18 * 1024 * 1024 });
    expect(got.body.bounds.claudeResponseTimeoutMinutes).toEqual({ min: 5, max: 60 });
    expect(got.body.bounds.gmailTimeoutSeconds).toEqual({ min: 10, max: 300 });
    for (const k of ['synthesisMaxTokens', 'analysisMaxTokens', 'comparisonMaxTokens'])
      expect(got.body.bounds[k]).toEqual({ min: 20_000, max: 64_000 });
    expect(Object.keys(got.body.values)).toHaveLength(20);
    expect((await request(app).get('/api/settings/limits')).status).toBe(401);
    expect((await request(app).put('/api/settings/limits').set(viewer).send({ uploadMaxFiles: 5 })).status).toBe(403);
  });

  it('saves overrides, resets them with null, audits the changes and rejects invalid values', async () => {
    await reset();
    const { limits } = await import('../src/services/limitsSettings.js');
    try {
      // The new keys accept their bounds.
      const edges = await request(app)
        .put('/api/settings/limits')
        .set(as(token))
        .send({ claudeResponseTimeoutMinutes: 60, gmailTimeoutSeconds: 10 });
      expect(edges.body.values).toMatchObject({ claudeResponseTimeoutMinutes: 60, gmailTimeoutSeconds: 10 });
      await reset();
      const saved = await request(app)
        .put('/api/settings/limits')
        .set(as(token))
        .send({ uploadMaxFiles: 5, npiTimeoutSeconds: 30 });
      expect(saved.status).toBe(200);
      expect(saved.body.values).toEqual({ ...DEFAULTS, uploadMaxFiles: 5, npiTimeoutSeconds: 30 });
      expect(saved.body.defaults).toEqual(DEFAULTS);
      expect(saved.body.updatedBy).toBe('Ada Admin');
      expect(new Date(saved.body.updatedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(limits().uploadMaxFiles).toBe(5);
      expect((await pool.query(`SELECT value FROM app_settings WHERE key='limits_settings'`)).rows[0].value).toEqual({
        uploadMaxFiles: 5,
        npiTimeoutSeconds: 30,
      });
      const {
        rows: [ev],
      } = await pool.query(
        `SELECT entity_type, details FROM audit_events WHERE action='LIMITS_SETTINGS_UPDATED' ORDER BY id DESC LIMIT 1`,
      );
      expect(ev).toEqual({
        entity_type: 'settings',
        details: { changed: { uploadMaxFiles: { from: 20, to: 5 }, npiTimeoutSeconds: { from: 15, to: 30 } } },
      });

      // null resets one key; the others are kept.
      const cleared = await request(app).put('/api/settings/limits').set(as(token)).send({ uploadMaxFiles: null });
      expect(cleared.body.values).toEqual({ ...DEFAULTS, npiTimeoutSeconds: 30 });

      const bad = [
        { uploadMaxFiles: 51 },
        { npiTimeoutSeconds: 4 },
        { synthesisMaxTokens: 19_999 },
        { analysisMaxTokens: 64_001 },
        { comparisonMaxTokens: 25_000.5 },
        { ocrMaxPages: 2.5 },
        { chatMaxTokens: '16000' },
        { reportPerDocChars: 400_001 },
        { claudeResponseTimeoutMinutes: 4 },
        { claudeResponseTimeoutMinutes: 61 },
        { gmailTimeoutSeconds: 9 },
        { gmailTimeoutSeconds: 301 },
        { somethingElse: 1 },
        // The retry limits are gone: unknown keys like any other.
        { classificationRetryMaxTokens: 16_000 },
        { extractionRetryMaxTokens: 64_000 },
      ];
      for (const body of bad) {
        const res = await request(app).put('/api/settings/limits').set(as(token)).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      // No cross-field rules: any first-call limit in range is accepted on its own.
      expect(
        (
          await request(app)
            .put('/api/settings/limits')
            .set(as(token))
            .send({ classificationMaxTokens: 1000, extractionMaxTokens: 8000 })
        ).status,
      ).toBe(200);
      expect(limits()).toEqual({
        ...DEFAULTS,
        npiTimeoutSeconds: 30,
        classificationMaxTokens: 1000,
        extractionMaxTokens: 8000,
      });
    } finally {
      await reset();
    }
  });

  it('falls back to the defaults for bad saved data', async () => {
    const settings = await import('../src/services/limitsSettings.js');
    try {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('limits_settings', '"garbage"') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      );
      await settings.refreshLimitsSettings();
      expect(settings.limits()).toEqual(DEFAULTS);
      await pool.query(
        `UPDATE app_settings SET value='{"uploadMaxFiles": 9999, "chatMaxTokens": "x", "unknown": 1, "ocrMaxPages": 3, "classificationMaxTokens": 30000, "classificationRetryMaxTokens": 40000, "extractionRetryMaxTokens": 64000}' WHERE key='limits_settings'`,
      );
      await settings.startLimitsSettings();
      // Out-of-range and mistyped values use the default; unknown keys (the removed retry limits too) are ignored.
      expect(settings.limits()).toEqual({ ...DEFAULTS, ocrMaxPages: 3, classificationMaxTokens: 30_000 });
    } finally {
      settings.stopLimitsSettingsSync();
      await reset();
    }
  });

  it('enforces the configured upload limits with a message naming them', async () => {
    try {
      await request(app)
        .put('/api/settings/limits')
        .set(as(token))
        .send({ uploadMaxFileMb: 1, uploadMaxFiles: 2, rateWorkbookMaxMb: 1 });
      const big = Buffer.alloc(1024 * 1024 + 10, 'a');
      const tooLarge = await request(app)
        .post('/api/submissions/upload')
        .set(as(token))
        .field('subject', 'Too large')
        .field('fromAddress', 'broker@limits.test')
        .attach('files', big, 'big.txt');
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body.error).toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Each file can be at most 1 MB',
      });

      let tooMany = request(app)
        .post('/api/submissions/upload')
        .set(as(token))
        .field('subject', 'Too many')
        .field('fromAddress', 'broker@limits.test');
      for (const n of [1, 2, 3]) tooMany = tooMany.attach('files', Buffer.from(`file ${n}`), `f${n}.txt`);
      const many = await tooMany;
      expect(many.status).toBe(400);
      expect(many.body.error).toMatchObject({ code: 'TOO_MANY_FILES', message: 'At most 2 files per upload' });

      const workbook = await request(app)
        .post('/api/rates/import/State_Lookup')
        .set(as(token))
        .attach('file', big, 'rates.xlsx');
      expect(workbook.status).toBe(413);
      expect(workbook.body.error.message).toBe('Each file can be at most 1 MB');
    } finally {
      await reset();
    }
  });

  it('passes the configured output limit to Claude', async () => {
    const { extractFields } = await import('../src/services/fieldExtraction.js');
    try {
      await request(app).put('/api/settings/limits').set(as(token)).send({ extractionMaxTokens: 20_000 });
      llmCalls.length = 0;
      await extractFields([{ documentId: null, label: 'email body', text: 'Applicant: Jane Smith', ocrUsed: false }]);
      expect(llmCalls).toEqual([{ task: 'extraction', maxTokens: 20_000 }]);
    } finally {
      await reset();
    }
  });
});
