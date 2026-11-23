-- Platform settings kept in the database (services/appSettings.ts), e.g. the date automatic Gmail ingestion starts from.
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
