-- Columns nothing reads or writes: carried over from the legacy rating database by 001_schema.sql.

-- Never set by the quote store; a speciality's title and class carry its description.
ALTER TABLE specialities DROP COLUMN IF EXISTS basedescription;

-- Every row is a US ZIP: the geo import never sets it.
ALTER TABLE us_location_master DROP COLUMN IF EXISTS country_code;
