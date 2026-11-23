-- Per-user read state for the inbox unread badge. Tracked in the app because Gmail access is read-only.
CREATE TABLE submission_reads (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  read_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, submission_id)
);
CREATE INDEX submission_reads_submission_idx ON submission_reads(submission_id);

-- Existing mail counts as read so the badge starts at zero instead of the whole backlog.
INSERT INTO submission_reads (user_id, submission_id) SELECT u.id, s.id FROM users u CROSS JOIN submissions s;
