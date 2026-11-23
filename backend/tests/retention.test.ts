/**
 * Retention (spec §5): Settings → Retention purges transcripts, LLM call rows and chat messages past their period, and
 * scrubs the PHI of submissions deleted longer ago than theirs (the row, ids and audit history stay). Every period
 * defaults to "keep forever". Drive is faked; the database is real.
 */
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as Constants from '../src/constants.js';
import type * as Retention from '../src/services/retention.js';
import { makeUser, registerAdmin, startTestApp, stopTestApp, testDatabaseUrl } from './helpers/apiTestDb.js';
import { driveFiles } from './helpers/fakeDrive.js';

/** Drive ids whose next trash fails (once), as a Drive outage would. */
const failTrashOnce = vi.hoisted(() => new Set<string>());
vi.mock('../src/services/driveStorage.js', async (orig) => {
  const fake = (await import('./helpers/fakeDrive.js')).fakeDrive(await orig());
  return {
    ...fake,
    trashDriveFile: async (id: string) => {
      if (failTrashOnce.delete(id)) throw new Error('Drive is unavailable');
      await fake.trashDriveFile(id);
    },
  };
});
// Two rows per batch, so the purge pages through its batches in these tests.
vi.mock('../src/constants.js', async (orig) => ({
  ...(await orig<typeof Constants>()),
  RETENTION_BATCH: 2,
}));

// TEST_DB_SUFFIX lets parallel runs (several worktrees on one Postgres) use their own database.
const DB_NAME = `ims_test_retention${process.env.TEST_DB_SUFFIX ?? ''}`;
process.env.DATABASE_URL = testDatabaseUrl(DB_NAME);

let app: Express;
let pool: pg.Pool;
let admin: { Authorization: string };
let retention: typeof Retention;
let adminId: string;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

beforeAll(async () => {
  ({ app, pool } = await startTestApp(DB_NAME));
  admin = await registerAdmin(app);
  retention = await import('../src/services/retention.js');
  adminId = (await pool.query(`SELECT id FROM users WHERE email='admin@example.com'`)).rows[0].id;
});

afterAll(stopTestApp);

