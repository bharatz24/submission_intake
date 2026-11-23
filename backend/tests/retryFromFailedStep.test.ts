/**
 * Retry from the failed step (services/pipeline.ts processLocked, POST /submissions/:id/retry) and plain-English
 * processing errors (services/friendlyError.ts), against a real PostgreSQL database (TEST_DATABASE_URL host,
 * database ims_test_retry). Claude, the NPI registry and Google Drive are mocked; text extraction is real but spied.
 */
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Scripts (and these tests) ask for the session token in the login body; browsers get only the cookie.
const CLI = { 'X-Client': 'cli' };

vi.mock('../src/services/driveStorage.js', async (orig) =>
  (await import('./helpers/fakeDrive.js')).fakeDrive(await orig()),
);

const TEST_DB = (process.env.TEST_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_test').replace(
  /\/[^/]+$/,
  '/ims_test_retry',
);
process.env.DATABASE_URL = TEST_DB;

// Field extraction answers from `fieldFailures` first (each entry thrown once), then succeeds.
const mock = vi.hoisted(() => ({ tasks: [] as string[], fieldFailures: [] as unknown[], read: [] as string[] }));
vi.mock('../src/services/claude.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/claude.js')>()),
  claudeAvailable: () => true,
  claudeModel: () => 'mock-model',
  structuredCall: async ({ task }: { task?: string }) => {
    mock.tasks.push(task ?? '');
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (task === 'classification') {
      return {
        model: 'mock-model',
        usage,
        data: { classification: 'SUBMISSION', confidence: 0.9, reasons: ['Asks for a quote'] },
      };
    }
    if (mock.fieldFailures.length) throw mock.fieldFailures.shift();
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
            sourceLabel: 'a.txt',
          },
        ],
      },
    };
  },
}));
vi.mock('../src/services/npi.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/npi.js')>()),
  lookupNpi: async () => ({ found: false }),
  searchNpi: async () => ({ match: null, candidates: [], reason: 'no match', query: {} }),
}));
vi.mock('../src/services/textExtraction.js', async (orig) => {
  const real = await orig<typeof import('../src/services/textExtraction.js')>();
  return {
    ...real,
    extractText: (data: Buffer, filename: string, mime: string) => {
      mock.read.push(filename);
      return real.extractText(data, filename, mime);
    },
  };
});

const { describeError, describeProcessingError, friendlyText } = await import('../src/services/friendlyError.js');
const { ClaudeTimeoutError, LlmBudgetError, LlmSubmissionBudgetError } = await import('../src/services/llmUsage.js');
const { AppError } = await import('../src/http.js');
const { FAILURE_MESSAGES } = await import('../src/constants.js');
const { StorageError } = await import('../src/services/storage.js');

let app: import('express').Express;
let pool: pg.Pool;
let auth: { Authorization: string };

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout; last value: ${JSON.stringify(v).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const detail = async (id: string) => (await request(app).get(`/api/submissions/${id}`).set(auth)).body;
const overloaded = () =>
  new Anthropic.InternalServerError(
    529,
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    undefined,
    new Headers(),
  );
const tooLong = () =>
  new Anthropic.BadRequestError(
    400,
    {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' },
    },
    undefined,
    new Headers(),
  );

let n = 0;
async function ingest(): Promise<string> {
  const { ingestEmail } = await import('../src/services/pipeline.js');
  n++;
  const { submissionId } = await ingestEmail(
    {
      gmailMessageId: null,
      threadId: null,
      fromAddress: `broker${n}@retry.test`,
      toAddress: 'uw@insurer.com',
      subject: `Quote request for malpractice coverage ${n}`,
      bodyText: `Please quote malpractice coverage, application attached (${n}).`,
      receivedAt: new Date(),
      attachments: [
        { filename: 'a.txt', mimeType: 'text/plain', data: Buffer.from(`Applicant: Jane Smith ${n}`) },
        { filename: 'b.txt', mimeType: 'text/plain', data: Buffer.from(`Practice state: TX ${n}`) },
      ],
    },
    null,
  );
  return submissionId;
}

/** Runs the queued automatic retries now instead of after their backoff. */
const runRetriesNow = (id: string) =>
  pool.query(`UPDATE jobs SET run_after=now() WHERE dedupe_key=$1 AND status='queued'`, [`process:${id}`]);

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ims_test_retry WITH (FORCE)');
  await admin.query('CREATE DATABASE ims_test_retry');
  await admin.end();
  await (await import('../src/db/migrate.js')).migrate();
  ({ pool } = await import('../src/db/pool.js'));
  app = (await import('../src/app.js')).createApp();
  await request(app)
    .post('/api/auth/register')
    .send({ email: 'a@example.com', password: 'correct-horse-battery', name: 'A' });
  const { token } = (
    await request(app)
      .post('/api/auth/login')
      .set(CLI)
      .send({ email: 'a@example.com', password: 'correct-horse-battery' })
  ).body;
  auth = { Authorization: `Bearer ${token}` };
});

