-- Grounding check for extracted fields (services/evidence.ts): whether the evidence quote was found in the source text.
-- true = found, false = not found (confidence capped, shown as "Unverified"), NULL = no quote to check (manual entry,
-- registry or ZIP lookup, rows extracted before this check existed).
ALTER TABLE extracted_fields ADD COLUMN IF NOT EXISTS evidence_verified boolean;
