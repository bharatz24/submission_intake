-- Whole schema as one migration (replaces 001_init ... 024_drop_lookup_rate_rows, and later 002_drop_rate_group_files, 002_minimize,
-- 002_rating_money, 010_auth, 011_jobs and 012_outbound). Generated with pg_dump --schema-only
-- from a database built by those migrations, then checked to rebuild the same schema. Data backfills stay in backfills.ts.
--
-- Areas: submissions, emails, documents, extracted fields; reports, assessments, chat, LLM usage; Gmail ingest and
-- outbound email; rate lookup tables (lookup_rate_*) and ZIP locations (us_location_master); saved quotes in the rating
-- structure (single_rating + child tables, coverage_fees, submissions.primary_rating_id); users, audit (immutable),
-- settings, system errors.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE FUNCTION audit_events_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;

CREATE TABLE app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE assessments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    version integer NOT NULL,
    decision text NOT NULL,
    risk_rating text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    analysis_report_id uuid,
    context_version integer NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE attachment_gaps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    filename text NOT NULL,
    mime_type text,
    size_bytes bigint,
    reason text NOT NULL,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachment_gaps_reason_check CHECK ((reason = ANY (ARRAY['TOO_LARGE'::text, 'NO_CONTENT'::text, 'LINKED_FILE'::text])))
);

CREATE TABLE audit_events (
    id bigint NOT NULL,
    submission_id uuid,
    actor_type text NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_events_actor_type_check CHECK ((actor_type = ANY (ARRAY['USER'::text, 'SYSTEM'::text])))
);

CREATE SEQUENCE audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE audit_events_id_seq OWNED BY audit_events.id;

CREATE TABLE chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    user_id uuid,
    role text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);

CREATE TABLE context_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    version integer NOT NULL,
    reason text NOT NULL,
    snapshot_hash text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE coverage_fees (
    id bigint NOT NULL,
    submission_id uuid NOT NULL,
    key text,
    title text NOT NULL,
    amount numeric(14,2) NOT NULL,
    percentageofearn double precision
);

CREATE SEQUENCE coverage_fees_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE coverage_fees_id_seq OWNED BY coverage_fees.id;

CREATE TABLE documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    filename text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    sha256 text NOT NULL,
    storage_key text NOT NULL,
    source text NOT NULL,
    extraction_status text DEFAULT 'PENDING'::text NOT NULL,
    ocr_used boolean DEFAULT false NOT NULL,
    page_count integer,
    extracted_text text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    storage_backend text DEFAULT 'LOCAL'::text NOT NULL,
    CONSTRAINT documents_extraction_status_check CHECK ((extraction_status = ANY (ARRAY['PENDING'::text, 'EXTRACTED'::text, 'OCR_EXTRACTED'::text, 'UNREADABLE'::text, 'UNSUPPORTED'::text, 'ERROR'::text]))),
    CONSTRAINT documents_source_check CHECK ((source = ANY (ARRAY['EMAIL'::text, 'UPLOAD'::text]))),
    CONSTRAINT documents_storage_backend_check CHECK ((storage_backend = ANY (ARRAY['LOCAL'::text, 'GDRIVE'::text])))
);

CREATE TABLE emails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    gmail_message_id text,
    thread_id text,
    from_address text NOT NULL,
    to_address text DEFAULT ''::text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    snippet text DEFAULT ''::text NOT NULL,
    body_text text DEFAULT ''::text NOT NULL,
    received_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rfc_message_id text,
    auto_submitted text,
    list_unsubscribe boolean DEFAULT false NOT NULL,
    precedence text,
    report_type text,
    gmail_category text
);

CREATE TABLE extracted_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    document_id uuid,
    field_name text NOT NULL,
    value text NOT NULL,
    confidence real NOT NULL,
    evidence_quote text,
    source_label text NOT NULL,
    context_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE gmail_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    refresh_token_enc text NOT NULL,
    history_id text,
    watch_expires_at timestamp with time zone,
    last_poll_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE gmail_ingest_queue (
    gmail_message_id text NOT NULL,
    source text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    alerted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gmail_ingest_queue_source_check CHECK ((source = ANY (ARRAY['OAUTH'::text, 'MCP'::text])))
);

-- Durable background jobs (services/jobQueue.ts). A job is a kind + JSON payload, never a closure, so any
-- instance can run it and a restart or crash loses nothing: a running job whose lease lapses is claimed again.
CREATE TABLE jobs (
    id bigserial PRIMARY KEY,
    kind text NOT NULL,
    -- At most one queued job per key (jobs_queued_key). One may be queued behind a running one (a re-run asked for
    -- mid-run); workers never claim it while that one runs, so a key never runs twice at once.
    dedupe_key text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts int NOT NULL DEFAULT 0,
    max_attempts int NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
    run_after timestamptz NOT NULL DEFAULT now(),
    locked_until timestamptz,
    locked_by text,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    CHECK (status <> 'running' OR (locked_until IS NOT NULL AND locked_by IS NOT NULL))
);

