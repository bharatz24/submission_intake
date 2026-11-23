-- Hand-off of an accepted submission to IMS 2's Submission Intake queue (services/ims2IntakeQueue.ts,
-- routes/ims2Queue.ts). One row per submission; intake_id is the submission id and IMS 2's idempotency key. IMS 2
-- never creates the record itself: one of its users claims the intake, creates the submission and links it.
-- state: SENDING while a push is in flight, QUEUED once IMS 2 holds it (status new), LINKED once an IMS 2 user linked
-- it to a submission (final), REJECTED when an IMS 2 user rejected it (fix and resend), ERROR when IMS 2 refused the
-- push (400 / 409 / 413 / 401 / 503), FAILED when IMS 2 could not be reached (resend is safe).
CREATE TABLE IF NOT EXISTS ims2_intake_queue (
    submission_id uuid PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
    intake_id text NOT NULL UNIQUE,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    state text NOT NULL CHECK (state IN ('SENDING', 'QUEUED', 'LINKED', 'REJECTED', 'ERROR', 'FAILED')),
    -- The payload last sent, and its hash without `version`: an unchanged resend keeps the version, a changed one bumps it.
    payload jsonb NOT NULL,
    payload_hash text NOT NULL,
    last_http_status integer,
    last_error text,
    -- Payload path IMS 2 named in a 400 (policy.effectiveDate, insured.npi, ...).
    last_error_field text,
    ims_submission_id integer,
    ims_submission_number text,
    ims_insured_id text,
    -- IMS 2's status url: absolute when IMS 2 has SUBMISSION_INTAKE_APP_URL, otherwise a path (/policy-log/101).
    ims_url text,
    -- Last IntakeStatus seen (single status, bulk sync or a 409 body).
    remote_status jsonb,
    remote_status_changed_at timestamp with time zone,
    remote_checked_at timestamp with time zone,
    rejected_reason text,
    sent_by uuid NOT NULL REFERENCES users(id),
    sent_at timestamp with time zone NOT NULL DEFAULT now(),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (state <> 'LINKED' OR ims_submission_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ims2_intake_queue_state_idx ON ims2_intake_queue (state);
