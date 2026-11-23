-- Cache writes with the 1-hour lifetime (claude.ts cacheTtl) cost 2x the input price, 5-minute ones 1.25x: the split
-- lets Monitoring estimate what prompt caching saved. cache_write_tokens keeps the total of both.
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cache_write_1h_tokens integer NOT NULL DEFAULT 0;
