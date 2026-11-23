import { rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { RETENTION_BATCH } from '../constants.js';
import { pool, withTransaction } from '../db/pool.js';
import { logger } from '../logger.js';
import { audit, recordSystemError } from './audit.js';
import { type RetentionSettings, retentionSettings } from './retentionSettings.js';
import { trashStoredFile } from './storage.js';

/**
 * The daily retention purge (spec §5), run by services/reconcile.ts. Periods come from Settings → Retention; a null
 * period keeps that data forever (the default), so with nothing set this deletes nothing.
 * - llm_transcripts, llm_calls and chat_messages older than their period are deleted in batches.
 * - A submission deleted longer ago than deletedSubmissionsDays is scrubbed, not deleted: the row, its ids, statuses
 *   and audit history stay while every free-text PHI column is emptied (SCRUB_STATEMENTS; tests/retention.test.ts
 *   checks every text and jsonb column of the database for a seeded marker) and its stored files are trashed.
 *   purged_at marks it done; documents.file_purged_at marks each file confirmed removed, so a failed one is retried.
 * - Emails skipped at intake (Ignored tab) older than skippedEmailsDays lose their sender, subject and reasons. The
 *   row itself stays (hidden): it is what stops polling and imports from classifying that Gmail message again.
 * One failing submission or file never stops the others: it is recorded on Monitoring (system errors) and skipped.
 * Active submissions are never touched. audit_events holds no applicant data (services/audit.ts sanitizes every
 * event), so it is never rewritten; a submission erased outright is unlinked from it (docs/data-retention.md).
 */

export interface PurgeCounts {
  llmTranscripts: number;
  llmCalls: number;
  chatMessages: number;
  submissionsScrubbed: number;
  skippedEmails: number;
}

const DAY_MS = 86_400_000;

/** The tables purged by age; fixed here so no table or column name ever comes from input. */
const BY_AGE = {
  llmTranscripts: { table: 'llm_transcripts', setting: 'llmTranscriptsDays' },
  llmCalls: { table: 'llm_calls', setting: 'llmCallsDays' },
  chatMessages: { table: 'chat_messages', setting: 'chatDays' },
} as const satisfies Record<string, { table: string; setting: keyof RetentionSettings }>;

/** Deletes rows created before `cutoff`, RETENTION_BATCH at a time, so no statement holds its locks for long. */
async function deleteOlderThan(table: string, cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE created_at < $1 LIMIT ${RETENTION_BATCH})`,
      [cutoff],
    );
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < RETENTION_BATCH) return total;
  }
}

/**
 * Every free-text PHI column of one submission, emptied in the caller's transaction. NOT NULL text columns become ''
 * (NOT NULL jsonb '{}' or '[]'), nullable ones NULL; filenames become `purged-<id>`. Numbers, ids, statuses and
 * timestamps stay, so the skeleton and its audit history still make sense.
 */
const SCRUB_STATEMENTS = [
  // Before the email: its Gmail id finds the ingest queue row, whose last error may quote the message.
  `UPDATE gmail_ingest_queue SET last_error=NULL
   WHERE last_error IS NOT NULL
     AND gmail_message_id=(SELECT e.gmail_message_id FROM emails e JOIN submissions s ON s.email_id=e.id WHERE s.id=$1)`,
  // The email is left alone only while another submission that is not deleted still points at it.
  `UPDATE emails SET body_text='', snippet='', subject='', from_address='', to_address='', cc_address=NULL
   WHERE id=(SELECT email_id FROM submissions WHERE id=$1)
     AND NOT EXISTS (SELECT 1 FROM submissions o WHERE o.email_id=emails.id AND o.id<>$1 AND o.deleted_at IS NULL)`,
  // duplicate_basis keeps its rule, strength and ids; the evidence (file names, words, explanation, reason) goes.
  `UPDATE submissions SET applicant_name=NULL, applicant_type=NULL, applicant_first_name=NULL, applicant_last_name=NULL,
     applicant_entity_name=NULL, normalized_subject=NULL, processing_error=NULL, processing_error_detail=NULL,
     classification_reasons='{}',
     duplicate_basis=duplicate_basis - ARRAY['sharedAttachments','explanation','addedWords','removedWords','reason','by']
   WHERE id=$1`,
  `UPDATE documents SET extracted_text='', filename='purged-' || id::text WHERE submission_id=$1`,
  `UPDATE attachment_gaps SET filename='purged-' || id::text, detail=NULL WHERE submission_id=$1`,
  `UPDATE extracted_fields SET value='', evidence_quote=NULL, source_label='purged' WHERE submission_id=$1`,
  `UPDATE manual_fields SET value='', note=NULL WHERE submission_id=$1`,
  `UPDATE reports SET content_json=NULL, content_markdown=NULL, grounding=NULL, error=NULL WHERE submission_id=$1`,
  `UPDATE report_comparisons SET content_json=NULL, content_markdown=NULL, field_diff='[]'::jsonb, error=NULL
   WHERE submission_id=$1`,
  `UPDATE outbound_emails SET subject='', body='', to_addresses='{}', cc_addresses='{}', bcc_addresses='{}', error=NULL
   WHERE submission_id=$1`,
  `UPDATE assessments SET notes='' WHERE submission_id=$1`,
  // A PARTIAL_MATCH override must keep a (now empty) note: npi_verifications_override_check.
  // The NPI itself identifies the applicant too (unique per submission, so each gets its own placeholder), and the
  // registry's copy of their record goes with it.
  `UPDATE npi_verifications SET npi='purged-' || id::text, claimed_name=NULL, claimed_first_name=NULL,
     claimed_last_name=NULL, claimed_entity_name=NULL, claimed_state=NULL, claimed_specialty=NULL,
     registry_name=NULL, registry_first_name=NULL, registry_last_name=NULL, registry_entity_name=NULL,
     registry_data=NULL, registry_state=NULL, registry_taxonomy=NULL,
     note=NULL, override_note=CASE WHEN override_note IS NULL THEN NULL ELSE '' END
   WHERE submission_id=$1`,
  // Quotes: the rating inputs and the practice location (premium figures and factors stay).
  `UPDATE single_rating SET inputs='{}'::jsonb, title=NULL, description=NULL, location=NULL, county=NULL, zipcode=NULL,
     city=NULL
   WHERE submission_id=$1`,
  `UPDATE ims2_intake_queue SET payload='{}'::jsonb, form=NULL, last_error=NULL, remote_status=NULL, rejected_reason=NULL
   WHERE submission_id=$1`,
  `UPDATE ims2_handoffs SET payload='{}'::jsonb, last_error=NULL, remote_status=NULL WHERE submission_id=$1`,
  `DELETE FROM chat_messages WHERE submission_id=$1`,
  `DELETE FROM email_drafts WHERE submission_id=$1`,
  `DELETE FROM injection_flags WHERE submission_id=$1`,
  // The calls' rows (no PHI) stay for Monitoring; what they sent and received goes.
  `DELETE FROM llm_transcripts WHERE llm_call_id IN (SELECT id FROM llm_calls WHERE submission_id=$1)`,
  `UPDATE llm_calls SET error=NULL WHERE submission_id=$1 AND error IS NOT NULL`,
  // Errors recorded against this submission (scopes in pipeline.ts and below) may quote it.
  `UPDATE system_errors SET message='[purged with the submission]'
   WHERE scope IN ('process:' || $1::text, 'retention:scrub:' || $1::text)`,
  `UPDATE submissions SET purged_at=now() WHERE id=$1`,
];

export interface FileTrashResult {
  trashed: number;
  failed: number;
}

/**
 * Files written before attachments moved to Drive (storage_backend 'LOCAL') live under the old STORAGE_PATH (default
 * ./uploads), which nothing else reads any more. Removed there; a missing folder is a failure (the files may be
 * elsewhere), so the operator is told on Monitoring instead of the file being marked purged.
 */
async function removeLegacyLocalFile(storageKey: string): Promise<void> {
  const root = path.resolve(process.env.STORAGE_PATH || './uploads');
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) throw new Error('storage key points outside the local storage folder');
  await stat(root);
  await rm(full, { force: true });
}

/**
 * Removes the stored files of purged submissions (one submission, or all) not yet confirmed removed: Drive files go to
 * the Drive trash, legacy local files are deleted. A file is marked file_purged_at only after that succeeded; a
 * failure is counted, recorded on Monitoring and left for the next run.
 */
export async function trashPurgedFiles(submissionId: string | null = null): Promise<FileTrashResult> {
  const { rows } = await pool.query<{ id: string; storage_key: string; storage_backend: string }>(
    `SELECT d.id, d.storage_key, d.storage_backend FROM documents d JOIN submissions s ON s.id=d.submission_id
     WHERE s.purged_at IS NOT NULL AND d.file_purged_at IS NULL
       AND ($1::uuid IS NULL OR s.id=$1)
     ORDER BY d.id`,
    [submissionId],
  );
  const result: FileTrashResult = { trashed: 0, failed: 0 };
  for (const d of rows) {
    try {
      if (d.storage_backend === 'LOCAL') await removeLegacyLocalFile(d.storage_key);
      else await trashStoredFile({ documentId: d.id, storageKey: d.storage_key });
      await pool.query('UPDATE documents SET file_purged_at=now() WHERE id=$1', [d.id]);
      result.trashed++;
    } catch (err) {
      result.failed++;
      logger.warn({ err, documentId: d.id }, 'retention could not trash a stored file; the next run retries it');
    }
  }
  if (result.failed)
    await recordSystemError(
      'retention:files',
      `${result.failed} stored file(s) of purged submissions could not be moved to the Drive trash (or, for files stored on local disk before Drive, deleted from STORAGE_PATH); the next daily purge retries them`,
    );
  return result;
}

/**
 * Empties a deleted submission's PHI in one transaction (SCRUB_STATEMENTS), then trashes its stored files
 * (trashPurgedFiles). True when it was scrubbed now; false for a submission that is not deleted or already purged.
 */
export async function scrubSubmission(submissionId: string): Promise<boolean> {
  const scrubbed = await withTransaction(async (tx) => {
    const { rowCount } = await tx.query(
      'SELECT 1 FROM submissions WHERE id=$1 AND deleted_at IS NOT NULL AND purged_at IS NULL FOR UPDATE',
      [submissionId],
    );
    if (!rowCount) return false;
    for (const sql of SCRUB_STATEMENTS) await tx.query(sql, [submissionId]);
    return true;
  });
  if (scrubbed) await trashPurgedFiles(submissionId);
  return scrubbed;
}

/**
 * Skipped emails stored (skipped_at) before `cutoff`: sender, subject and classifier reasons emptied, and the row
 * hidden from the Ignored tab (deleted_at), RETENTION_BATCH at a time. The row stays so the message is never fetched and classified
 * again; its Gmail ids are opaque. Returns how many were scrubbed.
 */
async function scrubSkippedEmails(cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `UPDATE skipped_emails SET from_address='', subject='', reasons='{}', deleted_at=COALESCE(deleted_at, now())
       WHERE gmail_message_id IN (
         SELECT gmail_message_id FROM skipped_emails
         WHERE skipped_at < $1 AND (from_address <> '' OR subject <> '' OR reasons <> '{}')
         LIMIT ${RETENTION_BATCH})`,
      [cutoff],
    );
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < RETENTION_BATCH) return total;
  }
}

/** One purge run as of `now`; audits RETENTION_PURGE with the counts when anything was removed. */
export async function runRetention(now: Date = new Date()): Promise<PurgeCounts> {
  const settings = await retentionSettings();
  const cutoff = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const counts: PurgeCounts = {
    llmTranscripts: 0,
    llmCalls: 0,
    chatMessages: 0,
    submissionsScrubbed: 0,
    skippedEmails: 0,
  };

  for (const [key, { table, setting }] of Object.entries(BY_AGE) as [
    keyof typeof BY_AGE,
    (typeof BY_AGE)[keyof typeof BY_AGE],
  ][]) {
    const days = settings[setting];
    if (days !== null) counts[key] = await deleteOlderThan(table, cutoff(days));
  }

  if (settings.skippedEmailsDays !== null)
    counts.skippedEmails = await scrubSkippedEmails(cutoff(settings.skippedEmailsDays));

  // Files an earlier run could not trash, whatever the settings are now.
  const retried = await trashPurgedFiles();

  const days = settings.deletedSubmissionsDays;
  let failedScrubs = 0;
  if (days !== null) {
    // Keyset paging: a submission that fails stays unpurged and is passed over, so neither a failure nor a full batch
    // of them can stall the run or block the ones after it. The next run tries the failed ones again.
    // deleted_at travels as text: a JS Date would drop the microseconds and re-select the last row of the page.
    let after = null as { deletedAt: string; id: string } | null;
    for (;;) {
      const { rows }: { rows: { id: string; deleted_at: string }[] } = await pool.query(
        `SELECT id, deleted_at::text AS deleted_at FROM submissions
         WHERE deleted_at < $1 AND purged_at IS NULL
           AND ($2::timestamptz IS NULL OR (deleted_at, id) > ($2::timestamptz, $3::uuid))
         ORDER BY deleted_at, id LIMIT ${RETENTION_BATCH}`,
        [cutoff(days), after?.deletedAt ?? null, after?.id ?? null],
      );
      for (const { id } of rows) {
        try {
          if (await scrubSubmission(id)) counts.submissionsScrubbed++;
        } catch (err) {
          failedScrubs++;
          logger.error({ err, submissionId: id }, 'retention could not scrub a deleted submission');
          await recordSystemError(`retention:scrub:${id}`, err);
        }
      }
      const last = rows.at(-1);
      if (!last || rows.length < RETENTION_BATCH) break;
      after = { deletedAt: last.deleted_at, id: last.id };
    }
  }

  if (Object.values(counts).some((n) => n > 0) || retried.trashed > 0) {
    logger.info({ counts, filesRetried: retried, failedScrubs }, 'retention purge removed data');
    await audit({
      action: 'RETENTION_PURGE',
      entityType: 'retention',
      actorId: null,
      details: { counts, filesRetried: retried, failedScrubs, settings },
    });
  }
  return counts;
}
