/**
 * End-to-end check of the zero-click pipeline (AUTO_REPORTS=true): one uploaded email yields
 * classification, stored + extracted documents, fields, coverage, NPI verification, a Synthesis
 * Report, an Underwriting Analysis and a first quote with no further requests. Claude and the NPI registry are mocked.
 */
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Scripts (and these tests) ask for the session token in the login body; browsers get only the cookie.
const CLI = { 'X-Client': 'cli' };

vi.mock('../src/services/driveStorage.js', async (orig) =>
  (await import('./helpers/fakeDrive.js')).fakeDrive(await orig()),
);

const TEST_DB = (process.env.TEST_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_test').replace(
  /\/[^/]+$/,
  '/ims_test_auto',
);
process.env.DATABASE_URL = TEST_DB;
process.env.AUTO_REPORTS = 'true';

const calls: string[] = [];
vi.mock('../src/services/claude.js', async () => {
  const { SynthesisSchema, AnalysisSchema } = await import('../src/services/reportSchemas.js');
  return {
    claudeAvailable: () => true,
    claudeModel: () => 'mock-model',
    chatCall: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 }, model: 'mock-model' }),
    structuredCall: async ({ schema, skill }: { schema: unknown; skill: { name: string } }) => {
      calls.push(skill.name);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (schema === SynthesisSchema) {
        return {
          model: 'mock-model',
          usage,
          data: {
            submissionOverview: 'OB/GYN submission.',
            applicantProfile: {
              name: 'Jane Smith',
              npi: '1234567893',
              specialty: 'OB/GYN',
              state: 'TX',
              practiceName: null,
              yearsInPractice: null,
              other: [],
            },
            emailAndAttachmentInventory: [],
            extractedFacts: [],
            npiVerificationSummary: 'MATCH',
            conflicts: [],
            missingInformation: [],
            dataConfidence: { overall: 'MEDIUM', notes: '' },
            consolidatedContextForLlm: 'brief',
          },
        };
      }
      if (schema === AnalysisSchema) {
        return {
          model: 'mock-model',
          usage,
          data: {
            executiveSummary: 'OK.',
            overallRisk: 'LOW',
            recommendation: 'PROCEED',
            riskIndicators: [],
            applicationCompleteness: { score: 90, summary: '', gaps: [] },
            inconsistencies: [],
            potentialConcerns: [],
            missingInformation: [],
            followUpQuestions: [],
            recommendedNextSteps: [],
            limitationsAndUncertainties: [],
          },
        };
      }
      if (skill.name === 'auto-quote')
        return {
          model: 'mock-haiku',
          usage,
          data: { specialities: [], limit: null, hoursPerWeek: 40, notes: 'Confirm the class.' },
        };
      if (skill.name === 'email-classification')
        return {
          model: 'mock-model',
          usage,
          data: { classification: 'SUBMISSION', confidence: 0.9, reasons: ['quote request'] },
        };
      return {
        model: 'mock-model',
        usage,
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
              fieldName: 'requested_limits',
              value: '$1,000,000 / $3,000,000',
              confidence: 0.9,
              evidenceQuote: 'Limits 1M/3M',
              sourceLabel: 'email body',
            },
          ],
        },
      };
    },
  };
});

vi.mock('../src/services/npi.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/npi.js')>()),
  lookupNpi: async () => ({
    found: true,
    result: {
      enumeration_type: 'NPI-1',
      basic: { first_name: 'JANE', last_name: 'SMITH', status: 'A' },
      taxonomies: [{ primary: true, desc: 'Obstetrics & Gynecology', state: 'TX' }],
      addresses: [],
    },
  }),
}));

let app: import('express').Express;
let pool: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ims_test_auto WITH (FORCE)');
  await admin.query('CREATE DATABASE ims_test_auto');
  await admin.end();
  await (await import('../src/db/migrate.js')).migrate();
  ({ pool } = await import('../src/db/pool.js'));
  await (await import('../src/services/rating/importer.js')).importRates('data/rates');
  app = (await import('../src/app.js')).createApp();
});

afterAll(async () => {
  // Workers and the LISTEN connection first, so nothing touches the pool after it ends.
  await (await import('../src/services/jobQueue.js')).jobs.stop(5000);
  await (await import('../src/services/pgListen.js')).closeListener();
  if (pool) await (await import('../src/db/pool.js')).closePools();
});

