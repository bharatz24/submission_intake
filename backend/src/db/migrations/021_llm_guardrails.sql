-- LLM guardrails, phase 1 (docs/superpowers/specs/2026-11-17-llm-guardrails-design.md §1–3).
--
-- Grounding (services/grounding.ts): each Synthesis/Analysis and chat answer is graded against the submission's
-- source text after the model call. Shape { checked, verified, unverified, items: [{ path, text, verdict, missing }] },
-- items holding the unverified ones only. NULL = not graded (rows written before this check, or grading failed).
ALTER TABLE reports ADD COLUMN IF NOT EXISTS grounding jsonb;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS grounding jsonb;

-- Review of automatic output: a report or quote with created_by NULL (Automation = AUTO) "needs review" until a
-- person acknowledges it, or records an assessment on the submission.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id);
ALTER TABLE single_rating ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE single_rating ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id);

-- Instruction-like text found in inbound email bodies and attachment text (services/injectionScan.ts). Flagged, never
-- blocked; a rescan replaces the submission's rows. document_id NULL = the email body.
CREATE TABLE IF NOT EXISTS injection_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('override','role','ai_address','steering','exfiltration','hidden_text')),
  pattern text NOT NULL,
  excerpt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS injection_flags_submission_idx ON injection_flags(submission_id);
CREATE INDEX IF NOT EXISTS injection_flags_document_idx ON injection_flags(document_id);
