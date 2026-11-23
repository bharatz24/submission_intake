# Data retention

What the application keeps, for how long, and how it is removed. Replaces the 2026-11-16 note that said nothing was
ever purged (audit findings DB-01, DB-02, DB-03 / DOC-01).

## The daily purge (Settings → Data retention)

A daily job (`backend/src/services/retention.ts`, scheduled by `services/reconcile.ts`, first run a few minutes after
start, one instance at a time) applies the periods an admin sets in **Settings → Data retention**. Each period is a
whole number of days between 30 and 3650, or empty. **Empty means keep forever, and every period is empty by
default**, so a new installation purges nothing until an admin sets one. Every run that removes anything writes one
`RETENTION_PURGE` audit event with the counts and the settings used; failures are shown on Monitoring → Errors.

| Setting (Settings → Data retention) | What happens after the period                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude transcripts                  | `llm_transcripts` rows (full prompts and outputs) are deleted.                                                                                                                                                                                                                                   |
| Claude request records              | `llm_calls` rows (token usage on Monitoring, with their error text) are deleted, and their transcripts with them.                                                                                                                                                                                |
| Chat messages                       | `chat_messages` rows are deleted.                                                                                                                                                                                                                                                                |
| Deleted submissions                 | A submission deleted (Delete in the workspace sets `deleted_at`) longer ago than this is **scrubbed**: every free-text column that can hold applicant data is emptied and its stored files are removed. See below.                                                                               |
| Ignored emails                      | Emails skipped at intake (`skipped_emails`, the Ignored tab) lose their sender, subject and classifier reasons and leave the Ignored tab. The row itself stays: it is what stops polling, reconciliation and imports from fetching and classifying that Gmail message again. Its ids are opaque. |

### What scrubbing a deleted submission removes

The submission row, its ids, statuses, numbers and timestamps stay (so counts, Monitoring and the audit trail still
make sense); `submissions.purged_at` records when it was scrubbed. In one transaction per submission:

- **Email**: body, snippet, subject, from/to/cc (unless another live submission shares the email).
- **Submission**: applicant name parts, normalized subject, processing error text, classifier reasons, and the evidence
  in `duplicate_basis` (shared file names, added/removed words, explanation, reason; rule and strength stay).
- **Documents and attachment gaps**: extracted text; file names become `purged-<id>`; link details.
- **Fields**: extracted values and evidence quotes; manual values and notes.
- **Reports, comparisons, assessments**: content, markdown, grounding, error text, notes.
- **NPI checks**: the NPI itself (becomes `purged-<id>`), claimed name/state/specialty, the registry's copy of the
  record (names, state, taxonomy, raw data), notes.
- **Quotes** (`single_rating`): rating inputs, title, description, location, ZIP, city, county. Premiums and factors stay.
- **IMS 2 queue and hand-offs**: payloads, forms, error text.
- **Outbound emails**: subject, body, recipients, error text.
- **Deleted outright**: chat messages, email drafts, injection flags, Claude transcripts of its calls.
- **Error text**: `llm_calls.error` of its Claude calls, the Gmail ingest queue's `last_error` for its message, and
  Monitoring errors recorded against it (`process:<id>`, `retention:scrub:<id>`).
- **Files**: Drive files are moved to the Drive trash (Drive empties its trash after 30 days). Files stored on local
  disk before attachments moved to Drive (`storage_backend = 'LOCAL'`) are deleted from the old `STORAGE_PATH`
  (default `./uploads`); if that folder does not exist the file is left unmarked and reported on Monitoring, so set
  `STORAGE_PATH` to where those files are, or remove them by hand. `documents.file_purged_at` is set only once a file
  is confirmed removed; a failure is retried on the next run.

`backend/tests/retention.test.ts` seeds a unique marker into every one of these columns, runs the purge and then
searches **every text, jsonb and text[] column of every table** for it; a new column that can hold applicant data
fails that test until the scrub covers it.

### Kept without a period

