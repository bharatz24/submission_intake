-- Replies and forwards sent from a submission (services/outbound.ts). Rows are written only after Gmail accepted
-- the message. document_ids are the submission documents attached to a forward.
CREATE TABLE outbound_emails (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id    uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  mode             text NOT NULL CHECK (mode IN ('REPLY','REPLY_ALL','FORWARD')),
  to_addresses     text[] NOT NULL,
  cc_addresses     text[] NOT NULL DEFAULT '{}',
  bcc_addresses    text[] NOT NULL DEFAULT '{}',
  subject          text NOT NULL,
  body             text NOT NULL,
  document_ids     uuid[] NOT NULL DEFAULT '{}',
  transport        text NOT NULL CHECK (transport IN ('OAUTH','MCP')),
  gmail_message_id text,
  gmail_thread_id  text,
  sent_by          uuid NOT NULL REFERENCES users(id),
  sent_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbound_emails_submission_idx ON outbound_emails(submission_id, sent_at DESC);
