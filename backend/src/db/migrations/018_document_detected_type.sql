-- File type recognised from the file's bytes at ingest (services/fileType.ts), next to mime_type, which is only what
-- the sender claimed. It picks the parser and decides inline preview. NULL for files stored before this column: they
-- get it the first time their text is extracted, and until then the declared type is used as before.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS detected_type text;
