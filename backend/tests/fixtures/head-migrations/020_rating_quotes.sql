-- Rating engine (ported from Submission-Intake): rate tables imported from backend/data/rates/*.xlsx, versioned by
-- rate group; ZIP geography for state/county lookup; and quotes, which an underwriter creates by hand.

-- ---- Rate tables ----
CREATE TABLE rate_groups (
  name        text PRIMARY KEY,
  source_dir  text,
  files       jsonb NOT NULL DEFAULT '[]',
  row_counts  jsonb NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT false,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- Every sheet of every workbook, as imported (including ones rating does not use yet).
CREATE TABLE rate_lookup_rows (
  id          bigserial PRIMARY KEY,
  rate_group  text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  source_file text NOT NULL,
  sheet       text NOT NULL,
  row_num     integer NOT NULL,
  data        jsonb NOT NULL
);
CREATE INDEX rate_lookup_rows_idx ON rate_lookup_rows (rate_group, sheet);

CREATE TABLE rate_states (
  rate_group        text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  state             text NOT NULL,
  base_rate         double precision NOT NULL,
  domicile_tax_rate double precision NOT NULL,
  state_tax_rate    double precision NOT NULL,
  defense           text,
  key               text,
  PRIMARY KEY (rate_group, state)
);
CREATE TABLE rate_step_ups (
  rate_group text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  state      text NOT NULL,
  year       integer NOT NULL,
  factor     double precision NOT NULL,
  PRIMARY KEY (rate_group, state, year)
);
CREATE TABLE rate_territories (
  id           serial PRIMARY KEY,
  rate_group   text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  state        text NOT NULL,
  territory    integer NOT NULL,
  factor       double precision NOT NULL,
  counties     text NOT NULL,
  is_remainder boolean NOT NULL,
  key          text
);
CREATE INDEX rate_territories_idx ON rate_territories (rate_group, state);
CREATE TABLE rate_territory_counties (
  territory_id integer NOT NULL REFERENCES rate_territories(id) ON DELETE CASCADE,
  county       text NOT NULL,
  county_norm  text NOT NULL
);
CREATE INDEX rate_territory_counties_idx ON rate_territory_counties (county_norm);
CREATE TABLE rate_limits (
  rate_group      text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  state           text NOT NULL,
  factor          double precision NOT NULL,
  incident_limit  double precision NOT NULL,
  aggregate_limit double precision NOT NULL,
  is_default      boolean NOT NULL,
  key             text NOT NULL
);
CREATE INDEX rate_limits_idx ON rate_limits (rate_group, state);
CREATE TABLE rate_specialities (
  rate_group   text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  code         text NOT NULL,
  title        text NOT NULL,
  type         text,
  category     text,
  abbreviation text,
  key          text
);
CREATE INDEX rate_specialities_idx ON rate_specialities (rate_group, code);
CREATE TABLE rate_speciality_factors (
  rate_group   text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  code         text NOT NULL,
  title        text NOT NULL,
  state        text NOT NULL,   -- two-letter state, or 'All'
  surgery_type text NOT NULL,
  factor       double precision NOT NULL
);
CREATE INDEX rate_speciality_factors_idx ON rate_speciality_factors (rate_group, state);
CREATE TABLE rate_hours (
  rate_group text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  title      text NOT NULL,
  factor     double precision NOT NULL,
  type       text,
  is_default boolean NOT NULL,
  max_hours  double precision,  -- NULL = no upper bound ("20+")
  key        text NOT NULL
);
CREATE TABLE rate_credits (
  rate_group       text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  title            text NOT NULL,
  percent          double precision NOT NULL,
  type             text,
  deductible_label text,
  key              text NOT NULL
);
CREATE TABLE rate_fees (
  rate_group        text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  title             text NOT NULL,
  calculate         boolean NOT NULL,
  allow_edit        boolean NOT NULL,
  amount_or_percent double precision NOT NULL,
  state             text NOT NULL,
  earn_percent      double precision,
  required          boolean NOT NULL,
  key               text NOT NULL
);
CREATE TABLE rate_policy_fees (
  rate_group   text NOT NULL REFERENCES rate_groups(name) ON DELETE CASCADE,
  title        text NOT NULL,
  amount       double precision NOT NULL,
  earn_percent double precision,
  required     boolean NOT NULL,
  key          text NOT NULL
);

-- ---- ZIP geography (Census 2020 ZCTA-county relationship + GeoNames postal codes) ----
CREATE TABLE geo_zips (
  zip   text PRIMARY KEY,
  city  text,
  state text NOT NULL
);
CREATE INDEX geo_zips_city_idx ON geo_zips (state, lower(city));
CREATE TABLE geo_zip_counties (
  zip         text NOT NULL REFERENCES geo_zips(zip) ON DELETE CASCADE,
  county      text NOT NULL,
  county_norm text NOT NULL,
  share       double precision NOT NULL,
  PRIMARY KEY (zip, county)
);

-- ---- Quotes: one row per priced option, created only by an underwriter. Never re-priced in place. ----
CREATE TABLE quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  label           text,
  status          text NOT NULL CHECK (status IN ('QUOTED','INCOMPLETE')),
  rate_group      text NOT NULL,
  context_version integer NOT NULL,
  inputs          jsonb NOT NULL,
  sources         jsonb NOT NULL DEFAULT '{}',
  factors         jsonb NOT NULL DEFAULT '{}',
  pricing         jsonb,
  premium         numeric(14,2),
  total           numeric(14,2),
  flags           jsonb NOT NULL DEFAULT '[]',
  missing         jsonb NOT NULL DEFAULT '[]',
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, version)
);
