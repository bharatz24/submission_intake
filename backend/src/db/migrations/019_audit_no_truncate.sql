-- The audit trail is append-only: the row trigger (001_schema.sql) stops UPDATE and DELETE, but TRUNCATE fires no row
-- triggers. This statement trigger stops it too.
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
