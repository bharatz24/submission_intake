-- PERF-07: a Gmail message that fails to ingest INGEST_MAX_ATTEMPTS times is parked (dead letter) instead of being
-- retried every 6 hours forever (services/ingestQueue.ts). A parked row is never claimed by the drain; it stays on the
-- Errors tab, and a manual retry (one message, or "Retry now") clears parked_at and makes it due again.
ALTER TABLE gmail_ingest_queue ADD COLUMN IF NOT EXISTS parked_at timestamptz;
-- The drain claims due, unparked rows oldest first.
CREATE INDEX IF NOT EXISTS gmail_ingest_queue_due_idx ON gmail_ingest_queue (next_attempt_at) WHERE parked_at IS NULL;
