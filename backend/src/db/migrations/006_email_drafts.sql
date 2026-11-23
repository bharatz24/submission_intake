-- Draft Emails button (services/emailDraft.ts): its Claude calls are their own LLM task.
ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS llm_calls_task_check;
ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_task_check
    CHECK (task = ANY (ARRAY['classification', 'extraction', 'synthesis', 'analysis', 'chat', 'comparison', 'quote', 'email_draft']));

-- Generated broker and insured drafts, kept so reopening the dialog shows the last ones; Regenerate adds a row and the
-- newest is shown. `content` is the skill output (purpose, brokerDraft, insuredDraft). Drafts are never sent.
CREATE TABLE IF NOT EXISTS email_drafts (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    analysis_report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    content jsonb NOT NULL,
    model text NOT NULL,
    skill_version text NOT NULL,
    created_by uuid REFERENCES users(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS email_drafts_submission_idx ON email_drafts (submission_id, created_at DESC);
