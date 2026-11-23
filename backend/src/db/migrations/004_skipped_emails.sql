-- Gmail messages classified as not a submission before anything was stored (services/pipeline.ts ingestGmailEmail).
-- Nothing of the email is kept (no emails/submissions rows, no Drive files): only enough to see what was dropped and why,
-- and to keep polling and reconciliation from fetching and classifying the same message again.
CREATE TABLE skipped_emails (
    gmail_message_id text PRIMARY KEY,
    thread_id text,
    from_address text NOT NULL,
    subject text NOT NULL,
    received_at timestamp with time zone NOT NULL,
    attachment_count integer NOT NULL DEFAULT 0,
    confidence real NOT NULL,
    reasons text[] NOT NULL DEFAULT '{}',
    method text NOT NULL,
    skipped_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX skipped_emails_thread_id_idx ON skipped_emails (thread_id);
CREATE INDEX skipped_emails_skipped_at_idx ON skipped_emails (skipped_at DESC);
