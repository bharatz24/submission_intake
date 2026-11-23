-- Last words of the normalized body (services/duplicates.ts, rule R8): finds the earlier email when a forward
-- or re-send adds a note on top and changes the subject.
ALTER TABLE submissions ADD COLUMN body_tail_fingerprint text;
CREATE INDEX submissions_body_tail_fp_idx ON submissions(body_tail_fingerprint) WHERE body_tail_fingerprint IS NOT NULL;

-- Machine-set facts about the message (services/classificationRules.ts): Auto-Submitted, List-Unsubscribe,
-- Precedence, multipart/report type, Gmail category. Evidence for Ignore that keywords cannot give.
ALTER TABLE emails ADD COLUMN signals jsonb NOT NULL DEFAULT '{}';
