-- The document a manual value was taken from (an existing attachment or one uploaded with the value).
-- Removing the document keeps the value and clears the link.
ALTER TABLE manual_fields ADD COLUMN document_id uuid REFERENCES documents(id) ON DELETE SET NULL;