afterAll(async () => {
  await (await import('../src/services/jobQueue.js')).jobs.stop(5000);
  await (await import('../src/services/pgListen.js')).closeListener();
  if (pool) await (await import('../src/db/pool.js')).closePools();
});

beforeEach(() => {
  mock.tasks.length = 0;
  mock.fieldFailures.length = 0;
  mock.read.length = 0;
});

describe('plain-English processing errors', () => {
  it('words Claude API errors by status and type, keeping the raw text as detail', () => {
    expect(describeProcessingError(overloaded())).toMatchObject({
      message: 'Claude is overloaded right now. Wait a few minutes, then retry.',
      transient: true,
    });
    expect(describeProcessingError(overloaded()).detail).toMatch(/^529 /);
    const rate = new Anthropic.RateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      undefined,
      new Headers(),
    );
    expect(describeProcessingError(rate)).toMatchObject({
      message: expect.stringMatching(/too many requests/),
      transient: true,
    });
    expect(
      describeProcessingError(new Anthropic.InternalServerError(500, undefined, undefined, new Headers())),
    ).toMatchObject({ message: expect.stringMatching(/temporary problem/), transient: true });
    expect(describeProcessingError(tooLong())).toMatchObject({
      message: expect.stringMatching(/too long for Claude/),
      transient: false,
    });
    const auth401 = new Anthropic.AuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      undefined,
      new Headers(),
    );
    expect(describeProcessingError(auth401)).toMatchObject({
      message: expect.stringMatching(/API key is missing or no longer valid/),
      transient: false,
    });
    expect(describeProcessingError(new Anthropic.APIConnectionError({ message: 'Connection error.' }))).toMatchObject({
      message: expect.stringMatching(/could not be reached/),
      transient: true,
    });
  });

  it('treats timeouts and dropped connections as short-lived', () => {
    expect(describeProcessingError(new ClaudeTimeoutError(5))).toMatchObject({
      message: expect.stringMatching(/took too long/),
      transient: true,
      detail: 'Claude did not finish within 5 minutes',
    });
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(describeProcessingError(reset)).toMatchObject({
      message: expect.stringMatching(/could not be reached/),
      transient: true,
    });
    expect(
      describeProcessingError(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }),
        }),
      ).transient,
    ).toBe(true);
    expect(describeProcessingError(new TypeError('fetch failed'))).toMatchObject({
      message: expect.stringMatching(/could not be reached/),
      transient: true,
    });
    expect(describeProcessingError(new StorageError('UNAVAILABLE', 'Drive 503'))).toMatchObject({
      message: expect.stringMatching(/Google Drive/),
      transient: true,
    });
    expect(describeProcessingError(new StorageError('CONFIG', 'Drive quota')).transient).toBe(false);
  });

  it('passes messages written for people through and never retries them', () => {
    const plain = new AppError('X', 409, 'The submission was deleted while it was processed');
    expect(describeProcessingError(plain)).toEqual({ message: plain.message, detail: null, transient: false });
    expect(describeProcessingError(new LlmBudgetError(10, 5))).toMatchObject({
      message: expect.stringMatching(/usage limit/),
      transient: false,
    });
    // A per-submission refusal names the submission's limit, not the global daily one.
    const perSubmission = describeError(new LlmSubmissionBudgetError(10, 5));
    expect(perSubmission).toMatchObject({ message: FAILURE_MESSAGES.submissionBudget, transient: false });
    expect(perSubmission.message).not.toBe(FAILURE_MESSAGES.budget);
    expect(describeError(new LlmBudgetError(10, 5)).message).toBe(FAILURE_MESSAGES.budget);
    expect(describeProcessingError(new Error('No readable text in the email'))).toEqual({
      message: 'No readable text in the email',
      detail: null,
      transient: false,
    });
    expect(
      describeProcessingError(new Error('Cannot read properties of undefined (reading "x")\n    at f (a.js:1)')),
    ).toMatchObject({
      message: expect.stringMatching(/^Something went wrong while processing this email/),
      transient: false,
    });
  });

  it('words failures outside email processing the same way, without mentioning the email', () => {
    expect(describeError(overloaded()).message).toBe('Claude is overloaded right now. Wait a few minutes, then retry.');
    expect(describeError(new Error('x is not a function\n    at f (a.js:1)')).message).toMatch(
      /^Something went wrong\. Retry; if it keeps failing/,
    );
    expect(
      describeError(new AppError('X', 409, 'A completed Synthesis Report is required before analysis')).message,
    ).toBe('A completed Synthesis Report is required before analysis');
  });

  it('mirrors the frontend wording for stored text', () => {
    expect(friendlyText('Drive unavailable')).toEqual({ message: 'Drive unavailable', technical: null });
    expect(
      friendlyText(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}',
      ).message,
    ).toMatch(/out of credit/);
    expect(friendlyText('')).toEqual({ message: 'Processing failed.', technical: null });
  });
});

