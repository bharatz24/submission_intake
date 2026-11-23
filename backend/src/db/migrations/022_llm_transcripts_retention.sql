-- LLM guardrails, phase 2 (docs/superpowers/specs/2026-11-17-llm-guardrails-design.md §4–5).
--
-- Transcripts (services/claude.ts): every Claude call records the SHA-256 of its system prompt and of the outbound
-- (already redacted) user content; the full prompt and raw output text are kept only for the tasks
-- LLM_STORE_TRANSCRIPTS covers (default: decision tasks). Deleted with their llm_calls row; purged by age
-- (services/retention.ts).
CREATE TABLE IF NOT EXISTS llm_transcripts (
  llm_call_id bigint PRIMARY KEY REFERENCES llm_calls(id) ON DELETE CASCADE,
  system_sha256 text NOT NULL,
  prompt_sha256 text NOT NULL,
  prompt text,
  output text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS llm_transcripts_created_idx ON llm_transcripts(created_at);

-- A report or chat answer points at the exact call (and transcript) that produced it. llm_calls.id is bigint
-- (001_schema.sql). SET NULL: a purged call leaves the decision row in place.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS llm_call_id bigint REFERENCES llm_calls(id) ON DELETE SET NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS llm_call_id bigint REFERENCES llm_calls(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS reports_llm_call_idx ON reports(llm_call_id);
CREATE INDEX IF NOT EXISTS chat_messages_llm_call_idx ON chat_messages(llm_call_id);

-- Retention (services/retention.ts): a deleted submission past its retention period is scrubbed of PHI, not deleted
-- (audit_events references it and is append-only); purged_at marks it done so it is never scrubbed twice.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS purged_at timestamptz;

-- Retention purges by age (llm_calls already has llm_calls_created_idx).
CREATE INDEX IF NOT EXISTS chat_messages_created_idx ON chat_messages(created_at);
