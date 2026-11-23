-- Reference lookups imported and exported in Settings > Rate tables alongside the rate workbooks (services/rating/importer.ts).
-- They are versioned with the rate group like the rate tables, but nothing prices from them yet.
-- sort_order keeps the workbook's row order for export.

CREATE TABLE IF NOT EXISTS lookup_rate_endorsements (
    rate_group text NOT NULL REFERENCES lookup_rate_groups(name) ON DELETE CASCADE,
    sort_order integer NOT NULL,
    number integer NOT NULL,
    name text NOT NULL,
    revision_date text,
    allow_edit boolean NOT NULL,
    additional_insured boolean NOT NULL,
    additional_location boolean NOT NULL,
    erp boolean NOT NULL,
    exclusions_type boolean NOT NULL,
    show_rates boolean NOT NULL,
    required boolean NOT NULL,
    key text NOT NULL,
    contents text,
    CONSTRAINT lookup_rate_endorsements_key_uniq UNIQUE (rate_group, key),
    CONSTRAINT lookup_rate_endorsements_number_uniq UNIQUE (rate_group, number)
);

CREATE TABLE IF NOT EXISTS lookup_rate_endorsement_rules (
    rate_group text NOT NULL REFERENCES lookup_rate_groups(name) ON DELETE CASCADE,
    sort_order integer NOT NULL,
    endorsement_number integer NOT NULL,
    title text,
    rule_group text,
    rule text,
    subrule text,
    condition text,
    value text
);
CREATE INDEX IF NOT EXISTS lookup_rate_endorsement_rules_idx ON lookup_rate_endorsement_rules (rate_group, endorsement_number);

CREATE TABLE IF NOT EXISTS lookup_rate_endorsement_contents (
    rate_group text NOT NULL REFERENCES lookup_rate_groups(name) ON DELETE CASCADE,
    sort_order integer NOT NULL,
    title text NOT NULL,
    description text,
    key text NOT NULL,
    CONSTRAINT lookup_rate_endorsement_contents_key_uniq UNIQUE (rate_group, key)
);

CREATE TABLE IF NOT EXISTS lookup_rate_policy_enhancements (
    rate_group text NOT NULL REFERENCES lookup_rate_groups(name) ON DELETE CASCADE,
    sort_order integer NOT NULL,
    title text NOT NULL,
    description text,
    required boolean NOT NULL,
    key text NOT NULL,
    CONSTRAINT lookup_rate_policy_enhancements_key_uniq UNIQUE (rate_group, key)
);

CREATE TABLE IF NOT EXISTS lookup_rate_deductibles (
    rate_group text NOT NULL REFERENCES lookup_rate_groups(name) ON DELETE CASCADE,
    sort_order integer NOT NULL,
    title text NOT NULL,
    amount double precision NOT NULL,
    key text NOT NULL,
    CONSTRAINT lookup_rate_deductibles_key_uniq UNIQUE (rate_group, key)
);

CREATE TABLE IF NOT EXISTS lookup_rate_required_items (
    rate_group text NOT NULL REFERENCES lookup_rate_groups(name) ON DELETE CASCADE,
    sort_order integer NOT NULL,
    title text NOT NULL,
    description text,
    required boolean NOT NULL,
    key text NOT NULL,
    CONSTRAINT lookup_rate_required_items_key_uniq UNIQUE (rate_group, key)
);