CREATE TABLE llm_calls (
    id bigint NOT NULL,
    submission_id uuid,
    task text NOT NULL,
    skill_name text NOT NULL,
    skill_version text NOT NULL,
    model text NOT NULL,
    status text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cache_read_tokens integer DEFAULT 0 NOT NULL,
    cache_write_tokens integer DEFAULT 0 NOT NULL,
    duration_ms integer NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    -- The model a Claude call asked for; `model` holds the one that answered (server-side fallback can differ).
    requested_model text,
    CONSTRAINT llm_calls_status_check CHECK ((status = ANY (ARRAY['SUCCESS'::text, 'REFUSED'::text, 'TRUNCATED'::text, 'INVALID_OUTPUT'::text, 'ERROR'::text]))),
    CONSTRAINT llm_calls_task_check CHECK ((task = ANY (ARRAY['classification'::text, 'extraction'::text, 'synthesis'::text, 'analysis'::text, 'chat'::text, 'comparison'::text])))
);

CREATE SEQUENCE llm_calls_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE llm_calls_id_seq OWNED BY llm_calls.id;

CREATE TABLE lookup_rate_credits (
    rate_group text NOT NULL,
    title text NOT NULL,
    percent double precision NOT NULL,
    type text,
    deductible_label text,
    key text NOT NULL
);

CREATE TABLE lookup_rate_fees (
    rate_group text NOT NULL,
    title text NOT NULL,
    calculate boolean NOT NULL,
    allow_edit boolean NOT NULL,
    amount_or_percent double precision NOT NULL,
    state text NOT NULL,
    earn_percent double precision,
    required boolean NOT NULL,
    key text NOT NULL
);

CREATE TABLE lookup_rate_groups (
    name text NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE lookup_rate_hours (
    rate_group text NOT NULL,
    title text NOT NULL,
    factor double precision NOT NULL,
    type text,
    is_default boolean NOT NULL,
    max_hours double precision,
    key text NOT NULL
);

CREATE TABLE lookup_rate_limits (
    rate_group text NOT NULL,
    state text NOT NULL,
    factor double precision NOT NULL,
    incident_limit double precision NOT NULL,
    aggregate_limit double precision NOT NULL,
    is_default boolean NOT NULL,
    key text NOT NULL
);

CREATE TABLE lookup_rate_policy_fees (
    rate_group text NOT NULL,
    title text NOT NULL,
    amount double precision NOT NULL,
    earn_percent double precision,
    required boolean NOT NULL,
    key text NOT NULL
);

CREATE TABLE lookup_rate_speciality_factors (
    rate_group text NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    state text NOT NULL,
    surgery_type text NOT NULL,
    factor double precision NOT NULL,
    abbreviation text
);

CREATE TABLE lookup_rate_states (
    rate_group text NOT NULL,
    state text NOT NULL,
    base_rate double precision NOT NULL,
    domicile_tax_rate double precision NOT NULL,
    state_tax_rate double precision NOT NULL,
    defense text,
    key text
);

CREATE TABLE lookup_rate_step_ups (
    rate_group text NOT NULL,
    state text NOT NULL,
    year integer NOT NULL,
    factor double precision NOT NULL
);

CREATE TABLE lookup_rate_territories (
    id integer NOT NULL,
    rate_group text NOT NULL,
    state text NOT NULL,
    territory integer NOT NULL,
    factor double precision NOT NULL,
    is_remainder boolean NOT NULL,
    key text,
    counties text[] DEFAULT '{}'::text[] NOT NULL
);

CREATE SEQUENCE lookup_rate_territories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE lookup_rate_territories_id_seq OWNED BY lookup_rate_territories.id;

CREATE TABLE manual_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    field_name text NOT NULL,
    value text NOT NULL,
    note text,
    created_by uuid NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    document_id uuid
);

CREATE TABLE npi_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    npi text NOT NULL,
    claimed_name text,
    claimed_state text,
    claimed_specialty text,
    status text NOT NULL,
    registry_name text,
    registry_taxonomy text,
    registry_state text,
    registry_status text,
    registry_data jsonb,
    verified_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_type text,
    claimed_first_name text,
    claimed_last_name text,
    claimed_entity_name text,
    registry_type text,
    registry_first_name text,
    registry_last_name text,
    registry_entity_name text,
    source text DEFAULT 'EXTRACTED'::text NOT NULL,
    added_by uuid,
    note text,
    auto_status text,
    override_note text,
    override_by uuid,
    override_at timestamp with time zone,
    mismatches text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT npi_verifications_claimed_name_parts_check CHECK ((((claimed_type IS NULL) AND (claimed_first_name IS NULL) AND (claimed_last_name IS NULL) AND (claimed_entity_name IS NULL)) OR ((claimed_type = 'INDIVIDUAL'::text) AND (claimed_entity_name IS NULL)) OR ((claimed_type = 'ORGANIZATION'::text) AND (claimed_first_name IS NULL) AND (claimed_last_name IS NULL)))),
    CONSTRAINT npi_verifications_claimed_type_check CHECK ((claimed_type = ANY (ARRAY['INDIVIDUAL'::text, 'ORGANIZATION'::text]))),
    CONSTRAINT npi_verifications_override_check CHECK (((auto_status IS NULL) OR ((auto_status = 'PARTIAL_MATCH'::text) AND (status = ANY (ARRAY['MATCH'::text, 'MISMATCH'::text])) AND (override_note IS NOT NULL) AND (override_by IS NOT NULL) AND (override_at IS NOT NULL)))),
    CONSTRAINT npi_verifications_registry_name_parts_check CHECK ((((registry_type IS NULL) AND (registry_first_name IS NULL) AND (registry_last_name IS NULL) AND (registry_entity_name IS NULL)) OR ((registry_type = 'INDIVIDUAL'::text) AND (registry_entity_name IS NULL)) OR ((registry_type = 'ORGANIZATION'::text) AND (registry_first_name IS NULL) AND (registry_last_name IS NULL)))),
    CONSTRAINT npi_verifications_registry_type_check CHECK ((registry_type = ANY (ARRAY['INDIVIDUAL'::text, 'ORGANIZATION'::text]))),
    CONSTRAINT npi_verifications_source_check CHECK ((source = ANY (ARRAY['EXTRACTED'::text, 'MANUAL'::text]))),
    CONSTRAINT npi_verifications_status_check CHECK ((status = ANY (ARRAY['MATCH'::text, 'PARTIAL_MATCH'::text, 'MISMATCH'::text, 'NOT_FOUND'::text, 'NOT_VERIFIED'::text, 'ERROR'::text])))
);

