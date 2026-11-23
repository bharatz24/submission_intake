-- The inbox lists submissions newest email first (services/queries.ts listSubmissions: ORDER BY e.received_at DESC
-- with LIMIT/OFFSET): this index lets a page be read in that order instead of sorting every email.
CREATE INDEX IF NOT EXISTS emails_received_at_idx ON emails (received_at DESC);

-- The email's Cc header as received (comma-separated addresses), recorded on ingest; NULL for emails stored before it
-- was kept, and for manual uploads. Exposed as `ccAddress` on the API's email objects.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS cc_address text;
