-- Chat answers and email drafts are written by background jobs (services/chat.ts, services/emailDraft.ts), not inside
-- the HTTP request: the POST stores a PENDING row and returns 202, the job fills it in (COMPLETED) or records why it
-- could not (FAILED, `error`). Existing rows were written inline and are COMPLETED.

-- Chat: the pending answer row points at the question it answers; one pending answer per submission at a time.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'COMPLETED';
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to uuid REFERENCES chat_messages(id) ON DELETE CASCADE;
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_status_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_status_check CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED'));
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_one_pending_idx ON chat_messages (submission_id) WHERE status = 'PENDING';

-- Email drafts: content, model and skill version are known only once the job has run.
ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'COMPLETED';
ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE email_drafts ALTER COLUMN content DROP NOT NULL;
ALTER TABLE email_drafts ALTER COLUMN model DROP NOT NULL;
ALTER TABLE email_drafts ALTER COLUMN skill_version DROP NOT NULL;
ALTER TABLE email_drafts DROP CONSTRAINT IF EXISTS email_drafts_status_check;
ALTER TABLE email_drafts ADD CONSTRAINT email_drafts_status_check CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED'));
ALTER TABLE email_drafts DROP CONSTRAINT IF EXISTS email_drafts_content_check;
ALTER TABLE email_drafts ADD CONSTRAINT email_drafts_content_check CHECK (status <> 'COMPLETED' OR content IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS email_drafts_one_pending_idx ON email_drafts (submission_id, audience) WHERE status = 'PENDING';
