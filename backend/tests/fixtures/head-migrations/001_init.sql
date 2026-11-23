CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('ADMIN','UNDERWRITER','VIEWER')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Single monitored mailbox (read-only scope). Refresh token is encrypted at rest.
CREATE TABLE gmail_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL UNIQUE,
  refresh_token_enc  text NOT NULL,
  history_id         text,
  watch_expires_at   timestamptz,
  last_poll_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE emails (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id text UNIQUE,
  thread_id        text,
  from_address     text NOT NULL,
  to_address       text NOT NULL DEFAULT '',
  subject          text NOT NULL DEFAULT '',
  snippet          text NOT NULL DEFAULT '',
  body_text        text NOT NULL DEFAULT '',
  received_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE submissions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id                   uuid NOT NULL REFERENCES emails(id),
  status                     text NOT NULL DEFAULT 'NEW',
  classification             text CHECK (classification IN ('SUBMISSION','NOT_SUBMISSION','REVIEW_REQUIRED')),
  classification_confidence  real,
  classification_reasons     jsonb NOT NULL DEFAULT '[]',
  applicant_name             text,
  assigned_to                uuid REFERENCES users(id),
  context_version            integer NOT NULL DEFAULT 0,
  processing_error           text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submissions_status_idx ON submissions(status);
CREATE INDEX submissions_updated_idx ON submissions(updated_at DESC);

CREATE TABLE documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id     uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  filename          text NOT NULL,
  mime_type         text NOT NULL,
  size_bytes        integer NOT NULL,
  sha256            text NOT NULL,
  storage_key       text NOT NULL,
  source            text NOT NULL CHECK (source IN ('EMAIL','UPLOAD')),
  extraction_status text NOT NULL DEFAULT 'PENDING',
  ocr_used          boolean NOT NULL DEFAULT false,
  page_count        integer,
  extracted_text    text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_submission_idx ON documents(submission_id);

CREATE TABLE extracted_fields (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  document_id    uuid REFERENCES documents(id) ON DELETE SET NULL,
  field_name     text NOT NULL,
  value          text NOT NULL,
  confidence     real NOT NULL,
  evidence_quote text,
  source_label   text NOT NULL,
  context_version integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extracted_fields_submission_idx ON extracted_fields(submission_id);

CREATE TABLE npi_verifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id     uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  npi               text NOT NULL,
  claimed_name      text,
  claimed_state     text,
  claimed_specialty text,
  status            text NOT NULL,
  registry_name     text,
  registry_taxonomy text,
  registry_state    text,
  registry_status   text,
  mismatches        jsonb NOT NULL DEFAULT '[]',
  registry_data     jsonb,
  verified_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX npi_submission_idx ON npi_verifications(submission_id);

CREATE TABLE context_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  reason        text NOT NULL,
  snapshot_hash text NOT NULL,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, version)
);

CREATE TABLE reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id     uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('SYNTHESIS','ANALYSIS')),
  version           integer NOT NULL,
  status            text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  context_version   integer NOT NULL,
  based_on_report_id uuid REFERENCES reports(id),
  skill_name        text NOT NULL,
  skill_version     text NOT NULL,
  model             text NOT NULL,
  content_json      jsonb,
  content_markdown  text,
  usage             jsonb,
  error             text,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  UNIQUE (submission_id, kind, version)
);

CREATE TABLE assessments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version            integer NOT NULL,
  decision           text NOT NULL,
  risk_rating        text NOT NULL,
  notes              text NOT NULL DEFAULT '',
  analysis_report_id uuid REFERENCES reports(id),
  context_version    integer NOT NULL,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, version)
);

-- Append-only: application code never updates or deletes rows here.
CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  submission_id uuid REFERENCES submissions(id),
  actor_type    text NOT NULL CHECK (actor_type IN ('USER','SYSTEM')),
  actor_id      uuid REFERENCES users(id),
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  details       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_submission_idx ON audit_events(submission_id, created_at DESC);
CREATE INDEX audit_created_idx ON audit_events(created_at DESC);

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TABLE chat_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id),
  role          text NOT NULL CHECK (role IN ('user','assistant')),
  content       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_errors (
  id         bigserial PRIMARY KEY,
  scope      text NOT NULL,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
