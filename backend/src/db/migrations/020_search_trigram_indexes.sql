-- Inbox search (services/queries.ts searchWhere) matches `ILIKE '%term%'` on the email subject, the sender and the
-- applicant name. A leading wildcard cannot use a btree index, so every search scanned those tables. Trigram GIN
-- indexes serve ILIKE '%…%' directly. IF NOT EXISTS keeps this re-runnable; the tables are small enough today for a
-- plain (locking) CREATE INDEX inside the migration transaction. On a large table, create the index CONCURRENTLY by
-- hand before deploying and this file becomes a no-op.
-- The extension and its operator class are named with their schema: the startup schema check replays migrations
-- with only a scratch schema on the search path, where an unqualified gin_trgm_ops would not resolve.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE INDEX IF NOT EXISTS emails_subject_trgm ON emails USING gin (subject public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS emails_from_address_trgm ON emails USING gin (from_address public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS submissions_applicant_name_trgm ON submissions USING gin (applicant_name public.gin_trgm_ops);
