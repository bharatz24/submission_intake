-- DB-01 / CQ-03: audit_events must not keep applicant data, and a submission must be erasable.
--
-- 1. The append-only trigger allows exactly one change: the foreign key's ON DELETE SET NULL when a submission is
--    hard-deleted (erasure, docs/data-retention.md). The UPDATE it fires is let through only when it does nothing
--    but null submission_id AND that submission no longer exists; every other UPDATE, DELETE or TRUNCATE still fails.
--    The rows stay (actor, action, entity, time); only the link to the erased submission goes.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.submission_id IS NOT NULL AND NEW.submission_id IS NULL
       AND (to_jsonb(NEW) - 'submission_id') = (to_jsonb(OLD) - 'submission_id')
       AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.id = OLD.submission_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;

-- Same columns, now ON DELETE SET NULL. The old constraint enforced the same reference, so validation cannot fail.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_submission_id_fkey;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_submission_id_fkey
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE audit_events VALIDATE CONSTRAINT audit_events_submission_id_fkey;

-- 2. One-off redaction of rows written before services/audit.ts stopped storing applicant data. This is the only
--    sanctioned rewrite of audit_events: the trigger is disabled for this transaction only (the migrator runs each
--    file in one transaction, so a failure re-enables it by rolling back) and switched on again below.
--    What goes, at any depth of details (same list as AUDIT_PHI_KEYS in services/audit.ts): field values, file names,
--    email subjects, duplicate evidence (shared attachment names, added/removed words, explanation), claimed name/
--    state/specialty, evidence quotes, bodies. A list under one of those keys becomes "<key>Count".
--    An applicant NPI is cut to its last four digits (npiLast4).
--    Per action: notes on manual fields and NPI checks; the registry search terms (name, ZIP) of NPI searches; sender
--    and classifier reasons on received/skipped emails;
--    raw error text on processing failures and document reads (it could quote a document) becomes "[redacted]".
-- OR REPLACE: a temporary function lives as long as the session, and the migrator's connection is pooled.
CREATE OR REPLACE FUNCTION pg_temp.audit_strip_phi(d jsonb, extra text[]) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  phi constant text[] := ARRAY['value', 'filename', 'filenames', 'subject', 'originalSubject', 'sharedAttachments',
    'addedWords', 'removedWords', 'explanation', 'evidenceQuote', 'bodyText', 'claimedName', 'claimedState',
    'claimedSpecialty'];
  k text;
  v jsonb;
  out jsonb := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(d) = 'array' THEN
    RETURN COALESCE((SELECT jsonb_agg(pg_temp.audit_strip_phi(x, extra)) FROM jsonb_array_elements(d) x), '[]'::jsonb);
  ELSIF jsonb_typeof(d) <> 'object' OR d IS NULL THEN
    RETURN d;
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(d) LOOP
    IF k = 'npi' AND jsonb_typeof(v) = 'string' THEN
      out := out || jsonb_build_object('npiLast4', right(regexp_replace(v #>> '{}', '\D', '', 'g'), 4));
    ELSIF k = ANY (phi) OR k = ANY (extra) OR (k = 'attachments' AND jsonb_typeof(v) = 'array') THEN
      IF jsonb_typeof(v) = 'array' THEN
        out := out || jsonb_build_object(k || 'Count', jsonb_array_length(v));
      END IF;
    ELSE
      out := out || jsonb_build_object(k, pg_temp.audit_strip_phi(v, extra));
    END IF;
  END LOOP;
  RETURN out;
END;
$$;

ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update;

UPDATE audit_events a
   SET details = x.cleaned
  FROM (
    SELECT id, pg_temp.audit_strip_phi(details,
             CASE
               WHEN action LIKE 'MANUAL_FIELD_%' THEN ARRAY['note']
               WHEN action LIKE 'NPI_%' THEN ARRAY['note', 'query']
               WHEN action IN ('EMAIL_RECEIVED', 'EMAIL_SKIPPED') THEN ARRAY['from', 'reasons']
               ELSE ARRAY[]::text[]
             END) AS cleaned
      FROM audit_events
     WHERE action LIKE 'MANUAL_FIELD_%' OR action LIKE 'NPI_%' OR action LIKE 'DUPLICATE_%'
        OR action IN ('EMAIL_RECEIVED', 'EMAIL_SKIPPED')
        OR details ?| ARRAY['npi', 'value', 'filename', 'filenames', 'subject', 'originalSubject', 'sharedAttachments',
             'addedWords', 'removedWords', 'explanation', 'evidenceQuote', 'bodyText', 'claimedName', 'claimedState',
             'claimedSpecialty', 'attachments', 'previousBasis']
  ) x
 WHERE a.id = x.id AND x.cleaned IS DISTINCT FROM a.details;

UPDATE audit_events
   SET details = (details - 'detail') || jsonb_build_object('error', '[redacted]')
 WHERE action IN ('PROCESSING_FAILED', 'PROCESSING_RETRY_SCHEDULED', 'DOCUMENT_EXTRACTED')
   AND jsonb_typeof(details -> 'error') = 'string';

ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update;

DROP FUNCTION pg_temp.audit_strip_phi(jsonb, text[]);