CREATE TABLE outbound_emails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    mode text NOT NULL,
    to_addresses text[] NOT NULL,
    cc_addresses text[] DEFAULT '{}'::text[] NOT NULL,
    bcc_addresses text[] DEFAULT '{}'::text[] NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    document_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    transport text NOT NULL,
    gmail_message_id text,
    gmail_thread_id text,
    sent_by uuid NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    -- Idempotency (services/outbound.ts): a row is written PENDING before Gmail is called and marked SENT or FAILED
    -- after, so a retry with the same Idempotency-Key never sends twice and a send whose result could not be recorded
    -- still leaves its row.
    idempotency_key text,
    status text DEFAULT 'SENT'::text NOT NULL,
    error text,
    CONSTRAINT outbound_emails_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'SENT'::text, 'FAILED'::text]))),
    CONSTRAINT outbound_emails_mode_check CHECK ((mode = ANY (ARRAY['REPLY'::text, 'REPLY_ALL'::text, 'FORWARD'::text]))),
    CONSTRAINT outbound_emails_transport_check CHECK ((transport = ANY (ARRAY['OAUTH'::text, 'MCP'::text])))
);

CREATE TABLE report_comparisons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    kind text NOT NULL,
    base_report_id uuid NOT NULL,
    target_report_id uuid NOT NULL,
    status text NOT NULL,
    field_diff jsonb NOT NULL,
    content_json jsonb,
    content_markdown text,
    skill_name text NOT NULL,
    skill_version text NOT NULL,
    model text NOT NULL,
    error text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    input_tokens integer,
    output_tokens integer,
    CONSTRAINT report_comparisons_check CHECK ((base_report_id <> target_report_id)),
    CONSTRAINT report_comparisons_kind_check CHECK ((kind = ANY (ARRAY['SYNTHESIS'::text, 'ANALYSIS'::text]))),
    CONSTRAINT report_comparisons_status_check CHECK ((status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text])))
);

CREATE TABLE reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    kind text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    context_version integer NOT NULL,
    based_on_report_id uuid,
    skill_name text NOT NULL,
    skill_version text NOT NULL,
    model text NOT NULL,
    content_json jsonb,
    content_markdown text,
    error text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    input_tokens integer,
    output_tokens integer,
    CONSTRAINT reports_kind_check CHECK ((kind = ANY (ARRAY['SYNTHESIS'::text, 'ANALYSIS'::text]))),
    CONSTRAINT reports_status_check CHECK ((status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text])))
);

CREATE TABLE scheduledcreditsdebits (
    id bigint NOT NULL,
    singlerating uuid NOT NULL,
    sort_order integer NOT NULL,
    key text,
    title text NOT NULL,
    type text,
    credit double precision,
    amount numeric(14,2),
    deductiblelable text
);

CREATE SEQUENCE scheduledcreditsdebits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE scheduledcreditsdebits_id_seq OWNED BY scheduledcreditsdebits.id;

