import { EMAIL_DRAFT_BODY_MAX_CHARS } from '../constants.js';
import { pool, withTransaction } from '../db/pool.js';
import { AppError } from '../http.js';
import { audit } from './audit.js';
import { claudeAvailable, structuredCall } from './claude.js';
import { effectiveFields } from './fields.js';
import { describeError } from './friendlyError.js';
import { jobLeaseLost } from './jobContext.js';
import { jobs } from './jobQueue.js';
import { limits } from './limitsSettings.js';
import { assertLlmBudget } from './llmUsage.js';
import { scrubText } from './piiScrub.js';
import { escapeAttr, escapeContent, INJECTION_NOTE } from './promptSafety.js';
import { quoteContext } from './rating/quote.js';
import { type EmailAudience, type EmailDrafts, EmailDraftSchema } from './reportSchemas.js';
import { loadSkill } from './skills.js';

/**
 * Draft Emails dialog. Generate stores a PENDING draft and returns at once (202); the `email-draft` job asks Claude and
 * fills it in (COMPLETED) or records why it could not (FAILED). The dialog polls GET while a run is pending and keeps
 * showing the last completed draft meanwhile. One run per submission and audience at a time.
 */

export interface EmailDraftResult extends EmailDrafts {
  id: string;
  audience: EmailAudience;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  analysisReportId: string;
  analysisVersion: number;
  synthesisVersion: number;
  /** A completed analysis newer than the one these drafts were written from, if any. */
  newerAnalysisVersion: number | null;
  /** The evidence changed after the analysis ran: the drafts may miss something. */
  stale: boolean;
  model: string;
}

/** A generation newer than the last completed draft: still running, or failed (with the reason). */
export interface DraftRun {
  id: string;
  status: 'PENDING' | 'FAILED';
  error: string | null;
  createdAt: string;
}
export interface EmailDraftState {
  draft: EmailDraftResult | null;
  run: DraftRun | null;
}

const PENDING_DRAFT_INDEX = 'email_drafts_one_pending_idx';
const DRAFT_INTERRUPTED = 'Drafting was interrupted. Generate again.';

/** The newest completed draft for a submission and audience, or null when none was generated yet. */
export async function latestEmailDrafts(
  submissionId: string,
  audience: EmailAudience,
): Promise<EmailDraftResult | null> {
  const {
    rows: [d],
  } = await pool.query(
    `SELECT d.id, d.content, d.model, d.created_at, d.created_by, u.name AS created_by_name,
       a.id AS analysis_id, a.version AS analysis_version, a.context_version AS analysis_context,
       syn.version AS synthesis_version, s.context_version AS submission_context,
       (SELECT max(r.version) FROM reports r WHERE r.submission_id=d.submission_id AND r.kind='ANALYSIS' AND r.status='COMPLETED'
          AND r.version > a.version) AS newer_analysis_version
     FROM email_drafts d JOIN reports a ON a.id=d.analysis_report_id JOIN submissions s ON s.id=d.submission_id
     LEFT JOIN reports syn ON syn.id=a.based_on_report_id LEFT JOIN users u ON u.id=d.created_by
     WHERE d.submission_id=$1 AND d.audience=$2 AND d.status='COMPLETED' ORDER BY d.created_at DESC LIMIT 1`,
    [submissionId, audience],
  );
  if (!d) return null;
  return {
    ...(d.content as EmailDrafts),
    id: d.id,
    audience,
    createdAt: new Date(d.created_at).toISOString(),
    createdBy: d.created_by ? { id: d.created_by, name: d.created_by_name } : null,
    analysisReportId: d.analysis_id,
    analysisVersion: d.analysis_version,
    synthesisVersion: d.synthesis_version,
    newerAnalysisVersion: d.newer_analysis_version ?? null,
    stale: d.analysis_context < d.submission_context,
    model: d.model,
  };
}

/** The last completed draft plus the newest generation after it, if that one is still running or failed. */
export async function emailDraftState(submissionId: string, audience: EmailAudience): Promise<EmailDraftState> {
  const [
    draft,
    {
      rows: [last],
    },
  ] = await Promise.all([
    latestEmailDrafts(submissionId, audience),
    pool.query(
      'SELECT id, status, error, created_at FROM email_drafts WHERE submission_id=$1 AND audience=$2 ORDER BY created_at DESC LIMIT 1',
      [submissionId, audience],
    ),
  ]);
  const run: DraftRun | null =
    last && last.status !== 'COMPLETED'
      ? {
          id: last.id,
          status: last.status,
          error: last.error ?? null,
          createdAt: new Date(last.created_at).toISOString(),
        }
      : null;
  return { draft, run };
}

