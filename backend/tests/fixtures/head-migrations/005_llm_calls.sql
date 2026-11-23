-- One row per Claude API request, for token-usage monitoring. Written best-effort by services/llmUsage.ts;
-- task values mirror Task in services/claude.ts;
-- token columns mirror the API's usage block (input_tokens excludes cache reads/writes).
CREATE TABLE llm_calls (
  id                 bigserial PRIMARY KEY,
  submission_id      uuid REFERENCES submissions(id) ON DELETE SET NULL,
  task               text NOT NULL CHECK (task IN ('classification','extraction','synthesis','analysis','chat')),
  skill_name         text NOT NULL,
  skill_version      text NOT NULL,
  model              text NOT NULL,
  status             text NOT NULL CHECK (status IN ('SUCCESS','REFUSED','TRUNCATED','INVALID_OUTPUT','ERROR')),
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  duration_ms        integer NOT NULL,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_created_idx ON llm_calls(created_at DESC);
CREATE INDEX llm_calls_submission_idx ON llm_calls(submission_id);
