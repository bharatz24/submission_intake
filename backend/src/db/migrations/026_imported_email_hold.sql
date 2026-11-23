-- Emails brought in by Settings > Import older email are classified when they arrive, but nothing else runs on them
-- (no document reading, extraction, NPI checks or reports) until a person presses Process. The queue row remembers
-- that the message came from an import; the submission is then held with held_for_import until it is processed
-- (POST /submissions/:id/process, or "Process all" for every held one). Exposed as `heldForImport`.
ALTER TABLE gmail_ingest_queue ADD COLUMN IF NOT EXISTS imported boolean NOT NULL DEFAULT false;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS held_for_import boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS submissions_held_for_import_idx ON submissions (created_at) WHERE held_for_import AND deleted_at IS NULL;