/** Saves the underwriter's manual edits to a draft in place (subject and body only). Still never sent. */
export async function updateEmailDraft(
  submissionId: string,
  draftId: string,
  edit: { subject: string; body: string },
): Promise<EmailDraftResult> {
  const {
    rows: [row],
  } = await pool.query(
    `UPDATE email_drafts
        SET content = jsonb_set(jsonb_set(content, '{draft,subject}', to_jsonb($3::text)), '{draft,body}', to_jsonb($4::text))
      WHERE id=$1 AND submission_id=$2 AND status='COMPLETED' RETURNING audience`,
    [draftId, submissionId, edit.subject, edit.body],
  );
  if (!row?.audience) throw new AppError('NOT_FOUND', 404, 'Draft not found');
  return (await latestEmailDrafts(submissionId, row.audience))!;
}

/** Pending drafts whose job is gone (a crash after its last attempt) are failed, so they no longer block Generate. */
async function failOrphanedDrafts(submissionId: string | null): Promise<void> {
  await pool.query(
    `UPDATE email_drafts d SET status='FAILED', error=$2 WHERE d.status='PENDING' AND ($1::uuid IS NULL OR d.submission_id=$1)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key='email-draft:' || d.id AND j.status IN ('queued', 'running'))`,
    [submissionId, DRAFT_INTERRUPTED],
  );
}

/** Startup recovery: pending drafts whose job is gone are failed (the dialog offers Generate again). */
export const failInterruptedDrafts = () => failOrphanedDrafts(null);

/**
 * Generate clicked: check what the draft needs (an API key, a completed analysis, a quote for the quote email), then
 * queue it. Runs only when the underwriter clicks Generate; each run is saved, never sent.
 */
export async function requestEmailDraft(
  submissionId: string,
  userId: string,
  audience: EmailAudience,
): Promise<EmailDraftState> {
  if (!claudeAvailable())
    throw new AppError('LLM_UNAVAILABLE', 503, 'No Anthropic API key is set: add one in Settings → Claude API');
  const {
    rows: [analysis],
  } = await pool.query(
    `SELECT a.id FROM reports a JOIN reports syn ON syn.id=a.based_on_report_id
     WHERE a.submission_id=$1 AND a.kind='ANALYSIS' AND a.status='COMPLETED' AND syn.content_json IS NOT NULL
       AND a.version = (SELECT max(version) FROM reports WHERE submission_id=$1 AND kind='ANALYSIS' AND status='COMPLETED')`,
    [submissionId],
  );
  if (!analysis) throw new AppError('NO_ANALYSIS', 409, 'Run the analysis first: the drafts are based on it');
  if (audience === 'quote' && (await quoteContext(submissionId)).includes('No quote has been created yet')) {
    throw new AppError('NO_QUOTE', 409, 'Create a quote first: the quote email is based on it');
  }
  await assertLlmBudget({ submissionId, task: 'email_draft' });
  await failOrphanedDrafts(submissionId);
  try {
    await withTransaction(async (db) => {
      const {
        rows: [d],
      } = await db.query(
        `INSERT INTO email_drafts (submission_id, analysis_report_id, audience, status, created_by) VALUES ($1,$2,$3,'PENDING',$4) RETURNING id`,
        [submissionId, analysis.id, audience, userId],
      );
      await jobs.enqueue('email-draft', `email-draft:${d.id}`, { draftId: d.id }, { db });
    });
  } catch (err) {
    const pg = err as { code?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint === PENDING_DRAFT_INDEX) {
      throw new AppError('DRAFT_RUNNING', 409, 'This email is already being drafted; wait for it to finish');
    }
    throw err;
  }
  return emailDraftState(submissionId, audience);
}

