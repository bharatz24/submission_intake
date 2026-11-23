-- Deleting a skipped email (Ignored tab) hides it instead of removing the row: the row is what keeps polling,
-- reconciliation and imports from fetching and classifying the same Gmail message again (ingestQueue.enqueueMessages).
ALTER TABLE skipped_emails ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
ALTER TABLE skipped_emails ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id);
