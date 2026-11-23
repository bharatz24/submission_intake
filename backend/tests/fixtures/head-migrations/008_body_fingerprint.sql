-- Normalized body alone (services/duplicates.ts, rule R7): the same text re-sent under an edited subject.
ALTER TABLE submissions ADD COLUMN body_fingerprint text;
CREATE INDEX submissions_body_fp_idx ON submissions(body_fingerprint) WHERE body_fingerprint IS NOT NULL;
