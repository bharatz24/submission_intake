-- Values a person adds or corrects by hand (services/fields.ts). Kept apart from extracted_fields, which reprocessing
-- rewrites as a new context version, so manual values survive reprocessing. A manual value supersedes every
-- extracted value with the same field_name; a field may hold several manual rows (e.g. one per practice location).
CREATE TABLE manual_fields (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  field_name    text NOT NULL,
  value         text NOT NULL,
  note          text,
  created_by    uuid NOT NULL REFERENCES users(id),
  updated_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX manual_fields_submission_idx ON manual_fields(submission_id, field_name);

-- Where an NPI check came from: found on the submission (EXTRACTED) or entered by a person (MANUAL).
-- Only MANUAL checks can be removed, and re-verification never drops them as stale.
ALTER TABLE npi_verifications
  ADD COLUMN source   text NOT NULL DEFAULT 'EXTRACTED' CHECK (source IN ('EXTRACTED','MANUAL')),
  ADD COLUMN added_by uuid REFERENCES users(id),
  ADD COLUMN note     text;