CREATE TABLE single_rating (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id uuid NOT NULL,
    version integer NOT NULL,
    title text,
    description text,
    status text NOT NULL,
    rate_group text NOT NULL,
    context_version integer NOT NULL,
    location text,
    county text,
    zipcode text,
    city text,
    county_source text,
    defense text,
    hourseperweek double precision,
    effective_date date,
    expired_date date,
    retrodate date,
    retroyear text,
    retro_years integer,
    pickhighest boolean DEFAULT false NOT NULL,
    baseratevalue double precision,
    domicile_tax_rate double precision,
    state_tax_rate double precision,
    specialityfactor double precision,
    territory integer,
    territory_matched text,
    territoryfactor double precision,
    setupfactor double precision,
    setupfactorlable text,
    hours_worked_key text,
    hours_worked_title text,
    parttime_fulltime_factor double precision,
    limit_key text,
    incident_limit numeric(14,2),
    aggregate_limit numeric(14,2),
    limits_factor double precision,
    basemodifiertotal double precision,
    scheduledpremium numeric(14,4),
    totalschedulecreditdebit double precision,
    totalschedulecreditdebitamount numeric(14,2),
    credittotal_percentage double precision DEFAULT 0 NOT NULL,
    underwritercreditdebitamount numeric(14,2),
    creditdebitpercentagetotal double precision,
    credittotal numeric(14,2),
    premium numeric(14,2),
    deductible numeric(14,2),
    deductiblelable text,
    policy_fees_total numeric(14,2),
    rating_fees_total numeric(14,2),
    feestotal numeric(14,2),
    tax_total numeric(14,2),
    total numeric(14,2),
    combine_total numeric(14,2),
    inputs jsonb NOT NULL,
    flags text[] DEFAULT '{}'::text[] NOT NULL,
    missing text[] DEFAULT '{}'::text[] NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    -- true when the rating's own policy fees are in single_rating_policy_fees; false shows the submission's coverage_fees.
    policy_fees_stored boolean DEFAULT false NOT NULL,
    CONSTRAINT single_rating_check CHECK (((status = 'INCOMPLETE'::text) OR (premium IS NOT NULL))),
    CONSTRAINT single_rating_status_check CHECK ((status = ANY (ARRAY['QUOTED'::text, 'INCOMPLETE'::text]))),
    CONSTRAINT single_rating_territory_matched_check CHECK ((territory_matched = ANY (ARRAY['county'::text, 'remainder'::text])))
);

CREATE TABLE single_rating_fees (
    id bigint NOT NULL,
    rating_id uuid NOT NULL,
    sort_order integer NOT NULL,
    key text,
    lable text NOT NULL,
    calculate boolean DEFAULT false NOT NULL,
    value numeric(14,2),
    state text,
    percentageofcalculatedpremium double precision,
    percentageofearn double precision,
    required boolean DEFAULT false NOT NULL
);

CREATE SEQUENCE single_rating_fees_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE single_rating_fees_id_seq OWNED BY single_rating_fees.id;

-- The policy fees a rating was priced with. coverage_fees stays the submission's current set (the latest quote's), so
-- without this an older version would show fees it was never priced with.
CREATE TABLE single_rating_policy_fees (
    id bigserial PRIMARY KEY,
    rating_id uuid NOT NULL,
    sort_order integer NOT NULL,
    key text,
    title text NOT NULL,
    amount numeric(14,2) NOT NULL,
    percentageofearn double precision
);

CREATE TABLE single_rating_tax (
    id bigint NOT NULL,
    rating_id uuid NOT NULL,
    sort_order integer NOT NULL,
    lable text NOT NULL,
    rate double precision NOT NULL,
    value numeric(14,2) NOT NULL
);

CREATE SEQUENCE single_rating_tax_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE single_rating_tax_id_seq OWNED BY single_rating_tax.id;

CREATE TABLE skill_file_revisions (
    id bigint NOT NULL,
    skill_name text NOT NULL,
    file_path text NOT NULL,
    content text,
    content_hash text NOT NULL,
    skill_version text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE skill_file_revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE skill_file_revisions_id_seq OWNED BY skill_file_revisions.id;

CREATE TABLE specialities (
    id bigint NOT NULL,
    singlerating_id uuid NOT NULL,
    sort_order integer NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    description text,
    basedescription text,
    requested text NOT NULL,
    surgery_type text NOT NULL,
    location text NOT NULL,
    type text,
    factor double precision NOT NULL,
    class double precision NOT NULL,
    selectedclass double precision NOT NULL,
    practice_percentage double precision NOT NULL,
    matched_from text,
    isdelete boolean DEFAULT false NOT NULL,
    CONSTRAINT specialities_surgery_type_check CHECK ((surgery_type = ANY (ARRAY['Major Surgery'::text, 'Minor Surgery'::text, 'No Surgery'::text])))
);

CREATE SEQUENCE specialities_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE specialities_id_seq OWNED BY specialities.id;

CREATE TABLE submission_reads (
    user_id uuid NOT NULL,
    submission_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email_id uuid NOT NULL,
    status text DEFAULT 'NEW'::text NOT NULL,
    classification text,
    classification_confidence real,
    applicant_name text,
    assigned_to uuid,
    context_version integer DEFAULT 0 NOT NULL,
    processing_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    applicant_type text,
    applicant_first_name text,
    applicant_last_name text,
    applicant_entity_name text,
    duplicate_of uuid,
    duplicate_basis jsonb,
    content_fingerprint text,
    attachment_fingerprint text,
    normalized_subject text,
    body_fingerprint text,
    body_tail_fingerprint text,
    drive_folder_id text,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    primary_rating_id uuid,
    classification_reasons text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT submissions_applicant_name_parts_check CHECK ((((applicant_type IS NULL) AND (applicant_first_name IS NULL) AND (applicant_last_name IS NULL) AND (applicant_entity_name IS NULL)) OR ((applicant_type = 'INDIVIDUAL'::text) AND (applicant_entity_name IS NULL)) OR ((applicant_type = 'ORGANIZATION'::text) AND (applicant_first_name IS NULL) AND (applicant_last_name IS NULL)))),
    CONSTRAINT submissions_applicant_type_check CHECK ((applicant_type = ANY (ARRAY['INDIVIDUAL'::text, 'ORGANIZATION'::text]))),
    CONSTRAINT submissions_classification_check CHECK ((classification = ANY (ARRAY['SUBMISSION'::text, 'NOT_SUBMISSION'::text, 'REVIEW_REQUIRED'::text]))),
    CONSTRAINT submissions_duplicate_not_self CHECK ((duplicate_of <> id)),
    CONSTRAINT submissions_duplicate_status CHECK (((status = 'DUPLICATE'::text) = (duplicate_of IS NOT NULL))),
    CONSTRAINT submissions_status_check CHECK ((status = ANY (ARRAY['NEW'::text, 'PROCESSING'::text, 'READY_FOR_REVIEW'::text, 'IN_REVIEW'::text, 'COMPLETED'::text, 'NOT_SUBMISSION'::text, 'DUPLICATE'::text, 'ERROR'::text])))
);

CREATE TABLE system_errors (
    id bigint NOT NULL,
    scope text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cleared_at timestamp with time zone,
    cleared_by uuid
);

CREATE SEQUENCE system_errors_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE system_errors_id_seq OWNED BY system_errors.id;

CREATE TABLE us_location_master (
    id bigint NOT NULL,
    zip_code character varying(10) NOT NULL,
    city character varying(100) NOT NULL,
    county character varying(100),
    state_code character(2) NOT NULL,
    state_name character varying(100) NOT NULL,
    country_code character(2) DEFAULT 'US'::bpchar,
    is_active boolean DEFAULT true
);

ALTER TABLE us_location_master ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME us_location_master_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    -- disabled_at: a disabled user cannot sign in and every token they hold is rejected. token_version is copied into
    -- each token as `tv`; bumping it (role change, disable, password change, sign-out) revokes every token issued before.
    disabled_at timestamp with time zone,
    token_version integer DEFAULT 0 NOT NULL,
    password_changed_at timestamp with time zone,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['ADMIN'::text, 'UNDERWRITER'::text, 'VIEWER'::text])))
);

