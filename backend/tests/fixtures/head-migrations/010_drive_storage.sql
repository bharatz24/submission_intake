-- Attachments live in Google Drive (services/driveStorage.ts). storage_key is the Drive file ID when
-- storage_backend='GDRIVE'; LOCAL rows are pre-Drive files until scripts/drive-migrate moves them.
ALTER TABLE documents
  ADD COLUMN storage_backend text NOT NULL DEFAULT 'LOCAL' CHECK (storage_backend IN ('LOCAL','GDRIVE'));
CREATE UNIQUE INDEX documents_drive_file_idx ON documents(storage_key) WHERE storage_backend = 'GDRIVE';

ALTER TABLE submissions ADD COLUMN drive_folder_id text;

-- Gmail messages seen but not yet ingested. A row is deleted only once the email and all its attachments are stored.
CREATE TABLE gmail_ingest_queue (
  gmail_message_id text PRIMARY KEY,
  source           text NOT NULL CHECK (source IN ('OAUTH','MCP')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  alerted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gmail_ingest_queue_due_idx ON gmail_ingest_queue(next_attempt_at);

-- Attachments that could not be stored for a reason retrying cannot fix. Shown on the submission; never silent.
CREATE TABLE attachment_gaps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  mime_type     text,
  size_bytes    bigint,
  reason        text NOT NULL CHECK (reason IN ('TOO_LARGE','NO_CONTENT','LINKED_FILE')),
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_gaps_submission_idx ON attachment_gaps(submission_id);
