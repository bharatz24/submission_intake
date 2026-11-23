-- Constrain status columns to the values the application writes, and index hot foreign keys.

-- Mirrors STATUSES in routes/submissions.ts.
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check
  CHECK (status IN ('NEW','PROCESSING','READY_FOR_REVIEW','IN_REVIEW','COMPLETED','NOT_SUBMISSION','ERROR'));

-- PENDING plus ExtractionStatus in services/textExtraction.ts.
ALTER TABLE documents ADD CONSTRAINT documents_extraction_status_check
  CHECK (extraction_status IN ('PENDING','EXTRACTED','OCR_EXTRACTED','UNREADABLE','UNSUPPORTED','ERROR'));

-- Mirrors NpiStatus in services/npi.ts.
ALTER TABLE npi_verifications ADD CONSTRAINT npi_verifications_status_check
  CHECK (status IN ('MATCH','PARTIAL_MATCH','MISMATCH','NOT_FOUND','NOT_VERIFIED','ERROR'));

-- Chat history is read newest-first per submission.
CREATE INDEX chat_messages_submission_idx ON chat_messages(submission_id, created_at DESC);
-- Every submission list query joins emails on email_id.
CREATE INDEX submissions_email_idx ON submissions(email_id);
CREATE INDEX submissions_assigned_idx ON submissions(assigned_to) WHERE assigned_to IS NOT NULL;
