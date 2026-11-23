-- DB-16 / DB-17: keys and value checks the schema was missing.

-- Lookup tables without a primary key. Each already has a unique key over NOT NULL columns, so that key becomes the
-- primary key (same columns, same index; the unique constraint it replaces is dropped). Skipped when a primary key
-- exists already, so a partly applied database recovers.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('lookup_rate_credits', 'lookup_rate_credits_key_uniq', 'rate_group, key'),
      ('lookup_rate_deductibles', 'lookup_rate_deductibles_key_uniq', 'rate_group, key'),
      ('lookup_rate_endorsement_contents', 'lookup_rate_endorsement_contents_key_uniq', 'rate_group, key'),
      ('lookup_rate_endorsements', 'lookup_rate_endorsements_key_uniq', 'rate_group, key'),
      ('lookup_rate_fees', 'lookup_rate_fees_key_uniq', 'rate_group, key'),
      ('lookup_rate_hours', 'lookup_rate_hours_key_uniq', 'rate_group, key'),
      ('lookup_rate_limits', 'lookup_rate_limits_key_uniq', 'rate_group, key'),
      ('lookup_rate_policy_enhancements', 'lookup_rate_policy_enhancements_key_uniq', 'rate_group, key'),
      ('lookup_rate_policy_fees', 'lookup_rate_policy_fees_key_uniq', 'rate_group, key'),
      ('lookup_rate_required_items', 'lookup_rate_required_items_key_uniq', 'rate_group, key'),
      ('lookup_rate_speciality_factors', 'lookup_rate_speciality_factors_uniq', 'rate_group, code, state, surgery_type')
    ) AS v(tbl, uniq, cols)
  LOOP
    IF to_regclass(t.tbl) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(t.tbl) AND contype = 'p') THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t.tbl, t.uniq);
      EXECUTE format('DROP INDEX IF EXISTS %I', t.uniq);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY (%s)', t.tbl, t.tbl || '_pkey', t.cols);
    END IF;
  END LOOP;
END $$;

-- lookup_rate_endorsement_rules has no natural key: several rules may share an endorsement and sort order, and the
-- rate workbooks give no unique column, so a unique key could reject a valid import. It gets a surrogate key instead
-- (the importer names its columns, so the identity fills itself).
ALTER TABLE lookup_rate_endorsement_rules ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = to_regclass('lookup_rate_endorsement_rules') AND contype = 'p') THEN
    ALTER TABLE lookup_rate_endorsement_rules ADD CONSTRAINT lookup_rate_endorsement_rules_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- Money as numeric, not double precision. Unconstrained numeric so no existing amount is rounded.
ALTER TABLE lookup_rate_deductibles ALTER COLUMN amount TYPE numeric USING amount::numeric;

-- Enum-like columns, values taken from the code that writes them:
--   assessments.decision / risk_rating: modules/assessments/assessments.schemas.ts DECISIONS / RISK_RATINGS
--   jobs.kind: services/jobQueue.ts JobPayloads
--   skipped_emails.method: services/classification.ts ClassificationResult.method
-- NOT VALID: enforced on every new or updated row; rows written before are not re-checked, because a production
-- database may hold values this release does not know. Validate later with
--   ALTER TABLE <table> VALIDATE CONSTRAINT <name>;   (after checking SELECT DISTINCT <column> FROM <table>)
ALTER TABLE assessments DROP CONSTRAINT IF EXISTS assessments_decision_check;
ALTER TABLE assessments ADD CONSTRAINT assessments_decision_check
  CHECK (decision IN ('ACCEPT', 'ACCEPT_WITH_CONDITIONS', 'DECLINE', 'REFER', 'REQUEST_INFORMATION')) NOT VALID;
ALTER TABLE assessments DROP CONSTRAINT IF EXISTS assessments_risk_rating_check;
ALTER TABLE assessments ADD CONSTRAINT assessments_risk_rating_check
  CHECK (risk_rating IN ('LOW', 'MODERATE', 'ELEVATED', 'HIGH')) NOT VALID;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('process', 'extract', 'report', 'comparison', 'auto-quote', 'chat', 'email-draft')) NOT VALID;
ALTER TABLE skipped_emails DROP CONSTRAINT IF EXISTS skipped_emails_method_check;
ALTER TABLE skipped_emails ADD CONSTRAINT skipped_emails_method_check
  CHECK (method IN ('RULES', 'RULES+LLM', 'RULES_ONLY_FALLBACK')) NOT VALID;