describe('retry from the failed step', () => {
  it('fails at once on a non-transient error, then resumes from the failed step reading only unfinished documents', async () => {
    mock.fieldFailures.push(tooLong());
    const id = await ingest();
    const failed = await waitFor(
      () => detail(id),
      (d) => d.status === 'ERROR' || d.status === 'READY_FOR_REVIEW',
    );
    expect(failed.status).toBe('ERROR');
    expect(failed.pipeline).toEqual({
      completedSteps: ['classification', 'documents'],
      failedStep: 'fields',
      autoRetrying: false,
      error: expect.stringMatching(/too long for Claude/),
    });
    expect(failed.processingError).toBe(failed.pipeline.error);
    expect(failed.processingErrorDetail).toMatch(/prompt is too long/);
    expect(mock.tasks.filter((t) => t !== 'classification')).toHaveLength(1); // no automatic retry
    expect(
      (await pool.query(`SELECT details FROM audit_events WHERE submission_id=$1 AND action='PROCESSING_FAILED'`, [id]))
        .rows[0].details,
    ).toMatchObject({ step: 'fields', error: expect.stringMatching(/prompt is too long/) });
    // The summary in the inbox list carries the same state.
    const list = (await request(app).get('/api/submissions').set(auth).query({ view: 'errors' })).body;
    expect(list.items.find((s: { id: string }) => s.id === id).pipeline.failedStep).toBe('fields');

    mock.tasks.length = 0;
    mock.read.length = 0;
    expect((await request(app).post(`/api/submissions/${id}/retry`).set(auth)).status).toBe(202);
    const ok = await waitFor(
      () => detail(id),
      (d) => d.status === 'READY_FOR_REVIEW' || d.status === 'ERROR',
    );
    expect(ok.status).toBe('READY_FOR_REVIEW');
    expect(ok.pipeline).toEqual({
      completedSteps: ['classification', 'documents', 'fields', 'npi'],
      failedStep: null,
      autoRetrying: false,
      error: null,
    });
    expect(ok.processingError).toBeNull();
    expect(ok.processingErrorDetail).toBeNull();
    expect(mock.tasks).toEqual(['extraction']); // classification kept
    expect(mock.read).toEqual([]); // documents were read by the failed run
    expect(ok.extractedFields.map((f: { value: string }) => f.value)).toEqual(['Jane Smith']);
    const {
      rows: [retried],
    } = await pool.query(
      `SELECT actor_id, details FROM audit_events WHERE submission_id=$1 AND action='PROCESSING_RETRIED'`,
      [id],
    );
    expect(retried.details).toEqual({ fromStep: 'fields' });
    expect(retried.actor_id).toBeTruthy();

    // Nothing failed any more.
    const again = await request(app).post(`/api/submissions/${id}/retry`).set(auth);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOT_PROCESSABLE');
  });

  it('resumes a run that failed reading documents with only the unread and failed ones', async () => {
    const id = await ingest();
    await waitFor(
      () => detail(id),
      (d) => d.status === 'READY_FOR_REVIEW',
    );
    await pool.query(`UPDATE documents SET extraction_status='ERROR' WHERE submission_id=$1 AND filename='b.txt'`, [
      id,
    ]);
    await pool.query(
      `UPDATE submissions SET status='ERROR', processing_error='Files could not be read',
      pipeline_progress='{"completedSteps":["classification"],"failedStep":"documents","autoRetrying":false}' WHERE id=$1`,
      [id],
    );
    mock.read.length = 0;
    mock.tasks.length = 0;
    const res = await request(app).post(`/api/submissions/${id}/retry`).set(auth);
    expect(res.status).toBe(202);
    const ok = await waitFor(
      () => detail(id),
      (d) => d.status === 'READY_FOR_REVIEW' || d.status === 'ERROR',
    );
    expect(ok.status).toBe('READY_FOR_REVIEW');
    expect(mock.read).toEqual(['b.txt']);
    expect(mock.tasks).toEqual(['extraction']);
    expect(ok.documents.map((d: { extractionStatus: string }) => d.extractionStatus)).not.toContain('ERROR');
    expect(ok.pipeline.completedSteps).toEqual(['classification', 'documents', 'fields', 'npi']);
    expect(
      (
        await pool.query(`SELECT details FROM audit_events WHERE submission_id=$1 AND action='PROCESSING_RETRIED'`, [
          id,
        ])
      ).rows[0].details,
    ).toEqual({ fromStep: 'documents' });
  });

  it('answers 404 for a missing submission and 409 while one is processing or queued', async () => {
    expect(
      (await request(app).post('/api/submissions/00000000-0000-4000-8000-000000000000/retry').set(auth)).status,
    ).toBe(404);
    const id = await ingest();
    await waitFor(
      () => detail(id),
      (d) => d.status === 'READY_FOR_REVIEW',
    );
    await pool.query(`UPDATE submissions SET status='PROCESSING' WHERE id=$1`, [id]);
    const busy = await request(app).post(`/api/submissions/${id}/retry`).set(auth);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('ALREADY_QUEUED');
    // Queued (e.g. an automatic retry waiting for its backoff) while the status says ERROR.
    await pool.query(`UPDATE submissions SET status='ERROR' WHERE id=$1`, [id]);
    await pool.query(
      `INSERT INTO jobs (kind, dedupe_key, payload, max_attempts, run_after) VALUES ('process', $1, $2, 3, now() + interval '1 hour')`,
      [`process:${id}`, JSON.stringify({ submissionId: id, actorId: null })],
    );
    expect((await request(app).post(`/api/submissions/${id}/retry`).set(auth)).body.error.code).toBe('ALREADY_QUEUED');
    await pool.query(`DELETE FROM jobs WHERE dedupe_key=$1 AND status='queued'`, [`process:${id}`]);
    await pool.query(`UPDATE submissions SET deleted_at=now() WHERE id=$1`, [id]);
    expect((await request(app).post(`/api/submissions/${id}/retry`).set(auth)).status).toBe(404);
  });

  it('retries a short-lived failure automatically, resuming, and fails once the attempts are used up', async () => {
    mock.fieldFailures.push(overloaded(), overloaded(), overloaded());
    const id = await ingest();
    const waiting = await waitFor(
      () => detail(id),
      (d) => d.pipeline.autoRetrying,
    );
    expect(waiting.status).toBe('PROCESSING');
    expect(waiting.pipeline).toMatchObject({
      failedStep: 'fields',
      error: 'Claude is overloaded right now. Wait a few minutes, then retry.',
    });
    // The job is handed back to the queue once the run has thrown.
    const job = await waitFor(
      async () =>
        (
          await pool.query(
            `SELECT run_after > now() + interval '20 seconds' AS later FROM jobs WHERE dedupe_key=$1 AND status='queued'`,
            [`process:${id}`],
          )
        ).rows[0],
      (r) => !!r,
    );
    expect(job.later).toBe(true); // backoff of 30 s

    const failed = await waitFor(
      async () => {
        await runRetriesNow(id);
        return detail(id);
      },
      (d) => d.status === 'ERROR',
    );
    expect(failed.pipeline).toEqual({
      completedSteps: ['classification', 'documents'],
      failedStep: 'fields',
      autoRetrying: false,
      error: 'Claude is overloaded right now. Wait a few minutes, then retry.',
    });
    expect(failed.processingErrorDetail).toMatch(/^529 .*overloaded_error/);
    // Classified once: every resumed attempt keeps it.
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM audit_events WHERE submission_id=$1 AND action='EMAIL_CLASSIFIED'`,
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(mock.tasks.filter((t) => t !== 'classification')).toHaveLength(3); // the first run + 2 retries
    expect(mock.read.filter((f) => f === 'a.txt')).toHaveLength(1);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM audit_events WHERE submission_id=$1 AND action='PROCESSING_RETRY_SCHEDULED'`,
          [id],
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it('succeeds on an automatic retry after a timeout', async () => {
    mock.fieldFailures.push(new ClaudeTimeoutError(5));
    const id = await ingest();
    await waitFor(
      () => detail(id),
      (d) => d.pipeline.autoRetrying,
    );
    const ok = await waitFor(
      async () => {
        await runRetriesNow(id);
        return detail(id);
      },
      (d) => d.status === 'READY_FOR_REVIEW' || d.status === 'ERROR',
    );
    expect(ok.status).toBe('READY_FOR_REVIEW');
    expect(ok.pipeline).toEqual({
      completedSteps: ['classification', 'documents', 'fields', 'npi'],
      failedStep: null,
      autoRetrying: false,
      error: null,
    });
    expect(ok.processingError).toBeNull();
  });

  it('retry-all resumes each failed submission from its failed step', async () => {
    mock.fieldFailures.push(tooLong());
    const id = await ingest();
    await waitFor(
      () => detail(id),
      (d) => d.status === 'ERROR',
    );
    mock.read.length = 0;
    mock.tasks.length = 0;
    const res = await request(app).post('/api/submissions/errors/retry-all').set(auth);
    expect(res.status).toBe(202);
    expect(res.body.queued).toBeGreaterThanOrEqual(1);
    await waitFor(
      () => detail(id),
      (d) => d.status === 'READY_FOR_REVIEW',
    );
    expect(mock.read).toEqual([]);
    expect(mock.tasks).not.toContain('classification');
  });

  it('reprocess is a full re-run that clears the progress', async () => {
    const id = await ingest();
    await waitFor(
      () => detail(id),
      (d) => d.status === 'READY_FOR_REVIEW',
    );
    await pool.query(
      `UPDATE submissions SET status='ERROR', processing_error='x',
      pipeline_progress='{"completedSteps":["classification","documents","fields"],"failedStep":"npi","autoRetrying":false}' WHERE id=$1`,
      [id],
    );
    mock.read.length = 0;
    expect((await request(app).post(`/api/submissions/${id}/reprocess`).set(auth)).status).toBe(202);
    const d = await waitFor(
      () => detail(id),
      (s) => s.status === 'READY_FOR_REVIEW',
    );
    expect(mock.read.sort()).toEqual(['a.txt', 'b.txt']);
    expect(mock.tasks).toContain('extraction');
    expect(d.pipeline).toEqual({
      completedSteps: ['classification', 'documents', 'fields', 'npi'],
      failedStep: null,
      autoRetrying: false,
      error: null,
    });
  });

  it('a run taken over after a crash resumes from the progress, keeping classification', async () => {
    const id = await ingest();
    await waitFor(
      () => detail(id),
      (d) => d.status === 'READY_FOR_REVIEW',
    );
    await pool.query(
      `UPDATE submissions SET status='PROCESSING',
      pipeline_progress='{"completedSteps":["classification","documents"],"failedStep":null,"autoRetrying":false}' WHERE id=$1`,
      [id],
    );
    mock.read.length = 0;
    mock.tasks.length = 0;
    const { requeueStalledSubmissions } = await import('../src/services/pipeline.js');
    expect(await requeueStalledSubmissions()).toBe(1);
    await waitFor(
      () => detail(id),
      (d) => d.status === 'READY_FOR_REVIEW',
    );
    expect(mock.read).toEqual([]);
    expect(mock.tasks).toEqual(['extraction']);
  });
});
