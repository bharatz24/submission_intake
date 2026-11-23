-- Names split by type: individuals into first/last name, organizations into an entity name.
-- The full-name columns (applicant_name, claimed_name, registry_name) stay as the display/search value.
-- Types mirror NameType in services/npi.ts. Applicant and claimed names are backfilled in code
-- (db/backfills.ts) because the split uses the same parser as the NPI registry search.

ALTER TABLE submissions
  ADD COLUMN applicant_type        text CHECK (applicant_type IN ('INDIVIDUAL','ORGANIZATION')),
  ADD COLUMN applicant_first_name  text,
  ADD COLUMN applicant_last_name   text,
  ADD COLUMN applicant_entity_name text,
  ADD CONSTRAINT submissions_applicant_name_parts_check CHECK (
    (applicant_type IS NULL AND applicant_first_name IS NULL AND applicant_last_name IS NULL AND applicant_entity_name IS NULL)
    OR (applicant_type = 'INDIVIDUAL' AND applicant_entity_name IS NULL)
    OR (applicant_type = 'ORGANIZATION' AND applicant_first_name IS NULL AND applicant_last_name IS NULL));

ALTER TABLE npi_verifications
  ADD COLUMN claimed_type         text CHECK (claimed_type IN ('INDIVIDUAL','ORGANIZATION')),
  ADD COLUMN claimed_first_name   text,
  ADD COLUMN claimed_last_name    text,
  ADD COLUMN claimed_entity_name  text,
  ADD COLUMN registry_type        text CHECK (registry_type IN ('INDIVIDUAL','ORGANIZATION')),
  ADD COLUMN registry_first_name  text,
  ADD COLUMN registry_last_name   text,
  ADD COLUMN registry_entity_name text,
  ADD CONSTRAINT npi_verifications_claimed_name_parts_check CHECK (
    (claimed_type IS NULL AND claimed_first_name IS NULL AND claimed_last_name IS NULL AND claimed_entity_name IS NULL)
    OR (claimed_type = 'INDIVIDUAL' AND claimed_entity_name IS NULL)
    OR (claimed_type = 'ORGANIZATION' AND claimed_first_name IS NULL AND claimed_last_name IS NULL)),
  ADD CONSTRAINT npi_verifications_registry_name_parts_check CHECK (
    (registry_type IS NULL AND registry_first_name IS NULL AND registry_last_name IS NULL AND registry_entity_name IS NULL)
    OR (registry_type = 'INDIVIDUAL' AND registry_entity_name IS NULL)
    OR (registry_type = 'ORGANIZATION' AND registry_first_name IS NULL AND registry_last_name IS NULL));

-- Registry side straight from the stored NPPES record (NPI-1 individual, NPI-2 organization).
UPDATE npi_verifications SET
  registry_type = 'INDIVIDUAL',
  registry_first_name = registry_data->'basic'->>'first_name',
  registry_last_name = registry_data->'basic'->>'last_name'
WHERE registry_data->>'enumeration_type' = 'NPI-1';

UPDATE npi_verifications SET
  registry_type = 'ORGANIZATION',
  registry_entity_name = registry_data->'basic'->>'organization_name'
WHERE registry_data->>'enumeration_type' = 'NPI-2';
