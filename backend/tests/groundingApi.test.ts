/**
 * Report and chat grounding through the API (services/grounding.ts wired into services/reports.ts and chat.ts):
 * the stored grade is returned as `grounding` on reports and chat messages. Claude, the NPI registry and Drive are
 * mocked; the pipeline, jobs and database are real.
 */
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
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

const DB_NAME = 'ims_test_grounding';
process.env.DATABASE_URL = testDatabaseUrl(DB_NAME);

/** What the mocked chat answers next. */
const chatAnswer = vi.hoisted(() => ({ text: '' }));
vi.mock('../src/services/claude.js', async () => {
  const { SynthesisSchema, AnalysisSchema } = await import('../src/services/reportSchemas.js');
  const usage = { inputTokens: 1, outputTokens: 1 };
  return {
    claudeAvailable: () => true,
    claudeModel: () => 'mock-model',
    chatCall: async () => ({ text: chatAnswer.text, usage, model: 'mock-model' }),
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
            extractedFacts: [
              // Neither the file nor the amount is in the submission.
              { text: 'Paid $999,999', source: 'loss_runs.pdf', confidence: 'HIGH' },
              // In the fixture email.
              { text: 'Effective date 2027-01-01', source: 'email body', confidence: 'HIGH' },
            ],
            npiVerificationSummary: 'none',
            conflicts: [],
            missingInformation: [],
            dataConfidence: { overall: 'MEDIUM', notes: '' },
            consolidatedContextForLlm: 'brief',
          },
        };
      if (schema === AnalysisSchema)
        return {
          model: 'mock-model',
          usage,
          data: {
            executiveSummary: 'OK.',
            overallRisk: 'LOW',
            recommendation: 'PROCEED',
            riskIndicators: [
              {
                title: 'Limits',
                detail: 'Standard limits.',
                severity: 'LOW',
                confidence: 'HIGH',
                // Found in the email, and only in the Synthesis it was based on.
                evidence: ['Effective date 2027-01-01 (email body)', 'Synthesis: Paid $999,999'],
              },
            ],
            applicationCompleteness: { score: 90, summary: '', gaps: [] },
            inconsistencies: [],
            potentialConcerns: [],
            missingInformation: [],
            followUpQuestions: [],
            recommendedNextSteps: [],
            limitationsAndUncertainties: [],
          },
        };
      return { model: 'mock-model', usage, data: { fields: [] } };
    },
  };
});

let app: Express;
let pool: pg.Pool;
let auth: { Authorization: string };
let submissionId = '';

beforeAll(async () => {
  ({ app, pool } = await startTestApp(DB_NAME));
  auth = await registerAdmin(app);
  const sub = await uploadAndProcess(app, auth, {
    subject: 'Quote request - Dr. Jane Smith',
    bodyText: 'Please quote. Effective date 2027-01-01. Limits 1M/3M.',
    attachment: { name: 'application.txt', text: 'Applicant: Jane Smith\nState: TX' },
  });
  expect(sub.status).toBe('READY_FOR_REVIEW');
  submissionId = sub.id;
});

afterAll(async () => {
  if (pool) await stopTestApp();
});

const completed = (id: string) =>
  waitFor(
    async () => (await request(app).get(`/api/reports/${id}`).set(auth)).body,
    (r) => r.status === 'COMPLETED' || r.status === 'FAILED',
  );

describe('report grounding', () => {
  let synthesisId = '';

  it('marks a Synthesis fact citing a missing file with an unknown amount as unverified', async () => {
    const start = await request(app).post(`/api/submissions/${submissionId}/synthesis`).set(auth).send({});
    expect(start.status).toBe(202);
    synthesisId = start.body.id;
    const report = await completed(synthesisId);
    expect(report.status).toBe('COMPLETED');
    expect(report.grounding).toMatchObject({ checked: 2, verified: 1, unverified: 1 });
    expect(report.grounding.items).toHaveLength(1);
    expect(report.grounding.items[0]).toMatchObject({
      path: 'extractedFacts[0]',
      verdict: 'unverified',
      missing: ['source: loss_runs.pdf'],
    });
  });

  it('accepts values an Analysis took from the Synthesis it was based on', async () => {
    const start = await request(app)
      .post(`/api/submissions/${submissionId}/analysis`)
      .set(auth)
      .send({ synthesisReportId: synthesisId });
    expect(start.status).toBe(202);
    const report = await completed(start.body.id);
    expect(report.status).toBe('COMPLETED');
    expect(report.grounding).toMatchObject({ checked: 2, verified: 2, unverified: 0, items: [] });
  });

  it('grades an external report the same way', async () => {
    const synthesis = (await request(app).get(`/api/reports/${synthesisId}`).set(auth)).body.content;
    const res = await request(app)
      .post(`/api/submissions/${submissionId}/external-report`)
      .set(auth)
      .send({ kind: 'SYNTHESIS', content: synthesis });
    expect(res.status).toBe(201);
    const report = (await request(app).get(`/api/reports/${res.body.id}`).set(auth)).body;
    expect(report.grounding).toMatchObject({ checked: 2, unverified: 1 });
  });
});

describe('chat grounding', () => {
  const ask = async (question: string, answer: string) => {
    chatAnswer.text = answer;
    const res = await request(app).post(`/api/submissions/${submissionId}/chat`).set(auth).send({ message: question });
    expect(res.status).toBe(202);
    const answerId = res.body[1].id;
    const items = await waitFor(
      async () => (await request(app).get(`/api/submissions/${submissionId}/chat`).set(auth)).body.items,
      (ms: { id: string; status: string }[]) => ms.find((m) => m.id === answerId)?.status !== 'PENDING',
    );
    return items.find((m: { id: string }) => m.id === answerId);
  };

  it('reports values in an answer that are not in the evidence', async () => {
    const msg = await ask('Any losses?', 'The policy paid $888,777 in 2020.');
    expect(msg.status).toBe('COMPLETED');
    expect(msg.grounding.unverified).toBeGreaterThanOrEqual(1);
    expect(msg.grounding.items[0].missing).toContain('888777');
  });

  it('checks nothing in an answer with no concrete values', async () => {
    const msg = await ask('Who is the applicant?', 'The applicant is Jane Smith, an OB/GYN in Texas.');
    expect(msg.grounding).toMatchObject({ checked: 0, unverified: 0, items: [] });
  });

  it('gives questions no grounding', async () => {
    const items = (await request(app).get(`/api/submissions/${submissionId}/chat`).set(auth)).body.items;
    expect(
      items
        .filter((m: { role: string }) => m.role === 'user')
        .every((m: { grounding: unknown }) => m.grounding === null),
    ).toBe(true);
  });
});
