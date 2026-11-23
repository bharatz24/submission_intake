-- Retry from the failed step (services/pipeline.ts processLocked). `pipeline_progress` records the steps the last run
-- finished ({"completedSteps": [...], "failedStep": ..., "autoRetrying": ...}): a resumed run (POST
-- /submissions/:id/retry, Errors tab "Retry all", an automatic retry after a short-lived failure, recovery after a
-- crash) skips the finished ones; a full re-run clears it. Exposed as `pipeline` on the submission summary and detail.
-- `processing_error` now holds a plain-English message for underwriters; the raw error text goes to
-- `processing_error_detail` (exposed as `processingErrorDetail`, for admins).
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS pipeline_progress jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS processing_error_detail text;