/** A submission with an email, a stored document, a field, a report, a chat turn, an injection flag and an LLM call. */
async function seedSubmission(opts: { deletedAt?: Date | null; createdAt?: Date } = {}) {
  const at = opts.createdAt ?? new Date();
  const {
    rows: [email],
  } = await pool.query(
    `INSERT INTO emails (from_address, to_address, cc_address, subject, snippet, body_text, received_at, created_at)
     VALUES ('jane.roe@clinic.com','uw@acme.com','jane.home@mail.com','Jane Roe OB/GYN','Jane Roe snippet',
             'Applicant Jane Roe, SSN 123-45-6789',$1,$1) RETURNING id`,
    [at],
  );
  const {
    rows: [sub],
  } = await pool.query(
    `INSERT INTO submissions (email_id, status, applicant_name, applicant_type, applicant_first_name, applicant_last_name,
       normalized_subject, processing_error, created_at, deleted_at)
     VALUES ($1,'READY_FOR_REVIEW','Jane Roe','INDIVIDUAL','Jane','Roe','jane roe ob/gyn','Could not read Jane_Roe.pdf',$2,$3)
     RETURNING id`,
    [email.id, at, opts.deletedAt ?? null],
  );
  const storageKey = `drive-doc-${sub.id}`;
  driveFiles.set(storageKey, { data: Buffer.from('x'), filename: 'app.pdf', documentId: 'd' });
  const {
    rows: [doc],
  } = await pool.query(
    `INSERT INTO documents (submission_id, filename, mime_type, size_bytes, sha256, storage_key, source, storage_backend, extracted_text, created_at)
     VALUES ($1,'Jane_Roe_app.pdf','application/pdf',1,'abc',$2,'EMAIL','GDRIVE','Jane Roe DOB 01/02/1970',$3) RETURNING id`,
    [sub.id, storageKey, at],
  );
  await pool.query(
    `INSERT INTO extracted_fields (submission_id, document_id, field_name, value, confidence, evidence_quote, source_label, context_version, created_at)
     VALUES ($1,$2,'applicant_name','Jane Roe',0.9,'Applicant: Jane Roe','app.pdf',0,$3)`,
    [sub.id, doc.id, at],
  );
  const {
    rows: [call],
  } = await pool.query(
    `INSERT INTO llm_calls (submission_id, task, skill_name, skill_version, model, status, duration_ms, created_at)
     VALUES ($1,'synthesis','synthesis','1','m','SUCCESS',1,$2) RETURNING id`,
    [sub.id, at],
  );
  await pool.query(
    `INSERT INTO llm_transcripts (llm_call_id, system_sha256, prompt_sha256, prompt, output, created_at) VALUES ($1,'a','b','Jane Roe prompt','out',$2)`,
    [call.id, at],
  );
  await pool.query(
    `INSERT INTO reports (submission_id, kind, version, status, context_version, skill_name, skill_version, model, content_json, content_markdown, grounding, llm_call_id, created_at)
     VALUES ($1,'SYNTHESIS',1,'COMPLETED',0,'synthesis','1','m','{"name":"Jane Roe"}','# Jane Roe','{"checked":1}',$2,$3)`,
    [sub.id, call.id, at],
  );
  await pool.query(
    `INSERT INTO reports (submission_id, kind, version, status, context_version, skill_name, skill_version, model, error)
     VALUES ($1,'ANALYSIS',1,'FAILED',0,'underwriting-analysis','1','m','Claude declined Jane Roe')`,
    [sub.id],
  );
  await pool.query(
    `INSERT INTO attachment_gaps (submission_id, filename, reason, detail)
     VALUES ($1,'Jane_Roe_loss_runs.pdf','LINKED_FILE','https://x/Jane_Roe')`,
    [sub.id],
  );
  await pool.query(
    `INSERT INTO outbound_emails (submission_id, mode, to_addresses, cc_addresses, bcc_addresses, subject, body, transport, sent_by, error)
     VALUES ($1,'REPLY','{jane.roe@clinic.com}','{a@b.com}','{c@d.com}','Re: Jane Roe','Dear Jane Roe','OAUTH',$2,'Jane Roe bounce')`,
    [sub.id, adminId],
  );
  await pool.query(
    `INSERT INTO assessments (submission_id, version, decision, risk_rating, notes, context_version, created_by)
     VALUES ($1,1,'REFER','HIGH','Jane Roe has two claims',0,$2)`,
    [sub.id, adminId],
  );
  await pool.query(
    `INSERT INTO npi_verifications (submission_id, npi, status, claimed_name, claimed_type, claimed_first_name, claimed_last_name, note)
     VALUES ($1,'1234567893','MATCH','Jane Roe','INDIVIDUAL','Jane','Roe','Called Jane Roe')`,
    [sub.id],
  );
  await pool.query(
    `INSERT INTO ims2_intake_queue (submission_id, intake_id, state, payload, payload_hash, sent_by, form, last_error)
     VALUES ($1,$2,'QUEUED','{"insured":"Jane Roe"}','h',$3,'{"name":"Jane Roe"}','Jane Roe rejected')`,
    [sub.id, `intake-${sub.id}`, adminId],
  );
  await pool.query(
    `INSERT INTO ims2_handoffs (submission_id, draft_id, state, payload, payload_hash, pushed_by, last_error)
     VALUES ($1,$2,'PENDING','{"insured":"Jane Roe"}','h',$3,'Jane Roe invalid')`,
    [sub.id, `draft-${sub.id}`, adminId],
  );
  await pool.query(
    `INSERT INTO chat_messages (submission_id, role, content, created_at) VALUES ($1,'user','Is Jane Roe insurable?',$2)`,
    [sub.id, at],
  );
  await pool.query(
    `INSERT INTO injection_flags (submission_id, category, pattern, excerpt, created_at) VALUES ($1,'override','ignore','ignore previous instructions, Jane Roe',$2)`,
    [sub.id, at],
  );
  await pool.query(
    `INSERT INTO audit_events (submission_id, actor_type, action, entity_type) VALUES ($1,'SYSTEM','SUBMISSION_DELETED','submission')`,
    [sub.id],
  );
  return {
    id: sub.id as string,
    emailId: email.id as string,
    storageKey,
    callId: String(call.id),
    docId: doc.id as string,
  };
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n);