/** The `email-draft` job: write one pending draft from the analysis it was requested on. */
async function writeDraft(draftId: string): Promise<void> {
  const {
    rows: [row],
  } = await pool.query(
    'SELECT submission_id, analysis_report_id, audience, status, created_by FROM email_drafts WHERE id=$1',
    [draftId],
  );
  if (!row || row.status !== 'PENDING') return;
  const submissionId: string = row.submission_id;
  const audience: EmailAudience = row.audience;
  try {
    const {
      rows: [ctx],
    } = await pool.query(
      `SELECT e.from_address, e.to_address, e.subject, e.received_at, e.body_text,
         a.version AS analysis_version, a.content_json AS analysis, syn.version AS synthesis_version, syn.content_json AS synthesis
       FROM submissions s JOIN emails e ON e.id=s.email_id JOIN reports a ON a.id=$2 LEFT JOIN reports syn ON syn.id=a.based_on_report_id
       WHERE s.id=$1`,
      [submissionId, row.analysis_report_id],
    );
    if (!ctx?.synthesis) throw new AppError('NO_ANALYSIS', 409, 'Run the analysis first: the drafts are based on it');

    const contacts = (await effectiveFields(submissionId))
      .filter((f) => f.fieldName === 'contact_name' || f.fieldName === 'contact_email')
      .map(
        (f) => `- ${f.fieldName}: ${f.value} [source: ${f.manual ? 'manual entry by an underwriter' : f.sourceLabel}]`,
      );
    const body = String(ctx.body_text ?? '');
    const quote = audience === 'quote' ? await quoteContext(submissionId) : null;
    if (quote?.includes('No quote has been created yet'))
      throw new AppError('NO_QUOTE', 409, 'Create a quote first: the quote email is based on it');

    const skill = loadSkill('email-draft');
    const { data, usage, model } = await structuredCall({
      skill,
      schema: EmailDraftSchema,
      effort: 'low',
      task: 'email_draft',
      maxTokens: limits().emailDraftMaxTokens,
      submissionId,
      // Every value from the submission or a report is escaped (promptSafety.ts), as in the report prompts.
      prompt: `${INJECTION_NOTE}

<audience>${audience}</audience>

<email>
${escapeContent(`From: ${ctx.from_address}
To: ${ctx.to_address}
Received: ${new Date(ctx.received_at).toISOString()}
Subject: ${ctx.subject}

${body.length > EMAIL_DRAFT_BODY_MAX_CHARS ? `${body.slice(0, EMAIL_DRAFT_BODY_MAX_CHARS)}\n[...email truncated]` : body}`)}
</email>

<contact_fields>
${escapeContent(contacts.join('\n') || '(none)')}
</contact_fields>

<synthesis_report version="${escapeAttr(ctx.synthesis_version)}">
${escapeContent(JSON.stringify(ctx.synthesis, null, 2))}
</synthesis_report>

<underwriting_analysis version="${escapeAttr(ctx.analysis_version)}">
${escapeContent(JSON.stringify(ctx.analysis, null, 2))}
</underwriting_analysis>
${
  quote
    ? `
${quote}
`
    : ''
}
Write the ${audience} draft as the structured JSON object, following the skill instructions. contact_fields may belong to the broker or to the insured: use an address for the insured only when it is clearly the applicant's.`,
    });

    await pool.query(
      `UPDATE email_drafts SET content=$2, model=$3, skill_version=$4, status='COMPLETED', error=NULL WHERE id=$1`,
      [draftId, JSON.stringify(data), model, skill.version],
    );
    await audit({
      action: 'EMAIL_DRAFT_GENERATED',
      entityType: 'email_draft',
      entityId: draftId,
      submissionId,
      actorId: row.created_by,
      details: {
        audience,
        analysisVersion: ctx.analysis_version,
        purpose: data.purpose,
        model,
        skillVersion: skill.version,
        usage,
      },
    });
  } catch (err) {
    if (jobLeaseLost()) throw err; // another worker owns the job now and records its outcome
    const { message, detail } = describeError(err);
    await pool.query(`UPDATE email_drafts SET status='FAILED', error=$2 WHERE id=$1`, [
      draftId,
      message.slice(0, 2000),
    ]);
    await audit({
      action: 'EMAIL_DRAFT_FAILED',
      entityType: 'email_draft',
      entityId: draftId,
      submissionId,
      actorId: row.created_by,
      details: { audience, error: message, ...(detail ? { detail: scrubText(detail).slice(0, 2000) } : {}) },
    });
    throw err;
  }
}

// A crash mid-run (lapsed lease) runs it again while the row is still PENDING; an error does not (each costs a Claude call).
jobs.register('email-draft', ({ draftId }) => writeDraft(draftId), { retryOnError: false });
