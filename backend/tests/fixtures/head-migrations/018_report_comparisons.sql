-- Version-to-version comparisons of one report kind (Synthesis vX vs vY, or Analysis vX vs vY; never across kinds).
-- field_diff is the deterministic field-level diff (services/reportDiff.ts); content_json is the skill's explanation of it.
-- base is always the lower version. A pair is computed once per skill version; failed runs may be retried.
CREATE TABLE report_comparisons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id    uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('SYNTHESIS','ANALYSIS')),
  base_report_id   uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  target_report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  status           text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  field_diff       jsonb NOT NULL,
  content_json     jsonb,
  content_markdown text,
  skill_name       text NOT NULL,
  skill_version    text NOT NULL,
  model            text NOT NULL,
  usage            jsonb,
  error            text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CHECK (base_report_id <> target_report_id)
);
CREATE UNIQUE INDEX report_comparisons_pair_idx ON report_comparisons (base_report_id, target_report_id, skill_version) WHERE status <> 'FAILED';
CREATE INDEX report_comparisons_submission_idx ON report_comparisons (submission_id, created_at DESC);

ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS llm_calls_task_check;
ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_task_check
  CHECK (task IN ('classification','extraction','synthesis','analysis','chat','comparison'));
