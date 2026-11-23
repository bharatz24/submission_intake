-- Content duplicate detection (services/duplicates.ts). A duplicate is held back with status DUPLICATE
-- and points at the original, non-duplicate submission; it is never classified or processed until a person releases it.

-- RFC 822 Message-ID: the same message reaching two aliases or mailboxes.
ALTER TABLE emails ADD COLUMN rfc_message_id text;
CREATE INDEX emails_rfc_message_id_idx ON emails(rfc_message_id) WHERE rfc_message_id IS NOT NULL;

ALTER TABLE submissions
  ADD COLUMN duplicate_of           uuid REFERENCES submissions(id),
  ADD COLUMN duplicate_basis        jsonb,
  ADD COLUMN content_fingerprint    text,
  ADD COLUMN attachment_fingerprint text,
  ADD COLUMN normalized_subject     text,
  ADD CONSTRAINT submissions_duplicate_not_self CHECK (duplicate_of <> id),
  ADD CONSTRAINT submissions_duplicate_status CHECK ((status = 'DUPLICATE') = (duplicate_of IS NOT NULL));

-- Mirrors STATUSES in routes/submissions.ts.
ALTER TABLE submissions DROP CONSTRAINT submissions_status_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check
  CHECK (status IN ('NEW','PROCESSING','READY_FOR_REVIEW','IN_REVIEW','COMPLETED','NOT_SUBMISSION','DUPLICATE','ERROR'));

CREATE INDEX submissions_content_fp_idx    ON submissions(content_fingerprint);
CREATE INDEX submissions_attachment_fp_idx ON submissions(attachment_fingerprint) WHERE attachment_fingerprint IS NOT NULL;
CREATE INDEX submissions_norm_subject_idx  ON submissions(normalized_subject);
CREATE INDEX submissions_duplicate_of_idx  ON submissions(duplicate_of) WHERE duplicate_of IS NOT NULL;
-- Candidates sharing any attachment (subset matches, rule R5).
CREATE INDEX documents_sha256_idx ON documents(sha256);