ALTER TABLE ONLY audit_events ALTER COLUMN id SET DEFAULT nextval('audit_events_id_seq'::regclass);

ALTER TABLE ONLY coverage_fees ALTER COLUMN id SET DEFAULT nextval('coverage_fees_id_seq'::regclass);

ALTER TABLE ONLY llm_calls ALTER COLUMN id SET DEFAULT nextval('llm_calls_id_seq'::regclass);

ALTER TABLE ONLY lookup_rate_territories ALTER COLUMN id SET DEFAULT nextval('lookup_rate_territories_id_seq'::regclass);

ALTER TABLE ONLY scheduledcreditsdebits ALTER COLUMN id SET DEFAULT nextval('scheduledcreditsdebits_id_seq'::regclass);

ALTER TABLE ONLY single_rating_fees ALTER COLUMN id SET DEFAULT nextval('single_rating_fees_id_seq'::regclass);

ALTER TABLE ONLY single_rating_tax ALTER COLUMN id SET DEFAULT nextval('single_rating_tax_id_seq'::regclass);

ALTER TABLE ONLY skill_file_revisions ALTER COLUMN id SET DEFAULT nextval('skill_file_revisions_id_seq'::regclass);

ALTER TABLE ONLY specialities ALTER COLUMN id SET DEFAULT nextval('specialities_id_seq'::regclass);

ALTER TABLE ONLY system_errors ALTER COLUMN id SET DEFAULT nextval('system_errors_id_seq'::regclass);

ALTER TABLE ONLY app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY assessments
    ADD CONSTRAINT assessments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY assessments
    ADD CONSTRAINT assessments_submission_id_version_key UNIQUE (submission_id, version);

ALTER TABLE ONLY attachment_gaps
    ADD CONSTRAINT attachment_gaps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY context_versions
    ADD CONSTRAINT context_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY context_versions
    ADD CONSTRAINT context_versions_submission_id_version_key UNIQUE (submission_id, version);

ALTER TABLE ONLY coverage_fees
    ADD CONSTRAINT coverage_fees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY emails
    ADD CONSTRAINT emails_gmail_message_id_key UNIQUE (gmail_message_id);

ALTER TABLE ONLY emails
    ADD CONSTRAINT emails_pkey PRIMARY KEY (id);

ALTER TABLE ONLY extracted_fields
    ADD CONSTRAINT extracted_fields_pkey PRIMARY KEY (id);

ALTER TABLE ONLY gmail_accounts
    ADD CONSTRAINT gmail_accounts_email_key UNIQUE (email);

ALTER TABLE ONLY gmail_accounts
    ADD CONSTRAINT gmail_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY gmail_ingest_queue
    ADD CONSTRAINT gmail_ingest_queue_pkey PRIMARY KEY (gmail_message_id);

ALTER TABLE ONLY llm_calls
    ADD CONSTRAINT llm_calls_pkey PRIMARY KEY (id);

ALTER TABLE ONLY lookup_rate_groups
    ADD CONSTRAINT lookup_rate_groups_pkey PRIMARY KEY (name);

ALTER TABLE ONLY lookup_rate_states
    ADD CONSTRAINT lookup_rate_states_pkey PRIMARY KEY (rate_group, state);

ALTER TABLE ONLY lookup_rate_step_ups
    ADD CONSTRAINT lookup_rate_step_ups_pkey PRIMARY KEY (rate_group, state, year);

