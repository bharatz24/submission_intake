-- DB-06 / DB-07 / DB-08: indexes for queries that otherwise scan whole tables.
-- Built inside the migrator's transaction like 020, 026 and 027 (CREATE INDEX CONCURRENTLY cannot run in one); each
-- briefly blocks writes to its table while it builds, so apply this release in a quiet window on a large database.
-- The migrator sets lock_timeout, so a busy table makes the migration fail and roll back instead of queueing writes.

-- Classification reads the thread's earlier emails on every ingest (pipeline.ts threadContext).
CREATE INDEX IF NOT EXISTS emails_thread_id_idx ON emails (thread_id) WHERE thread_id IS NOT NULL;

-- Audit trail filtered by action (Audit page, Monitoring's duplicate count over a period).
CREATE INDEX IF NOT EXISTS audit_action_created_idx ON audit_events (action, created_at DESC);

-- Monitoring counts over a period (monitoring.repository.ts pipelineCounts).
CREATE INDEX IF NOT EXISTS submissions_created_idx ON submissions (created_at);
CREATE INDEX IF NOT EXISTS reports_created_idx ON reports (created_at);
CREATE INDEX IF NOT EXISTS emails_created_idx ON emails (created_at);
