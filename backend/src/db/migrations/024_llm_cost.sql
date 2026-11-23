-- Cost controls (services/llmUsage.ts): the estimated USD cost of each Claude call, computed at insert from its token
-- counts and MODEL_PRICES; NULL for a model without a known price and for calls recorded before this migration.
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cost_usd numeric(12,6);

-- The per-submission rolling-24h budget (LLM_SUBMISSION_DAILY_TOKEN_BUDGET) and Monitoring's top submissions by cost.
CREATE INDEX IF NOT EXISTS llm_calls_submission_created_idx ON llm_calls (submission_id, created_at);
