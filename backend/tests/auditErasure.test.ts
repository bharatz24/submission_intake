/**
 * DB-01: audit_events stays append-only yet holds no applicant data, and a submission can be erased outright.
 * Real database (TEST_DATABASE_URL host); migration 030 is re-run on seeded old-style rows to check its redaction.
 */
import { readFileSync } from 'node:fs';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startTestApp, stopTestApp, testDatabaseUrl } from './helpers/apiTestDb.js';

vi.mock('../src/services/driveStorage.js', async (orig) =>
  (await import('./helpers/fakeDrive.js')).fakeDrive(await orig()),
);

const DB_NAME = `ims_test_audit_erasure${process.env.TEST_DB_SUFFIX ?? ''}`;
process.env.DATABASE_URL = testDatabaseUrl(DB_NAME);

let pool: pg.Pool;

beforeAll(async () => {
  ({ pool } = await startTestApp(DB_NAME));
});

afterAll(stopTestApp);

async function seedSubmission(): Promise<string> {
  const {
    rows: [email],
  } = await pool.query(
    `INSERT INTO emails (from_address, subject, received_at) VALUES ('a@b.com','s',now()) RETURNING id`,
  );
  const {
    rows: [sub],
  } = await pool.query(`INSERT INTO submissions (email_id, status) VALUES ($1,'NEW') RETURNING id`, [email.id]);
  return sub.id as string;
}

const insertEvent = (submissionId: string | null, action: string, details: unknown) =>
  pool.query<{ id: string }>(
    `INSERT INTO audit_events (submission_id, actor_type, action, entity_type, details) VALUES ($1,'SYSTEM',$2,'submission',$3)
     RETURNING id`,
    [submissionId, action, JSON.stringify(details)],
  );

describe('audit_events immutability and erasure', () => {
  it('still rejects updates and deletes', async () => {
    const id = await seedSubmission();
    const {
      rows: [ev],
    } = await insertEvent(id, 'X', { a: 1 });
    await expect(pool.query(`UPDATE audit_events SET details='{}' WHERE id=$1`, [ev!.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query(`DELETE FROM audit_events WHERE id=$1`, [ev!.id])).rejects.toThrow(/append-only/);
    // Unlinking is refused while the submission exists.
    await expect(pool.query(`UPDATE audit_events SET submission_id=NULL WHERE id=$1`, [ev!.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
  });

  it('lets a submission be hard-deleted: its events stay, unlinked', async () => {
    const id = await seedSubmission();
    await insertEvent(id, 'SUBMISSION_DELETED', { reason: 'x' });
    await insertEvent(id, 'REPORT_GENERATED', { version: 1 });
    await pool.query('DELETE FROM submissions WHERE id=$1', [id]);
    const { rows } = await pool.query(
      `SELECT submission_id, action, details FROM audit_events WHERE action IN ('SUBMISSION_DELETED','REPORT_GENERATED')
       ORDER BY id`,
    );
    expect(rows).toEqual([
      { submission_id: null, action: 'SUBMISSION_DELETED', details: { reason: 'x' } },
      { submission_id: null, action: 'REPORT_GENERATED', details: { version: 1 } },
    ]);
  });
});

describe('030_audit_phi_redaction.sql on events written before it', () => {
  it('strips values, notes, file names, subjects, duplicate evidence and raw errors, keeping the references', async () => {
    const id = await seedSubmission();
    const ids = {
      added: (
        await insertEvent(id, 'MANUAL_FIELD_ADDED', { fieldName: 'npi', value: 'Jane', note: 'Jane', documentId: null })
      ).rows[0]!.id,
      updated: (
        await insertEvent(id, 'MANUAL_FIELD_UPDATED', {
          fieldName: 'name',
          from: { value: 'Jane', note: 'n', documentId: null },
          to: { value: 'Joan', note: null, documentId: null },
        })
      ).rows[0]!.id,
      dup: (
        await insertEvent(id, 'DUPLICATE_DETECTED', {
          rule: 'R5',
          strength: 'HIGH',
          sharedAttachments: ['Jane.pdf', 'b.pdf'],
          explanation: 'Jane',
          addedWords: ['jane'],
          originalSubject: 'Jane',
          outcome: 'DUPLICATE',
        })
      ).rows[0]!.id,
      cleared: (
        await insertEvent(id, 'DUPLICATE_CLEARED', {
          previousBasis: { rule: 'R1', explanation: 'Jane' },
          outcome: 'CLASSIFY',
        })
      ).rows[0]!.id,
      doc: (await insertEvent(id, 'DOCUMENT_VIEWED', { filename: 'Jane.pdf' })).rows[0]!.id,
      npi: (await insertEvent(id, 'NPI_MATCH_OVERRIDDEN', { npi: '1234567893', from: 'PARTIAL_MATCH', note: 'Jane' }))
        .rows[0]!.id,
      search: (await insertEvent(id, 'NPI_SEARCHED', { query: { last_name: 'Jane' }, candidates: 2 })).rows[0]!.id,
      email: (await insertEvent(id, 'EMAIL_RECEIVED', { from: 'jane@x.com', subject: 'Jane', attachments: 2, gaps: 0 }))
        .rows[0]!.id,
      failed: (await insertEvent(id, 'PROCESSING_FAILED', { error: 'Error: Jane.pdf unreadable', step: 'fields' }))
        .rows[0]!.id,
      other: (await insertEvent(id, 'SKILL_UPDATED', { note: 'tuned', skill: 'synthesis' })).rows[0]!.id,
    };

    const sql = readFileSync(new URL('../src/db/migrations/030_audit_phi_redaction.sql', import.meta.url), 'utf8');
    await pool.query(sql);

    const { rows } = await pool.query<{ id: string; details: Record<string, unknown> }>(
      'SELECT id, details FROM audit_events WHERE id = ANY($1)',
      [Object.values(ids)],
    );
    const by = (k: keyof typeof ids) => rows.find((r) => r.id === ids[k])!.details;
    expect(by('added')).toEqual({ fieldName: 'npi', documentId: null });
    expect(by('updated')).toEqual({ fieldName: 'name', from: { documentId: null }, to: { documentId: null } });
    expect(by('dup')).toEqual({
      rule: 'R5',
      strength: 'HIGH',
      sharedAttachmentsCount: 2,
      addedWordsCount: 1,
      outcome: 'DUPLICATE',
    });
    expect(by('cleared')).toEqual({ previousBasis: { rule: 'R1' }, outcome: 'CLASSIFY' });
    expect(by('doc')).toEqual({});
    expect(by('npi')).toEqual({ npiLast4: '7893', from: 'PARTIAL_MATCH' });
    expect(by('search')).toEqual({ candidates: 2 });
    expect(by('email')).toEqual({ attachments: 2, gaps: 0 });
    expect(by('failed')).toEqual({ error: '[redacted]', step: 'fields' });
    expect(by('other')).toEqual({ note: 'tuned', skill: 'synthesis' });
    expect(JSON.stringify(rows)).not.toMatch(/jane/i);

    // The trigger is back on afterwards.
    await expect(pool.query(`UPDATE audit_events SET details='{}' WHERE id=$1`, [ids.other])).rejects.toThrow(
      /append-only/,
    );
  });
});
