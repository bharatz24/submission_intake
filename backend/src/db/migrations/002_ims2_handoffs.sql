-- Hand-off of an accepted submission to IMS 2 as an Intake Draft (services/ims2.ts, routes/ims2.ts). One row per
-- submission. draft_id is stable and is IMS 2's idempotency key: a resend of the same draft_id + draft_version never
-- creates a second record there. draft_version goes up when the reviewer pushes a changed draft before IMS 2 accepted one.
-- state: PENDING while a push is in flight, ACCEPTED once IMS 2 created (or already had) the record, REJECTED when
-- IMS 2 refused the draft (fix it and push again), FAILED when IMS 2 could not be reached or is misconfigured.
CREATE TABLE ims2_handoffs (
    submission_id uuid PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
    draft_id text NOT NULL UNIQUE,
    draft_version integer NOT NULL DEFAULT 1 CHECK (draft_version >= 1),
    state text NOT NULL CHECK (state IN ('PENDING', 'ACCEPTED', 'REJECTED', 'FAILED')),
    -- The draft last sent, and its hash: an unchanged resend keeps the version, a changed one bumps it.
    payload jsonb NOT NULL,
    payload_hash text NOT NULL,
    last_http_status integer,
    last_error text,
    -- Draft path IMS 2 named in a 400 (policy.recordType, insured.locations.0.zipcode, ...).
    last_error_field text,
    ims_submission_id integer,
    ims_submission_number text,
    ims_insured_id text,
    created_insured boolean,
    -- Path in IMS 2 (/policy-log/101); the UI prefixes IMS2_APP_URL.
    ims_url text,
    -- Last GET /intake/drafts/:id/status answer (status open/bound/closed, policyNumber, deleted, ...).
    remote_status jsonb,
    remote_checked_at timestamp with time zone,
    pushed_by uuid NOT NULL REFERENCES users(id),
    pushed_at timestamp with time zone NOT NULL DEFAULT now(),
    accepted_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (state <> 'ACCEPTED' OR ims_submission_id IS NOT NULL)
);
