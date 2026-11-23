-- NPPES registry answers by NPI number (services/npi.ts lookupNpi), reused for NPI_CACHE_TTL_MS (24 h) or, for
-- "not found", NPI_NOT_FOUND_CACHE_TTL_MS (1 h), so re-verifying a submission doesn't ask CMS again.
-- record is the registry's public record (NULL when not found). Rows are overwritten on refresh; stale rows are
-- ignored by the read, so nothing needs to purge them.
CREATE TABLE IF NOT EXISTS npi_registry_cache (
  npi        text PRIMARY KEY CHECK (npi ~ '^\d{10}$'),
  record     jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