ALTER TABLE ONLY lookup_rate_territories
    ADD CONSTRAINT lookup_rate_territories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY manual_fields
    ADD CONSTRAINT manual_fields_pkey PRIMARY KEY (id);

ALTER TABLE ONLY npi_verifications
    ADD CONSTRAINT npi_verifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY outbound_emails
    ADD CONSTRAINT outbound_emails_pkey PRIMARY KEY (id);

ALTER TABLE ONLY report_comparisons
    ADD CONSTRAINT report_comparisons_pkey PRIMARY KEY (id);

ALTER TABLE ONLY reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY reports
    ADD CONSTRAINT reports_submission_id_kind_version_key UNIQUE (submission_id, kind, version);

ALTER TABLE ONLY scheduledcreditsdebits
    ADD CONSTRAINT scheduledcreditsdebits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY single_rating_fees
    ADD CONSTRAINT single_rating_fees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY single_rating
    ADD CONSTRAINT single_rating_pkey PRIMARY KEY (id);

ALTER TABLE ONLY single_rating
    ADD CONSTRAINT single_rating_submission_id_version_key UNIQUE (submission_id, version);

ALTER TABLE ONLY single_rating_tax
    ADD CONSTRAINT single_rating_tax_pkey PRIMARY KEY (id);

ALTER TABLE ONLY skill_file_revisions
    ADD CONSTRAINT skill_file_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY specialities
    ADD CONSTRAINT specialities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY submission_reads
    ADD CONSTRAINT submission_reads_pkey PRIMARY KEY (user_id, submission_id);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY system_errors
    ADD CONSTRAINT system_errors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY us_location_master
    ADD CONSTRAINT us_location_master_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

-- Each key once per rate group: rating looks rows up by key (the importer rejects repeats).
ALTER TABLE ONLY lookup_rate_limits
    ADD CONSTRAINT lookup_rate_limits_key_uniq UNIQUE (rate_group, key);

ALTER TABLE ONLY lookup_rate_hours
    ADD CONSTRAINT lookup_rate_hours_key_uniq UNIQUE (rate_group, key);

ALTER TABLE ONLY lookup_rate_credits
    ADD CONSTRAINT lookup_rate_credits_key_uniq UNIQUE (rate_group, key);

ALTER TABLE ONLY lookup_rate_fees
    ADD CONSTRAINT lookup_rate_fees_key_uniq UNIQUE (rate_group, key);

ALTER TABLE ONLY lookup_rate_policy_fees
    ADD CONSTRAINT lookup_rate_policy_fees_key_uniq UNIQUE (rate_group, key);

ALTER TABLE ONLY lookup_rate_speciality_factors
    ADD CONSTRAINT lookup_rate_speciality_factors_uniq UNIQUE (rate_group, code, state, surgery_type);

CREATE INDEX attachment_gaps_submission_idx ON attachment_gaps USING btree (submission_id);

CREATE INDEX audit_created_idx ON audit_events USING btree (created_at DESC);

CREATE INDEX audit_submission_idx ON audit_events USING btree (submission_id, created_at DESC);

CREATE INDEX chat_messages_submission_idx ON chat_messages USING btree (submission_id, created_at DESC);

CREATE INDEX coverage_fees_submission_idx ON coverage_fees USING btree (submission_id);

CREATE UNIQUE INDEX documents_drive_file_idx ON documents USING btree (storage_key) WHERE (storage_backend = 'GDRIVE'::text);

CREATE INDEX documents_sha256_idx ON documents USING btree (sha256);

CREATE INDEX documents_submission_idx ON documents USING btree (submission_id);

CREATE INDEX emails_rfc_message_id_idx ON emails USING btree (rfc_message_id) WHERE (rfc_message_id IS NOT NULL);

CREATE INDEX extracted_fields_submission_idx ON extracted_fields USING btree (submission_id);

CREATE INDEX gmail_ingest_queue_due_idx ON gmail_ingest_queue USING btree (next_attempt_at);

CREATE INDEX idx_us_location_state_city ON us_location_master USING btree (state_code, city);

CREATE INDEX idx_us_location_zip ON us_location_master USING btree (zip_code);

-- One row per ZIP and county (a NULL county counts once).
CREATE UNIQUE INDEX us_location_master_zip_county_uniq ON us_location_master USING btree (zip_code, COALESCE(county, ''));

CREATE UNIQUE INDEX jobs_queued_key ON jobs (dedupe_key) WHERE status = 'queued';

CREATE INDEX jobs_due ON jobs (run_after, id) WHERE status = 'queued';

CREATE INDEX jobs_running_key ON jobs (dedupe_key, locked_until) WHERE status = 'running';

CREATE INDEX jobs_lease ON jobs (locked_until) WHERE status = 'running';

CREATE INDEX jobs_finished ON jobs (finished_at) WHERE status IN ('done', 'failed');

CREATE INDEX llm_calls_created_idx ON llm_calls USING btree (created_at DESC);

CREATE INDEX llm_calls_submission_idx ON llm_calls USING btree (submission_id);

CREATE INDEX lookup_rate_limits_idx ON lookup_rate_limits USING btree (rate_group, state);

CREATE INDEX lookup_rate_speciality_factors_idx ON lookup_rate_speciality_factors USING btree (rate_group, state);

