/**
 * Review of automatic output: reports and quotes made with no person behind them (created_by NULL) "need review"
 * until someone acknowledges them, or records an assessment on the submission. Claude, the NPI registry and Drive are
 * mocked; the pipeline, jobs, rating and database are real.
 */
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  makeUser,
  registerAdmin,
  startTestApp,
  stopTestApp,
  testDatabaseUrl,
  uploadAndProcess,
  waitFor,
} from './helpers/apiTestDb.js';

vi.mock('../src/services/driveStorage.js', async (orig) =>
  (await import('./helpers/fakeDrive.js')).fakeDrive(await orig()),
);

const DB_NAME = 'ims_test_review';
process.env.DATABASE_URL = testDatabaseUrl(DB_NAME);

vi.mock('../src/services/claude.js', async () => {
  const { SynthesisSchema } = await import('../src/services/reportSchemas.js');
  const usage = { inputTokens: 1, outputTokens: 1 };
  return {
    claudeAvailable: () => true,
    claudeModel: () => 'mock-model',
    chatCall: async () => ({ text: '', usage, model: 'mock-model' }),
    structuredCall: async ({ schema, task }: { schema: unknown; task?: string }) => {
      if (task === 'classification')
        return {
          model: 'mock-model',
          usage,
          data: { classification: 'SUBMISSION', confidence: 0.9, reasons: ['quote'] },
        };
      if (schema === SynthesisSchema)
        return {
          model: 'mock-model',
          usage,
          data: {
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
          },
        };
      return { model: 'mock-model', usage, data: { fields: [] } };
    },
  };
});

let app: Express;
let pool: pg.Pool;
let admin: { Authorization: string };

beforeAll(async () => {
  ({ app, pool } = await startTestApp(DB_NAME));
  await (await import('../src/services/rating/importer.js')).importRates('data/rates');
  admin = await registerAdmin(app);
});

afterAll(async () => {
  if (pool) await stopTestApp();
});

/** A processed submission with one automatic (created_by NULL) Synthesis and one automatic quote. */
async function submissionWithAutomaticOutput(subject: string) {
  const sub = await uploadAndProcess(app, admin, {
    subject,
    // Distinct text per submission, or the next one is a duplicate of the last.
    bodyText: `Please quote (${subject}). Effective date 2027-01-01. Limits 1M/3M. Texas OB/GYN, 40 hours a week.`,
    attachment: { name: 'application.txt', text: `Applicant: Jane Smith\nState: TX\nRef: ${subject}` },
  });
  const { startReport } = await import('../src/services/reports.js');
  const reportId = await startReport(sub.id, 'SYNTHESIS', null);
  const report = await waitFor(
    async () => (await request(app).get(`/api/reports/${reportId}`).set(admin)).body,
    (r) => r.status === 'COMPLETED' || r.status === 'FAILED',
  );
  expect(report.status).toBe('COMPLETED');
  const { createQuote } = await import('../src/services/rating/quote.js');
  const { deriveRatingInputs } = await import('../src/services/rating/inputs.js');
  const { inputs } = await deriveRatingInputs(sub.id);
  const quoteId = await createQuote(sub.id, { ...inputs, label: 'Automatic quote' }, null);
  return { id: sub.id, reportId, quoteId };
}

const quoteOf = async (submissionId: string, quoteId: string) =>
  ((await request(app).get(`/api/submissions/${submissionId}/quotes`).set(admin)).body as { id: string }[]).find(
    (q) => q.id === quoteId,
  ) as { needsReview: boolean; reviewedAt: string | null; reviewedBy: string | null } | undefined;

const auditActions = async (submissionId: string, action: string) =>
  (
    await pool.query('SELECT entity_id, actor_id FROM audit_events WHERE submission_id=$1 AND action=$2 ORDER BY id', [
      submissionId,
      action,
    ])
  ).rows as { entity_id: string; actor_id: string | null }[];

describe('reviewing automatic reports', () => {
  let sub: { id: string; reportId: string; quoteId: string };

  beforeAll(async () => {
    sub = await submissionWithAutomaticOutput('Quote request - review report');
  });

  it('marks an automatic report as needing review', async () => {
    const report = (await request(app).get(`/api/reports/${sub.reportId}`).set(admin)).body;
    expect(report).toMatchObject({ needsReview: true, reviewedAt: null, reviewedBy: null });
    const detail = (await request(app).get(`/api/submissions/${sub.id}`).set(admin)).body;
    expect(detail.latestSynthesis).toMatchObject({ needsReview: true });
  });

  it('forbids a viewer from reviewing', async () => {
    const viewer = await makeUser(pool, 'viewer@example.com', 'VIEWER');
    const res = await request(app).post(`/api/submissions/${sub.id}/reports/${sub.reportId}/review`).set(viewer.auth);
    expect(res.status).toBe(403);
  });

  it('404s a report reviewed under another submission', async () => {
    const other = await uploadAndProcess(app, admin, { subject: 'Another', bodyText: 'Please quote another one.' });
    const res = await request(app).post(`/api/submissions/${other.id}/reports/${sub.reportId}/review`).set(admin);
    expect(res.status).toBe(404);
  });

  it('records the review once and keeps the first reviewer', async () => {
    const first = await request(app).post(`/api/submissions/${sub.id}/reports/${sub.reportId}/review`).set(admin);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: sub.reportId, needsReview: false, reviewedBy: 'Ada Admin' });
    expect(first.body.reviewedAt).toEqual(expect.any(String));

    const uw = await makeUser(pool, 'uw@example.com', 'UNDERWRITER');
    const second = await request(app).post(`/api/submissions/${sub.id}/reports/${sub.reportId}/review`).set(uw.auth);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      needsReview: false,
      reviewedBy: 'Ada Admin',
      reviewedAt: first.body.reviewedAt,
    });
    expect(await auditActions(sub.id, 'REPORT_REVIEWED')).toHaveLength(1);
  });

  it('never asks for review of a report a person started', async () => {
    const res = await request(app).post(`/api/submissions/${sub.id}/synthesis`).set(admin).send({ force: true });
    expect(res.status).toBe(202);
    expect(res.body.needsReview).toBe(false);
    const done = await waitFor(
      async () => (await request(app).get(`/api/reports/${res.body.id}`).set(admin)).body,
      (r) => r.status === 'COMPLETED',
    );
    expect(done.needsReview).toBe(false);
  });
});

