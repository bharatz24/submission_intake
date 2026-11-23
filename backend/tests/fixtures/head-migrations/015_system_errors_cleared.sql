-- An admin can clear errors from Monitoring. Rows are kept, not deleted: reconciliation checks earlier rows so it
-- reports a problem only once (services/reconcile.ts).
ALTER TABLE system_errors
  ADD COLUMN cleared_at timestamptz,
  ADD COLUMN cleared_by uuid REFERENCES users(id);
CREATE INDEX system_errors_open_idx ON system_errors(id) WHERE cleared_at IS NULL;