CREATE INDEX lookup_rate_territories_idx ON lookup_rate_territories USING btree (rate_group, state);

-- Territory keys may be blank in the workbook; only filled-in keys must be unique.
CREATE UNIQUE INDEX lookup_rate_territories_key_uniq ON lookup_rate_territories USING btree (rate_group, key) WHERE key <> '';

CREATE INDEX manual_fields_submission_idx ON manual_fields USING btree (submission_id, field_name);

CREATE INDEX npi_submission_idx ON npi_verifications USING btree (submission_id);

CREATE UNIQUE INDEX npi_submission_npi_uniq ON npi_verifications USING btree (submission_id, npi);

CREATE INDEX outbound_emails_submission_idx ON outbound_emails USING btree (submission_id, sent_at DESC);

CREATE UNIQUE INDEX outbound_emails_idempotency_idx ON outbound_emails USING btree (sent_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX report_comparisons_pair_idx ON report_comparisons USING btree (base_report_id, target_report_id, skill_version) WHERE (status <> 'FAILED'::text);

CREATE INDEX report_comparisons_submission_idx ON report_comparisons USING btree (submission_id, created_at DESC);

CREATE INDEX scheduledcreditsdebits_rating_idx ON scheduledcreditsdebits USING btree (singlerating);

CREATE INDEX single_rating_fees_rating_idx ON single_rating_fees USING btree (rating_id);

CREATE INDEX single_rating_policy_fees_rating_idx ON single_rating_policy_fees USING btree (rating_id);

CREATE INDEX single_rating_tax_rating_idx ON single_rating_tax USING btree (rating_id);

CREATE INDEX skill_file_revisions_file_idx ON skill_file_revisions USING btree (skill_name, file_path, id DESC);

CREATE INDEX specialities_rating_idx ON specialities USING btree (singlerating_id);

CREATE INDEX submission_reads_submission_idx ON submission_reads USING btree (submission_id);

CREATE INDEX submissions_assigned_idx ON submissions USING btree (assigned_to) WHERE (assigned_to IS NOT NULL);

CREATE INDEX submissions_attachment_fp_idx ON submissions USING btree (attachment_fingerprint) WHERE (attachment_fingerprint IS NOT NULL);

CREATE INDEX submissions_body_fp_idx ON submissions USING btree (body_fingerprint) WHERE (body_fingerprint IS NOT NULL);

CREATE INDEX submissions_body_tail_fp_idx ON submissions USING btree (body_tail_fingerprint) WHERE (body_tail_fingerprint IS NOT NULL);

CREATE INDEX submissions_content_fp_idx ON submissions USING btree (content_fingerprint);

CREATE INDEX submissions_duplicate_of_idx ON submissions USING btree (duplicate_of) WHERE (duplicate_of IS NOT NULL);

CREATE INDEX submissions_email_idx ON submissions USING btree (email_id);

CREATE INDEX submissions_live_idx ON submissions USING btree (status) WHERE (deleted_at IS NULL);

CREATE INDEX submissions_norm_subject_idx ON submissions USING btree (normalized_subject);

CREATE INDEX submissions_status_idx ON submissions USING btree (status);

CREATE INDEX submissions_updated_idx ON submissions USING btree (updated_at DESC);

CREATE INDEX system_errors_open_idx ON system_errors USING btree (id) WHERE (cleared_at IS NULL);

CREATE TRIGGER audit_events_no_update BEFORE DELETE OR UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

ALTER TABLE ONLY app_settings
    ADD CONSTRAINT app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id);

ALTER TABLE ONLY assessments
    ADD CONSTRAINT assessments_analysis_report_id_fkey FOREIGN KEY (analysis_report_id) REFERENCES reports(id);

ALTER TABLE ONLY assessments
    ADD CONSTRAINT assessments_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY assessments
    ADD CONSTRAINT assessments_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY attachment_gaps
    ADD CONSTRAINT attachment_gaps_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id);

ALTER TABLE ONLY chat_messages
    ADD CONSTRAINT chat_messages_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY chat_messages
    ADD CONSTRAINT chat_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY context_versions
    ADD CONSTRAINT context_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY context_versions
    ADD CONSTRAINT context_versions_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY coverage_fees
    ADD CONSTRAINT coverage_fees_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY extracted_fields
    ADD CONSTRAINT extracted_fields_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE ONLY extracted_fields
    ADD CONSTRAINT extracted_fields_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY llm_calls
    ADD CONSTRAINT llm_calls_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE SET NULL;

ALTER TABLE ONLY manual_fields
    ADD CONSTRAINT manual_fields_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY manual_fields
    ADD CONSTRAINT manual_fields_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE ONLY manual_fields
    ADD CONSTRAINT manual_fields_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY manual_fields
    ADD CONSTRAINT manual_fields_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id);

ALTER TABLE ONLY npi_verifications
    ADD CONSTRAINT npi_verifications_added_by_fkey FOREIGN KEY (added_by) REFERENCES users(id);

ALTER TABLE ONLY npi_verifications
    ADD CONSTRAINT npi_verifications_override_by_fkey FOREIGN KEY (override_by) REFERENCES users(id);

