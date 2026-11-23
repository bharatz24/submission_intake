-- Ignored emails an admin deleted. The rows stay: audit_events is append-only and points at them, the Gmail message id
-- keeps the email from being imported again, and duplicate detection still recognises repeats of them.
ALTER TABLE submissions
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id);
CREATE INDEX submissions_live_idx ON submissions (status) WHERE deleted_at IS NULL;