describe('zero-click pipeline', () => {
  it('produces fields, NPI, coverage, synthesis, analysis and a quote from one email', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@example.com', password: 'correct-horse-battery', name: 'A' });
    const { token } = (
      await request(app)
        .post('/api/auth/login')
        .set(CLI)
        .send({ email: 'a@example.com', password: 'correct-horse-battery' })
    ).body;
    const auth = { Authorization: `Bearer ${token}` };

    const up = await request(app)
      .post('/api/submissions/upload')
      .set(auth)
      .field('subject', 'Quote request')
      .field('fromAddress', 'broker@acme.com')
      .field('bodyText', 'Please quote. Limits 1M/3M.')
      .attach('files', Buffer.from('Applicant: Jane Smith\nNPI 1234567893'), 'application.txt');
    expect(up.status).toBe(201);

    const end = Date.now() + 20000;
    let d;
    for (;;) {
      d = (await request(app).get(`/api/submissions/${up.body.id}`).set(auth)).body;
      if (
        d.latestAnalysis?.status === 'COMPLETED' ||
        d.status === 'ERROR' ||
        d.latestAnalysis?.status === 'FAILED' ||
        Date.now() > end
      )
        break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(d.processingError).toBeNull();
    expect(d.status).toBe('READY_FOR_REVIEW'); // automatic reports do not claim the review
    expect(d.documents[0].extractionStatus).toBe('EXTRACTED');
    expect(d.extractedFields.length).toBeGreaterThan(0);
    expect(d.npiVerifications[0].status).toBe('MATCH');
    expect(d.coverage).toBeTruthy();
    expect(d.latestSynthesis).toMatchObject({ status: 'COMPLETED', version: 1 });
    expect(d.latestAnalysis).toMatchObject({ status: 'COMPLETED', version: 1 });
    expect(calls).toEqual(expect.arrayContaining(['field-extraction', 'synthesis', 'underwriting-analysis']));

    // The automatic quote follows the Analysis as its own job.
    const { jobs } = await import('../src/services/jobQueue.js');
    await jobs.drain();
    let quotes: { label: string | null; createdBy: unknown; inputs: { hoursPerWeek?: number } }[] = [];
    for (
      const until = Date.now() + 10000;
      !quotes.length && Date.now() < until;
      await new Promise((r) => setTimeout(r, 200))
    ) {
      quotes = (await request(app).get(`/api/submissions/${up.body.id}/quotes`).set(auth)).body;
    }
    expect(calls).toContain('auto-quote');
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ label: 'Automatic quote', createdBy: null });
    expect(quotes[0].inputs.hoursPerWeek).toBe(40);

    // A decided submission reprocessed keeps its status and gets no new automatic reports.
    const { processSubmission } = await import('../src/services/pipeline.js');
    await pool.query(`UPDATE submissions SET status='COMPLETED' WHERE id=$1`, [up.body.id]);
    await processSubmission(up.body.id, null, { skipClassification: true });
    await jobs.drain();
    const {
      rows: [after],
    } = await pool.query('SELECT status FROM submissions WHERE id=$1', [up.body.id]);
    expect(after.status).toBe('COMPLETED');
    const {
      rows: [n],
    } = await pool.query(`SELECT count(*)::int AS n FROM reports WHERE submission_id=$1`, [up.body.id]);
    expect(n.n).toBe(2);

    // A soft-deleted one is not processed at all.
    await pool.query(`UPDATE submissions SET status='ERROR', deleted_at=now() WHERE id=$1`, [up.body.id]);
    await processSubmission(up.body.id, null, { skipClassification: true });
    expect((await pool.query('SELECT status FROM submissions WHERE id=$1', [up.body.id])).rows[0].status).toBe('ERROR');
  });

  it('gives concurrent context-version bumps distinct versions', async () => {
    const { bumpContextVersion } = await import('../src/services/contextVersion.js');
    const {
      rows: [s],
    } = await pool.query(`SELECT id FROM submissions WHERE deleted_at IS NULL LIMIT 1`);
    const id = s?.id ?? (await pool.query(`SELECT id FROM submissions LIMIT 1`)).rows[0].id;
    // Different evidence each time (a changed classification), bumped in parallel: none may collide on the version key.
    const bump = async (c: string) => {
      await pool.query('UPDATE submissions SET classification=$2 WHERE id=$1', [id, c]);
      return bumpContextVersion(id, `test ${c}`, null);
    };
    await expect(
      Promise.all(['SUBMISSION', 'REVIEW_REQUIRED', 'SUBMISSION', 'REVIEW_REQUIRED'].map(bump)),
    ).resolves.toBeDefined();
    const { rows } = await pool.query('SELECT version FROM context_versions WHERE submission_id=$1 ORDER BY version', [
      id,
    ]);
    expect(new Set(rows.map((r) => r.version)).size).toBe(rows.length);
  });
});
