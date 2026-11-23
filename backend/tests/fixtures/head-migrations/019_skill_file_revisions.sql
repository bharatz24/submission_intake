-- Skill files edited in Settings. backend/skills/ on disk stays the shipped default; the newest revision per
-- (skill, file) overrides it. content NULL = reset to the disk default. Rows are only ever added, so this is the history.
CREATE TABLE skill_file_revisions (
  id            bigserial PRIMARY KEY,
  skill_name    text NOT NULL,
  file_path     text NOT NULL,
  content       text,
  content_hash  text NOT NULL,
  skill_version text NOT NULL,   -- the skill's version once this revision is active
  note          text NOT NULL DEFAULT '',
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_file_revisions_file_idx ON skill_file_revisions (skill_name, file_path, id DESC);
