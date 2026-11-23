import type { Queryable } from '../../db/pool.js';
import type { CountRow } from '../../db/rows.js';

/** SQL for the Monitoring page: pipeline counts over a period, recent errors, and clearing them. */

const toMap = (rows: CountRow[], key: string) => Object.fromEntries(rows.map((r) => [r[key], r.n]));

/** Counts since `since` (null: all time), the errors not yet cleared, and the OAuth mailbox's last poll. */
export async function pipelineCounts(db: Queryable, since: Date | null) {
  // DB-08: all time leaves the condition out instead of `($1 IS NULL OR col >= $1)`, which a generic plan cannot index.
  const params = since ? [since] : [];
  const inRange = (col: string) => (since ? `${col} >= $1::timestamptz` : 'true');
  const [byStatus, byClass, reports, failed, emails, errors, account, dups] = await Promise.all([
    db.query<CountRow>(
      `SELECT status, count(*)::int AS n FROM submissions WHERE deleted_at IS NULL AND ${inRange('created_at')} GROUP BY status`,
      params,
    ),
    db.query<CountRow>(
      `SELECT classification, count(*)::int AS n FROM submissions WHERE deleted_at IS NULL AND classification IS NOT NULL AND ${inRange('created_at')} GROUP BY classification`,
      params,
    ),
    db.query<CountRow>(
      `SELECT kind, count(*)::int AS n FROM reports WHERE ${inRange('created_at')} AND status='COMPLETED' GROUP BY kind`,
      params,
    ),
    db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reports WHERE ${inRange('created_at')} AND status='FAILED'`,
      params,
    ),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM emails WHERE ${inRange('created_at')}`, params),
    db.query(
      `SELECT created_at, scope, message FROM system_errors WHERE cleared_at IS NULL AND ${inRange('created_at')} ORDER BY id DESC LIMIT 50`,
      params,
    ),
    db.query<{ last_poll_at: Date | null }>('SELECT last_poll_at FROM gmail_accounts LIMIT 1'),
    db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action='DUPLICATE_DETECTED' AND details->>'outcome'='DUPLICATE' AND ${inRange('created_at')}`,
      params,
    ),
  ]);
  const r = toMap(reports.rows, 'kind');
  return {
    byStatus: toMap(byStatus.rows, 'status'),
    byClassification: toMap(byClass.rows, 'classification'),
    reports: { SYNTHESIS: r.SYNTHESIS ?? 0, ANALYSIS: r.ANALYSIS ?? 0 },
    failedReports: failed.rows[0]?.n ?? 0,
    emails: emails.rows[0]?.n ?? 0,
    duplicates: dups.rows[0]?.n ?? 0,
    oauthLastPollAt: account.rows[0]?.last_poll_at ?? null,
    recentErrors: errors.rows.map((e) => ({
      at: new Date(e.created_at).toISOString(),
      scope: e.scope,
      message: e.message,
    })),
  };
}

/** Hides every error shown on Monitoring; the rows stay for reconciliation and the audit trail. */
export async function clearErrors(db: Queryable, actorId: string): Promise<number> {
  const { rowCount } = await db.query(
    'UPDATE system_errors SET cleared_at=now(), cleared_by=$1 WHERE cleared_at IS NULL',
    [actorId],
  );
  return rowCount ?? 0;
}

export interface LlmTranscript {
  callId: string;
  task: string;
  model: string;
  createdAt: string;
  submissionId: string | null;
  systemSha256: string;
  promptSha256: string;
  prompt: string | null;
  output: string | null;
}

/** One call's transcript with its call metadata; null when the call or its transcript does not exist. */
export async function llmTranscript(db: Queryable, callId: string): Promise<LlmTranscript | null> {
  const {
    rows: [r],
  } = await db.query(
    `SELECT l.id, l.task, l.model, l.created_at, l.submission_id, t.system_sha256, t.prompt_sha256, t.prompt, t.output
     FROM llm_transcripts t JOIN llm_calls l ON l.id=t.llm_call_id WHERE t.llm_call_id=$1`,
    [callId],
  );
  if (!r) return null;
  return {
    callId: String(r.id),
    task: r.task,
    model: r.model,
    createdAt: new Date(r.created_at).toISOString(),
    submissionId: r.submission_id ?? null,
    systemSha256: r.system_sha256,
    promptSha256: r.prompt_sha256,
    prompt: r.prompt ?? null,
    output: r.output ?? null,
  };
}
