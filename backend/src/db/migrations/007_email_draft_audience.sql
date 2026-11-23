-- Draft Emails now generates one draft per audience (broker, insured or quote) when Generate is clicked.
-- Rows saved by the earlier both-at-once version have no audience and are no longer shown.
ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS audience text;
ALTER TABLE email_drafts DROP CONSTRAINT IF EXISTS email_drafts_audience_check;
ALTER TABLE email_drafts ADD CONSTRAINT email_drafts_audience_check CHECK (audience IS NULL OR audience IN ('broker', 'insured', 'quote'));
CREATE INDEX IF NOT EXISTS email_drafts_audience_idx ON email_drafts (submission_id, audience, created_at DESC);
