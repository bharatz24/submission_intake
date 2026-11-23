-- An underwriter's decision on a PARTIAL_MATCH. `status` holds the decision, so everything that reads it follows;
-- auto_status keeps what the registry check said and is set only while a decision stands.
ALTER TABLE npi_verifications
  ADD COLUMN auto_status   text,
  ADD COLUMN override_note text,
  ADD COLUMN override_by   uuid REFERENCES users(id),
  ADD COLUMN override_at   timestamptz,
  ADD CONSTRAINT npi_verifications_override_check CHECK (
    auto_status IS NULL
    OR (auto_status = 'PARTIAL_MATCH' AND status IN ('MATCH','MISMATCH')
        AND override_note IS NOT NULL AND override_by IS NOT NULL AND override_at IS NOT NULL));