ALTER TABLE ONLY npi_verifications
    ADD CONSTRAINT npi_verifications_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY outbound_emails
    ADD CONSTRAINT outbound_emails_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES users(id);

ALTER TABLE ONLY outbound_emails
    ADD CONSTRAINT outbound_emails_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY lookup_rate_credits
    ADD CONSTRAINT rate_credits_rate_group_fkey FOREIGN KEY (rate_group) REFERENCES lookup_rate_groups(name) ON DELETE CASCADE;

ALTER TABLE ONLY lookup_rate_fees
    ADD CONSTRAINT rate_fees_rate_group_fkey FOREIGN KEY (rate_group) REFERENCES lookup_rate_groups(name) ON DELETE CASCADE;

ALTER TABLE ONLY lookup_rate_hours
    ADD CONSTRAINT rate_hours_rate_group_fkey FOREIGN KEY (rate_group) REFERENCES lookup_rate_groups(name) ON DELETE CASCADE;

ALTER TABLE ONLY lookup_rate_limits
    ADD CONSTRAINT rate_limits_rate_group_fkey FOREIGN KEY (rate_group) REFERENCES lookup_rate_groups(name) ON DELETE CASCADE;

ALTER TABLE ONLY lookup_rate_policy_fees
    ADD CONSTRAINT rate_policy_fees_rate_group_fkey FOREIGN KEY (rate_group) REFERENCES lookup_rate_groups(name) ON DELETE CASCADE;

ALTER TABLE ONLY lookup_rate_speciality_factors
    ADD CONSTRAINT rate_speciality_factors_rate_group_fkey FOREIGN KEY (rate_group) REFERENCES lookup_rate_groups(name) ON DELETE CASCADE;

ALTER TABLE ONLY lookup_rate_states
    ADD CONSTRAINT rate_states_rate_group_fkey FOREIGN KEY (rate_group) REFERENCES lookup_rate_groups(name) ON DELETE CASCADE;

ALTER TABLE ONLY lookup_rate_step_ups
    ADD CONSTRAINT rate_step_ups_rate_group_fkey FOREIGN KEY (rate_group) REFERENCES lookup_rate_groups(name) ON DELETE CASCADE;

ALTER TABLE ONLY lookup_rate_territories
    ADD CONSTRAINT rate_territories_rate_group_fkey FOREIGN KEY (rate_group) REFERENCES lookup_rate_groups(name) ON DELETE CASCADE;

ALTER TABLE ONLY report_comparisons
    ADD CONSTRAINT report_comparisons_base_report_id_fkey FOREIGN KEY (base_report_id) REFERENCES reports(id) ON DELETE CASCADE;

ALTER TABLE ONLY report_comparisons
    ADD CONSTRAINT report_comparisons_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY report_comparisons
    ADD CONSTRAINT report_comparisons_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY report_comparisons
    ADD CONSTRAINT report_comparisons_target_report_id_fkey FOREIGN KEY (target_report_id) REFERENCES reports(id) ON DELETE CASCADE;

ALTER TABLE ONLY reports
    ADD CONSTRAINT reports_based_on_report_id_fkey FOREIGN KEY (based_on_report_id) REFERENCES reports(id);

ALTER TABLE ONLY reports
    ADD CONSTRAINT reports_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY reports
    ADD CONSTRAINT reports_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduledcreditsdebits
    ADD CONSTRAINT scheduledcreditsdebits_singlerating_fkey FOREIGN KEY (singlerating) REFERENCES single_rating(id) ON DELETE CASCADE;

ALTER TABLE ONLY single_rating
    ADD CONSTRAINT single_rating_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY single_rating_fees
    ADD CONSTRAINT single_rating_fees_rating_id_fkey FOREIGN KEY (rating_id) REFERENCES single_rating(id) ON DELETE CASCADE;

ALTER TABLE ONLY single_rating_policy_fees
    ADD CONSTRAINT single_rating_policy_fees_rating_id_fkey FOREIGN KEY (rating_id) REFERENCES single_rating(id) ON DELETE CASCADE;

ALTER TABLE ONLY single_rating
    ADD CONSTRAINT single_rating_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY single_rating_tax
    ADD CONSTRAINT single_rating_tax_rating_id_fkey FOREIGN KEY (rating_id) REFERENCES single_rating(id) ON DELETE CASCADE;

ALTER TABLE ONLY skill_file_revisions
    ADD CONSTRAINT skill_file_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY specialities
    ADD CONSTRAINT specialities_singlerating_id_fkey FOREIGN KEY (singlerating_id) REFERENCES single_rating(id) ON DELETE CASCADE;

ALTER TABLE ONLY submission_reads
    ADD CONSTRAINT submission_reads_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY submission_reads
    ADD CONSTRAINT submission_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES users(id);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_duplicate_of_fkey FOREIGN KEY (duplicate_of) REFERENCES submissions(id);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_email_id_fkey FOREIGN KEY (email_id) REFERENCES emails(id);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_primary_rating_id_fkey FOREIGN KEY (primary_rating_id) REFERENCES single_rating(id) ON DELETE SET NULL;

ALTER TABLE ONLY system_errors
    ADD CONSTRAINT system_errors_cleared_by_fkey FOREIGN KEY (cleared_by) REFERENCES users(id);
