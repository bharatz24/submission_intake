-- QA-012: indexes on the foreign keys Postgres reads from the referencing side. Deleting a chat message or an email
-- draft, or a document or report, makes Postgres look up the rows that point at it (ON DELETE CASCADE / SET NULL);
-- without an index each such delete scans the whole table. Joins from a document to its fields use them too.
-- Columns that only point at users (created_by, actor_id, ...) are left alone on purpose: users are never deleted
-- (they are deactivated), nothing filters by them, and every index slows the writes to busy tables like audit_events.
CREATE INDEX IF NOT EXISTS extracted_fields_document_id_idx ON extracted_fields (document_id);
CREATE INDEX IF NOT EXISTS manual_fields_document_id_idx ON manual_fields (document_id);
CREATE INDEX IF NOT EXISTS chat_messages_reply_to_idx ON chat_messages (reply_to);
CREATE INDEX IF NOT EXISTS reports_based_on_report_id_idx ON reports (based_on_report_id);
CREATE INDEX IF NOT EXISTS email_drafts_analysis_report_id_idx ON email_drafts (analysis_report_id);
CREATE INDEX IF NOT EXISTS report_comparisons_target_report_id_idx ON report_comparisons (target_report_id);
CREATE INDEX IF NOT EXISTS assessments_analysis_report_id_idx ON assessments (analysis_report_id);