describe('retention settings', () => {
  it('default to keep forever', async () => {
    const res = await request(app).get('/api/settings/retention').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.values).toEqual({
      llmTranscriptsDays: null,
      llmCallsDays: null,
      chatDays: null,
      deletedSubmissionsDays: null,
      skippedEmailsDays: null,
    });
    expect(res.body.bounds).toEqual({ min: 30, max: 3650 });
  });

  it('refuses a period under 30 days', async () => {
    const res = await request(app).put('/api/settings/retention').set(admin).send({ chatDays: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fieldErrors.chatDays).toBeDefined();
  });

  it('needs settings:manage to change', async () => {
    const uw = await makeUser(pool, 'uw@example.com', 'UNDERWRITER');
    expect((await request(app).put('/api/settings/retention').set(uw.auth).send({ chatDays: 30 })).status).toBe(403);
  });
});

describe('runRetention', () => {
  it('deletes nothing with the defaults', async () => {
    const old = await seedSubmission({ createdAt: daysAgo(400), deletedAt: daysAgo(400) });
    expect(await retention.runRetention()).toEqual({
      llmTranscripts: 0,
      llmCalls: 0,
      chatMessages: 0,
      submissionsScrubbed: 0,
      skippedEmails: 0,
    });
    expect(await count('chat_messages WHERE submission_id=$1', [old.id])).toBe(1);
    expect(await count(`audit_events WHERE action='RETENTION_PURGE'`)).toBe(0);
    // Leave it for the next test's cutoff.
  });

  it('purges rows past their period and scrubs old deleted submissions, once', async () => {
    const saved = await request(app).put('/api/settings/retention').set(admin).send({
      llmTranscriptsDays: 30,
      llmCallsDays: 30,
      chatDays: 30,
      deletedSubmissionsDays: 30,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.values.chatDays).toBe(30);
    await pool.query('DELETE FROM llm_transcripts');
    await pool.query('DELETE FROM chat_messages');
    await pool.query('UPDATE reports SET llm_call_id=NULL');
    await pool.query('DELETE FROM llm_calls');
    await pool.query(`UPDATE submissions SET deleted_at=NULL`); // earlier seeds are out of scope

    const deletedOld = await seedSubmission({ createdAt: daysAgo(31), deletedAt: daysAgo(31) });
    const deletedRecent = await seedSubmission({ createdAt: daysAgo(31), deletedAt: daysAgo(5) });
    const activeAncient = await seedSubmission({ createdAt: daysAgo(5 * 365) });
    const fresh = await seedSubmission();
    const auditBefore = await count('audit_events WHERE submission_id=$1', [deletedOld.id]);

    const counts = await retention.runRetention();
    // Three seeds are 31+ days old: their transcripts, calls and chat rows go; the fresh one's stay.
    expect(counts).toEqual({
      llmTranscripts: 3,
      llmCalls: 3,
      chatMessages: 3,
      submissionsScrubbed: 1,
      skippedEmails: 0,
    });
    expect(await count('llm_transcripts')).toBe(1);
    expect(await count('llm_calls WHERE id=$1', [fresh.callId])).toBe(1);
    expect(await count('chat_messages WHERE submission_id=$1', [fresh.id])).toBe(1);

    // The scrubbed submission: no PHI left, the skeleton and its audit trail kept.
    const {
      rows: [sub],
    } = await pool.query('SELECT purged_at, status FROM submissions WHERE id=$1', [deletedOld.id]);
    expect(sub.purged_at).not.toBeNull();
    expect(sub.status).toBe('READY_FOR_REVIEW');
    const {
      rows: [email],
    } = await pool.query('SELECT body_text, snippet, subject FROM emails WHERE id=$1', [deletedOld.emailId]);
    expect(email.body_text || null).toBeNull();
    expect(email.snippet || null).toBeNull();
    expect(email.subject || null).toBeNull();
    const {
      rows: [doc],
    } = await pool.query('SELECT extracted_text FROM documents WHERE submission_id=$1', [deletedOld.id]);
    expect(doc.extracted_text || null).toBeNull();
    expect(driveFiles.has(deletedOld.storageKey)).toBe(false);
    const {
      rows: [field],
    } = await pool.query('SELECT value, evidence_quote FROM extracted_fields WHERE submission_id=$1', [deletedOld.id]);
    expect(field.value || null).toBeNull();
    expect(field.evidence_quote).toBeNull();
    const {
      rows: [report],
    } = await pool.query('SELECT content_json, content_markdown, grounding FROM reports WHERE submission_id=$1', [
      deletedOld.id,
    ]);
    expect(report).toEqual({ content_json: null, content_markdown: null, grounding: null });
    expect(await count('chat_messages WHERE submission_id=$1', [deletedOld.id])).toBe(0);
    expect(await count('injection_flags WHERE submission_id=$1', [deletedOld.id])).toBe(0);
    expect(await count('audit_events WHERE submission_id=$1', [deletedOld.id])).toBe(auditBefore);

    // Nothing that names the applicant (or her email, file names, notes) is left in any row of the submission.
    const leftovers = await pool.query(
      `SELECT t, j FROM (
         SELECT 'emails' AS t, row_to_json(e)::text AS j FROM emails e WHERE id=$2
         UNION ALL SELECT 'submissions', row_to_json(s)::text FROM submissions s WHERE id=$1
         UNION ALL SELECT 'documents', row_to_json(d)::text FROM documents d WHERE submission_id=$1
         UNION ALL SELECT 'attachment_gaps', row_to_json(g)::text FROM attachment_gaps g WHERE submission_id=$1
         UNION ALL SELECT 'extracted_fields', row_to_json(f)::text FROM extracted_fields f WHERE submission_id=$1
         UNION ALL SELECT 'reports', row_to_json(r)::text FROM reports r WHERE submission_id=$1
         UNION ALL SELECT 'outbound_emails', row_to_json(o)::text FROM outbound_emails o WHERE submission_id=$1
         UNION ALL SELECT 'assessments', row_to_json(a)::text FROM assessments a WHERE submission_id=$1
         UNION ALL SELECT 'npi_verifications', row_to_json(n)::text FROM npi_verifications n WHERE submission_id=$1
         UNION ALL SELECT 'ims2_intake_queue', row_to_json(q)::text FROM ims2_intake_queue q WHERE submission_id=$1
         UNION ALL SELECT 'ims2_handoffs', row_to_json(h)::text FROM ims2_handoffs h WHERE submission_id=$1
       ) x WHERE j ~* '(jane|roe)'`,
      [deletedOld.id, deletedOld.emailId],
    );
    expect(leftovers.rows).toEqual([]);
    const {
      rows: [purgedDoc],
    } = await pool.query('SELECT filename, file_purged_at FROM documents WHERE id=$1', [deletedOld.docId]);
    expect(purgedDoc.filename).toBe(`purged-${deletedOld.docId}`);
    expect(purgedDoc.file_purged_at).not.toBeNull();
    const {
      rows: [ims],
    } = await pool.query('SELECT payload, form FROM ims2_intake_queue WHERE submission_id=$1', [deletedOld.id]);
    expect(ims).toEqual({ payload: {}, form: null });

    // Recently deleted and active submissions are untouched (their old chat/transcripts went by age above).
    for (const s of [deletedRecent, activeAncient]) {
      expect((await pool.query('SELECT purged_at FROM submissions WHERE id=$1', [s.id])).rows[0].purged_at).toBeNull();
      expect((await pool.query('SELECT body_text FROM emails WHERE id=$1', [s.emailId])).rows[0].body_text).toContain(
        'Jane Roe',
      );
      expect(await count('injection_flags WHERE submission_id=$1', [s.id])).toBe(1);
      expect(driveFiles.has(s.storageKey)).toBe(true);
    }

    const {
      rows: [audit],
    } = await pool.query(`SELECT details FROM audit_events WHERE action='RETENTION_PURGE'`);
    expect(audit.details).toMatchObject({ counts });

    // A second run finds nothing: the scrubbed submission is filtered by purged_at, and no audit row is added.
    expect(await retention.runRetention()).toEqual({
      llmTranscripts: 0,
      llmCalls: 0,
      chatMessages: 0,
      submissionsScrubbed: 0,
      skippedEmails: 0,
    });
    expect(await count(`audit_events WHERE action='RETENTION_PURGE'`)).toBe(1);
  });

  it('never scrubs a submission that is not deleted', async () => {
    const active = await seedSubmission({ createdAt: daysAgo(400) });
    expect(await retention.scrubSubmission(active.id)).toBe(false);
    expect(
      (await pool.query('SELECT purged_at FROM submissions WHERE id=$1', [active.id])).rows[0].purged_at,
    ).toBeNull();
  });

  it('retries a file Drive failed to trash on the next run', async () => {
    const sub = await seedSubmission({ createdAt: daysAgo(40), deletedAt: daysAgo(40) });
    failTrashOnce.add(sub.storageKey);
    const first = await retention.runRetention();
    expect(first.submissionsScrubbed).toBe(1);
    expect(driveFiles.has(sub.storageKey)).toBe(true);
    const filePurgedAt = async () =>
      (await pool.query('SELECT file_purged_at FROM documents WHERE id=$1', [sub.docId])).rows[0].file_purged_at;
    expect(await filePurgedAt()).toBeNull();
    expect(await count(`system_errors WHERE scope='retention:files'`)).toBe(1);

    const second = await retention.runRetention();
    expect(second.submissionsScrubbed).toBe(0);
    expect(driveFiles.has(sub.storageKey)).toBe(false);
    expect(await filePurgedAt()).not.toBeNull();
  });

  it('skips a submission whose scrub fails and still scrubs the others, ending the run', async () => {
    // Three due submissions over two batches (RETENTION_BATCH is 2 here); the oldest one's scrub fails every time.
    const failing = await seedSubmission({ createdAt: daysAgo(60), deletedAt: daysAgo(60) });
    const next = await seedSubmission({ createdAt: daysAgo(59), deletedAt: daysAgo(59) });
    const last = await seedSubmission({ createdAt: daysAgo(58), deletedAt: daysAgo(58) });
    await pool.query(`
      CREATE FUNCTION test_fail_scrub() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.purged_at IS NOT NULL AND NEW.id = '${failing.id}' THEN RAISE EXCEPTION 'scrub failed'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_scrub BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION test_fail_scrub();`);
    try {
      const counts = await retention.runRetention();
      expect(counts.submissionsScrubbed).toBe(2);
      const purged = async (id: string) =>
        (await pool.query('SELECT purged_at FROM submissions WHERE id=$1', [id])).rows[0].purged_at;
      expect(await purged(failing.id)).toBeNull();
      expect(await purged(next.id)).not.toBeNull();
      expect(await purged(last.id)).not.toBeNull();
      // Rolled back whole: the failing one keeps its data for the next try.
      expect(await count('injection_flags WHERE submission_id=$1', [failing.id])).toBe(1);
      expect(await count('system_errors WHERE scope=$1', [`retention:scrub:${failing.id}`])).toBe(1);
      // A run with only the failing one left ends too.
      expect((await retention.runRetention()).submissionsScrubbed).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER test_fail_scrub ON submissions; DROP FUNCTION test_fail_scrub();');
    }
  });
});

/** Every text, jsonb and array column of every table in public that holds `marker`, with its row count. */
async function columnsHolding(marker: string): Promise<string[]> {
  const { rows: cols } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     WHERE c.table_schema='public' AND t.table_type='BASE TABLE'
       AND c.data_type IN ('text','character varying','character','jsonb','json','ARRAY')`,
  );
  const hits: string[] = [];
  for (const c of cols) {
    const n = await count(`"${c.table_name}" WHERE "${c.column_name}"::text LIKE '%' || $1 || '%'`, [marker]);
    if (n) hits.push(`${c.table_name}.${c.column_name} (${n})`);
  }
  return hits;
}

describe('purge completeness (DB-01, DB-02)', () => {
  it('leaves a seeded marker in no text, jsonb or array column of any table', async () => {
    const M = `zqmark${Date.now().toString(36)}`;
    const old = daysAgo(400);
    await request(app)
      .put('/api/settings/retention')
      .set(admin)
      .send({ deletedSubmissionsDays: 30, skippedEmailsDays: 30 });
    // Gmail ids are opaque and stay (they stop the message being fetched again), so they do not carry the marker.
    const gmailId = `gm-${Date.now()}`;
    const skippedId = `skip-${Date.now()}`;
    const {
      rows: [email],
    } = await pool.query(
      `INSERT INTO emails (gmail_message_id, from_address, to_address, cc_address, subject, snippet, body_text, received_at, created_at)
       VALUES ($2,$1||'@clinic.com','uw+'||$1||'@acme.com',$1||'@home.com','Re '||$1,'snip '||$1,'body '||$1,$3,$3) RETURNING id`,
      [M, gmailId, old],
    );
    const {
      rows: [sub],
    } = await pool.query(
      `INSERT INTO submissions (email_id, status, applicant_name, applicant_type, applicant_first_name, applicant_last_name,
         normalized_subject, processing_error, processing_error_detail, classification_reasons, duplicate_basis, created_at, deleted_at)
       VALUES ($1,'READY_FOR_REVIEW',$2,'INDIVIDUAL',$2,$2,$2,$2,$2,ARRAY['reason '||$2],
               jsonb_build_object('rule','R5','strength','HIGH','sharedAttachments',jsonb_build_array($2::text||'.pdf'),
                 'explanation','Same as '||$2,'addedWords',jsonb_build_array($2::text),'removedWords','[]'::jsonb,'reason',$2),
               $3,$3)
       RETURNING id`,
      [email.id, M, old],
    );
    const id = sub.id as string;
    // A file written to local disk before attachments moved to Drive.
    const localRoot = await mkdtemp(path.join(tmpdir(), 'ims-local-'));
    process.env.STORAGE_PATH = localRoot;
    await writeFile(path.join(localRoot, `${id}.pdf`), 'x');
    const {
      rows: [doc],
    } = await pool.query(
      `INSERT INTO documents (submission_id, filename, mime_type, size_bytes, sha256, storage_key, source, storage_backend, extracted_text)
       VALUES ($1,$2||'.pdf','application/pdf',1,'abc',$3,'EMAIL','LOCAL','text '||$2) RETURNING id`,
      [id, M, `${id}.pdf`],
    );
    await pool.query(
      `INSERT INTO attachment_gaps (submission_id, filename, reason, detail) VALUES ($1,$2||'.pdf','LINKED_FILE','https://x/'||$2)`,
      [id, M],
    );
    await pool.query(
      `INSERT INTO extracted_fields (submission_id, document_id, field_name, value, confidence, evidence_quote, source_label, context_version)
       VALUES ($1,$2,'applicant_name',$3,0.9,'quote '||$3,'label '||$3,0)`,
      [id, doc.id, M],
    );
    // Through the services, so the audit events are the ones the app writes.
    const { addManualFields } = await import('../src/services/fields.js');
    await addManualFields(
      pool,
      id,
      [{ fieldName: 'specialty', value: M, note: `note ${M}`, documentId: doc.id }],
      adminId,
    );
    const { audit } = await import('../src/services/audit.js');
    await audit({
      action: 'TEST_PHI',
      entityType: 'submission',
      entityId: id,
      submissionId: id,
      actorId: null,
      details: {
        filename: `${M}.pdf`,
        subject: M,
        value: M,
        sharedAttachments: [M],
        npi: '1234567893',
        from: `${M}@x.com`,
      },
    });
    const {
      rows: [call],
    } = await pool.query(
      `INSERT INTO llm_calls (submission_id, task, skill_name, skill_version, model, status, duration_ms, error)
       VALUES ($1,'synthesis','synthesis','1','m','ERROR',1,'failed on '||$2) RETURNING id`,
      [id, M],
    );
    await pool.query(
      `INSERT INTO llm_transcripts (llm_call_id, system_sha256, prompt_sha256, prompt, output) VALUES ($1,'a','b',$2,$2)`,
      [call.id, M],
    );
    const {
      rows: [r1],
    } = await pool.query(
      `INSERT INTO reports (submission_id, kind, version, status, context_version, skill_name, skill_version, model, content_json, content_markdown, grounding, error)
       VALUES ($1,'SYNTHESIS',1,'COMPLETED',0,'synthesis','1','m',jsonb_build_object('n',$2::text),$2,jsonb_build_object('q',$2::text),$2) RETURNING id`,
      [id, M],
    );
    const {
      rows: [r2],
    } = await pool.query(
      `INSERT INTO reports (submission_id, kind, version, status, context_version, skill_name, skill_version, model, content_markdown)
       VALUES ($1,'SYNTHESIS',2,'COMPLETED',0,'synthesis','1','m',$2) RETURNING id`,
      [id, M],
    );
    await pool.query(
      `INSERT INTO report_comparisons (submission_id, kind, base_report_id, target_report_id, status, field_diff, content_json, content_markdown, skill_name, skill_version, model, error)
       VALUES ($1,'SYNTHESIS',$2,$3,'COMPLETED',jsonb_build_array($4::text),jsonb_build_object('x',$4::text),$4,'s','1','m',$4)`,
      [id, r1.id, r2.id, M],
    );
    await pool.query(
      `INSERT INTO email_drafts (submission_id, analysis_report_id, content, model, skill_version) VALUES ($1,$2,jsonb_build_object('d',$3::text),'m','1')`,
      [id, r1.id, M],
    );
    await pool.query(
      `INSERT INTO outbound_emails (submission_id, mode, to_addresses, cc_addresses, bcc_addresses, subject, body, transport, sent_by, error)
       VALUES ($1,'REPLY',ARRAY[$2||'@a.com'],ARRAY[$2||'@b.com'],ARRAY[$2||'@c.com'],$2,$2,'OAUTH',$3,$2)`,
      [id, M, adminId],
    );
    await pool.query(
      `INSERT INTO assessments (submission_id, version, decision, risk_rating, notes, context_version, created_by)
       VALUES ($1,1,'REFER','HIGH',$2,0,$3)`,
      [id, M, adminId],
    );
    await pool.query(
      `INSERT INTO npi_verifications (submission_id, npi, status, claimed_name, claimed_state, claimed_specialty, claimed_type,
         claimed_first_name, claimed_last_name, registry_name, registry_taxonomy, registry_state, registry_type,
         registry_first_name, registry_last_name, registry_data, note, auto_status, override_note, override_by, override_at)
       VALUES ($1,'9'||$2,'MATCH',$2,$2,$2,'INDIVIDUAL',$2,$2,$2,$2,$2,'INDIVIDUAL',$2,$2,jsonb_build_object('n',$2::text),$2,
               'PARTIAL_MATCH',$2,$3,now())`,
      [id, M, adminId],
    );
    await pool.query(
      `INSERT INTO ims2_intake_queue (submission_id, intake_id, state, payload, payload_hash, sent_by, form, last_error)
       VALUES ($1,$2,'QUEUED',jsonb_build_object('i',$3::text),'h',$4,jsonb_build_object('f',$3::text),$3)`,
      [id, `intake-${id}`, M, adminId],
    );
    await pool.query(
      `INSERT INTO ims2_handoffs (submission_id, draft_id, state, payload, payload_hash, pushed_by, last_error)
       VALUES ($1,$2,'PENDING',jsonb_build_object('i',$3::text),'h',$4,$3)`,
      [id, `draft-${id}`, M, adminId],
    );
    await pool.query(`INSERT INTO chat_messages (submission_id, role, content) VALUES ($1,'user',$2)`, [id, M]);
    await pool.query(
      `INSERT INTO injection_flags (submission_id, category, pattern, excerpt) VALUES ($1,'override',$2,$2)`,
      [id, M],
    );
    await pool.query(
      `INSERT INTO single_rating (submission_id, version, title, description, status, rate_group, context_version, location,
         county, zipcode, city, inputs)
       VALUES ($1,1,$2,$2,'INCOMPLETE','rg',0,$2,$2,$2,$2,jsonb_build_object('name',$2::text))`,
      [id, M],
    );
    await pool.query(`INSERT INTO system_errors (scope, message) VALUES ($1, 'could not read '||$2)`, [
      `process:${id}`,
      M,
    ]);
    await pool.query(
      `INSERT INTO gmail_ingest_queue (gmail_message_id, source, attempts, last_error) VALUES ($1,'OAUTH',1,'failed '||$2)`,
      [gmailId, M],
    );
    await pool.query(
      `INSERT INTO skipped_emails (gmail_message_id, from_address, subject, received_at, confidence, reasons, method, skipped_at)
       VALUES ($1,$2||'@spam.com','Hi '||$2,$3,0.9,ARRAY['about '||$2],'RULES',$3)`,
      [skippedId, M, old],
    );
    expect((await columnsHolding(M)).length).toBeGreaterThan(40);

    const counts = await retention.runRetention();
    expect(counts.submissionsScrubbed).toBeGreaterThanOrEqual(1);
    expect(counts.skippedEmails).toBe(1);

    expect(await columnsHolding(M)).toEqual([]);
    // The local file is gone and marked; the skipped email is hidden but its row still blocks a re-import.
    await expect(stat(path.join(localRoot, `${id}.pdf`))).rejects.toThrow();
    expect(
      (await pool.query('SELECT file_purged_at FROM documents WHERE id=$1', [doc.id])).rows[0].file_purged_at,
    ).not.toBeNull();
    const {
      rows: [skipped],
    } = await pool.query('SELECT deleted_at FROM skipped_emails WHERE gmail_message_id=$1', [skippedId]);
    expect(skipped.deleted_at).not.toBeNull();
    // The audit trail kept its events, with references only.
    const { rows: events } = await pool.query(
      `SELECT action, details FROM audit_events WHERE submission_id=$1 AND action IN ('MANUAL_FIELD_ADDED','TEST_PHI')`,
      [id],
    );
    expect(events.map((e) => e.action).sort()).toEqual(['MANUAL_FIELD_ADDED', 'TEST_PHI']);
    expect(events.find((e) => e.action === 'MANUAL_FIELD_ADDED')!.details).toMatchObject({
      fieldName: 'specialty',
      valueLength: M.length,
      hasNote: true,
    });
    expect(events.find((e) => e.action === 'TEST_PHI')!.details).toEqual({
      sharedAttachmentsCount: 1,
      npiLast4: '7893',
      from: '[REDACTED-EMAIL]',
    });
    delete process.env.STORAGE_PATH;
  });

  it('reports a legacy local file whose folder is missing instead of marking it purged', async () => {
    process.env.STORAGE_PATH = path.join(tmpdir(), `ims-missing-${Date.now()}`);
    try {
      const sub = await seedSubmission({ createdAt: daysAgo(45), deletedAt: daysAgo(45) });
      await pool.query(`UPDATE documents SET storage_backend='LOCAL', storage_key='a.pdf' WHERE id=$1`, [sub.docId]);
      await pool.query(`DELETE FROM system_errors WHERE scope='retention:files'`);
      await retention.runRetention();
      expect(
        (await pool.query('SELECT file_purged_at FROM documents WHERE id=$1', [sub.docId])).rows[0].file_purged_at,
      ).toBeNull();
      expect(await count(`system_errors WHERE scope='retention:files'`)).toBeGreaterThanOrEqual(1);
      await pool.query(`UPDATE documents SET file_purged_at=now() WHERE id=$1`, [sub.docId]); // out of later runs
    } finally {
      delete process.env.STORAGE_PATH;
    }
  });
});
