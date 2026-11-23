-- One verification result per (submission, NPI). Re-verification updates the row in place;
-- each run is still recorded in audit_log (NPI_VERIFIED).
DELETE FROM npi_verifications n
USING npi_verifications newer
WHERE n.submission_id = newer.submission_id
  AND n.npi = newer.npi
  AND (n.verified_at, n.id) < (newer.verified_at, newer.id);

CREATE UNIQUE INDEX npi_submission_npi_uniq ON npi_verifications(submission_id, npi);
