-- Settings → Automation with classification MANUAL: an automatic run that leaves an email REVIEW_REQUIRED holds it
-- (services/pipeline.ts processLocked). Its documents' text is read, but field extraction, NPI verification and the
-- automatic reports wait until a person overrides the classification (POST /submissions/:id/classification) or re-runs
-- it. Exposed as `heldForClassification` on the submission summary and detail.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS held_for_classification boolean NOT NULL DEFAULT false;
