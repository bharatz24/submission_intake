-- Retention (services/retention.ts): a scrubbed submission's stored files are trashed in Drive after its PHI columns
-- are emptied. file_purged_at is set only once Drive confirmed the trash, so a failed trash is retried by the next
-- purge run (the Drive orphan sweep never sees these files: their document rows still exist).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_purged_at timestamptz;