| Data                                          | Kept                                                          | Notes                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Live (not deleted) submissions and their data | Until deleted, then per "Deleted submissions"                 | Delete hides a submission at once; scrubbing follows after the period.                          |
| Audit trail (`audit_events`)                  | Indefinitely                                                  | Append-only, and holds no applicant data (below).                                               |
| NPI registry cache (`npi_registry_cache`)     | One row per NPI looked up, reused for 24 h (1 h if not found) | Overwritten on the next lookup. Public CMS data, no submission content.                         |
| Finished background jobs (`jobs`)             | `JOB_RETENTION_DAYS` (default 7)                              | Pruned by the job queue. Ids and payloads, no documents.                                        |
| Backups                                       | Per your backup policy                                        | A backup taken before a purge still holds the purged data: expire backups on the same schedule. |

## The audit trail holds references, not applicant data

`audit_events` is append-only (database triggers reject UPDATE, DELETE and TRUNCATE) and is never purged, so it must
not hold anything the purge would have to remove. Since migration `030_audit_phi_redaction.sql`:

- Events record references: ids, field names, value lengths, whether a note was given, statuses, counts, the last four
  digits of an NPI (`npiLast4`). Not field values, notes, file names, email subjects or senders, duplicate evidence,
  NPI search terms or raw error text.
- `services/audit.ts` enforces this for every event, whatever the caller passes: keys that carry applicant content
  (`value`, `filename`, `subject`, `originalSubject`, `sharedAttachments`, `addedWords`, `removedWords`, `explanation`,
  `claimedName`, ...) are dropped (a list becomes `<key>Count`), `npi` becomes `npiLast4`, and every other string is
  passed through `scrubText` (emails, phone numbers, NPIs, SSNs, labelled dates of birth). Staff emails under the key
  `email` (user administration, the connected mailbox) are kept.
- The migration rewrote the events recorded before that, once, with the same rules (the trigger is disabled for that
  one transaction only). Error text of processing failures and document reads became `[redacted]`.

Free text a person types as a _reason_ (marking a duplicate, a skill edit note) is scrubbed of emails, phones and
numbers but otherwise kept; do not put applicant data there.

## Erasing a submission outright (deletion request)

The purge scrubs; it never deletes rows. To erase a submission completely (a regulatory or contractual deletion
request), run in `psql` as the database owner, in one transaction:

```sql
BEGIN;
-- 1. Copies held as duplicates of it point at it (submissions.duplicate_of has no ON DELETE): erase them the same way
--    first, or release them: UPDATE submissions SET duplicate_of=NULL, status='NEW' WHERE duplicate_of='<id>';
SELECT id FROM submissions WHERE duplicate_of = '<id>';
-- 2. Remember its email, then delete the submission. Every child table cascades (documents, fields, reports, NPI
--    checks, quotes, chat, ...); llm_calls and audit_events keep their rows with submission_id set to NULL.
SELECT email_id FROM submissions WHERE id = '<id>';
DELETE FROM submissions WHERE id = '<id>';
-- 3. The email, unless another submission still uses it.
DELETE FROM emails e WHERE e.id = '<email_id>' AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.email_id = e.id);
COMMIT;
```

Before step 2, trash its Drive files: the purge does that for a deleted submission (Delete it in the app, then wait
for the period or scrub it at once from a Node shell with `scrubSubmission(id)` in `services/retention.ts`), or
remove the files in Drive by hand (the folder id is `submissions.drive_folder_id`). Record the erasure in your
deletion-request log; the audit trail keeps its events for that submission without the link to it.

The append-only trigger allows exactly this: an UPDATE that only sets `submission_id` to NULL, and only once that
submission no longer exists (the foreign key's `ON DELETE SET NULL`). Any other change to `audit_events` still fails.

## Consequences

- Until an admin sets periods, the database and the Drive folder grow without bound. Size storage and backups for it
  (`docs/deploy.md` → Sizing).
- Backups contain all PHI/PII received since the oldest backup kept. Encrypt them, restrict access as for the live
  database, and expire them in line with the periods above.
