-- A specialty no rate class matches can be rated with an underwriter's own factor (quote dialog; services/rating/quote.ts).
-- Such a row has code 'MANUAL', location 'Manual' and the reason in matched_from; its surgery type may be unstated,
-- since a manual factor does not depend on it.
ALTER TABLE specialities DROP CONSTRAINT IF EXISTS specialities_surgery_type_check;
ALTER TABLE specialities ADD CONSTRAINT specialities_surgery_type_check
  CHECK (surgery_type = ANY (ARRAY['Major Surgery'::text, 'Minor Surgery'::text, 'No Surgery'::text, 'Not stated'::text]));
