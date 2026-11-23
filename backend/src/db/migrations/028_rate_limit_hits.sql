-- API-01: rate-limit counters shared by every API instance (modules/shared/rateLimitStore.ts). Before this each
-- process counted in memory, so the limits multiplied by the number of instances and reset on every deploy.
-- One row per limiter key (prefix + client key): the hits in the current window and when the window ends. An expired
-- row is restarted by the next hit (atomic upsert) and deleted by a periodic sweep.
-- UNLOGGED: counters are cheap to lose (a crash or failover only restarts the windows), and skipping the WAL keeps a
-- write per API request light.
CREATE UNLOGGED TABLE IF NOT EXISTS rate_limit_hits (
    key text PRIMARY KEY,
    hits integer NOT NULL CHECK (hits >= 0),
    reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_reset_at_idx ON rate_limit_hits (reset_at);