describe('reviewing automatic quotes', () => {
  let sub: { id: string; reportId: string; quoteId: string };

  beforeAll(async () => {
    sub = await submissionWithAutomaticOutput('Quote request - review quote');
  });

  it('marks an automatic quote as needing review until someone reviews it', async () => {
    expect(await quoteOf(sub.id, sub.quoteId)).toMatchObject({ needsReview: true, reviewedBy: null });
    const res = await request(app).post(`/api/submissions/${sub.id}/quotes/${sub.quoteId}/review`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: sub.quoteId, needsReview: false, reviewedBy: 'Ada Admin' });
    expect(await auditActions(sub.id, 'QUOTE_REVIEWED')).toHaveLength(1);
  });

  it('404s an unknown quote', async () => {
    const res = await request(app)
      .post(`/api/submissions/${sub.id}/quotes/00000000-0000-4000-8000-000000000000/review`)
      .set(admin);
    expect(res.status).toBe(404);
  });
});

describe('recording an assessment', () => {
  it('marks the automatic reports and quotes reviewed by the assessor', async () => {
    const sub = await submissionWithAutomaticOutput('Quote request - assessment');
    const listed = async () =>
      (
        (await request(app).get('/api/submissions').query({ q: 'Quote request - assessment' }).set(admin)).body
          .items as { id: string; needsReview: boolean }[]
      ).find((i) => i.id === sub.id);
    expect(await listed()).toMatchObject({ needsReview: true });
    // An automatic report still running has nothing to review yet: the decision leaves it alone.
    const running = await insertRunningAutomaticReport(sub.id);
    const uw = await makeUser(pool, 'assessor@example.com', 'UNDERWRITER');
    const res = await request(app)
      .post(`/api/submissions/${sub.id}/assessments`)
      .set(uw.auth)
      .send({ decision: 'REFER', riskRating: 'MODERATE', notes: 'Refer to senior.' });
    expect(res.status).toBe(201);

    const report = (await request(app).get(`/api/reports/${sub.reportId}`).set(admin)).body;
    expect(report).toMatchObject({ needsReview: false, reviewedBy: uw.name });
    expect(await quoteOf(sub.id, sub.quoteId)).toMatchObject({ needsReview: false, reviewedBy: uw.name });
    const reviewed = await auditActions(sub.id, 'REPORT_REVIEWED');
    expect(reviewed).toEqual([{ entity_id: sub.reportId, actor_id: uw.id }]);
    expect(await listed()).toMatchObject({ needsReview: false });
    const stillRunning = (await request(app).get(`/api/reports/${running}`).set(admin)).body;
    expect(stillRunning).toMatchObject({ status: 'RUNNING', needsReview: true, reviewedBy: null });
  });
});

describe('reviewing a report that has not completed', () => {
  it('refuses with 409 and leaves it unreviewed', async () => {
    const sub = await submissionWithAutomaticOutput('Quote request - running report');
    const running = await insertRunningAutomaticReport(sub.id);
    const res = await request(app).post(`/api/submissions/${sub.id}/reports/${running}/review`).set(admin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REPORT_NOT_COMPLETED');
    const report = (await request(app).get(`/api/reports/${running}`).set(admin)).body;
    expect(report).toMatchObject({ needsReview: true, reviewedAt: null });
    expect((await auditActions(sub.id, 'REPORT_REVIEWED')).map((a) => a.entity_id)).not.toContain(running);
  });
});

/** An automatic (created_by NULL) Analysis row still RUNNING, as the report job leaves it mid-generation. */
async function insertRunningAutomaticReport(submissionId: string): Promise<string> {
  const {
    rows: [r],
  } = await pool.query(
    `INSERT INTO reports (submission_id, kind, version, status, context_version, skill_name, skill_version, model, created_by)
     VALUES ($1, 'ANALYSIS', 99, 'RUNNING', 1, 'underwriting-analysis', 'test', 'mock-model', NULL) RETURNING id`,
    [submissionId],
  );
  return r.id as string;
}
