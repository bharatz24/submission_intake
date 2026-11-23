import { CHAT_HISTORY_TURNS } from '../constants.js';
import { pool, withTransaction } from '../db/pool.js';
import { AppError } from '../http.js';
import { audit } from './audit.js';
import { stripArithmeticPrefix } from './chatAnswer.js';
import { chatCall, claudeAvailable } from './claude.js';
import { describeError } from './friendlyError.js';
import { gradeChatAnswer, type Grounding } from './grounding.js';
import { jobLeaseLost } from './jobContext.js';
import { jobs } from './jobQueue.js';
import { assertLlmBudget } from './llmUsage.js';
import { scrubText } from './piiScrub.js';
import { escapeAttr, escapeContent } from './promptSafety.js';
import { quoteContext } from './rating/quote.js';
import { buildEvidence, gradeSafely, groundingCorpus, splitSafetyNotice } from './reports.js';
import { loadSkill } from './skills.js';

/**
 * Workspace chat. Asking stores the question and a PENDING answer and returns at once (202); the `chat` job asks
 * Claude and fills the answer in (COMPLETED) or records why it could not (FAILED). The client polls GET /chat while an
 * answer is pending. One pending answer per submission: the next question waits for it.
 */

export type ChatStatus = 'PENDING' | 'COMPLETED' | 'FAILED';
export interface ChatMessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  userName: string | null;
  status: ChatStatus;
  error: string | null;
  /** Answers only: values in the answer checked against the submission (services/grounding.ts); null = not graded. */
  grounding: Grounding | null;
}

const PENDING_ANSWER_INDEX = 'chat_messages_one_pending_idx';
const ANSWER_INTERRUPTED = 'The answer was interrupted. Ask again.';

/** Pending answers whose job is gone (a crash after its last attempt) are failed, so they no longer block the chat. */
async function failOrphanedAnswers(submissionId: string | null): Promise<void> {
  await pool.query(
    `UPDATE chat_messages m SET status='FAILED', error=$2 WHERE m.status='PENDING' AND ($1::uuid IS NULL OR m.submission_id=$1)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key='chat:' || m.id AND j.status IN ('queued', 'running'))`,
    [submissionId, ANSWER_INTERRUPTED],
  );
}

/** Store the question and queue its answer; returns both rows (the answer PENDING). */
export async function askChat(submissionId: string, userId: string, message: string): Promise<ChatMessageView[]> {
  if (!claudeAvailable())
    throw new AppError('LLM_UNAVAILABLE', 503, 'No Anthropic API key is set: add one in Settings → Claude API');
  // Checked before the question is stored, so a refused request leaves no unanswered message behind.
  await assertLlmBudget({ submissionId, task: 'chat' });
  await failOrphanedAnswers(submissionId);
  try {
    const ids = await withTransaction(async (db) => {
      const {
        rows: [q],
      } = await db.query(
        'INSERT INTO chat_messages (submission_id, user_id, role, content) VALUES ($1,$2,$3,$4) RETURNING id',
        [submissionId, userId, 'user', message],
      );
      const {
        rows: [a],
      } = await db.query(
        `INSERT INTO chat_messages (submission_id, user_id, role, content, status, reply_to) VALUES ($1,NULL,'assistant','','PENDING',$2) RETURNING id`,
        [submissionId, q.id],
      );
      await jobs.enqueue('chat', `chat:${a.id}`, { messageId: a.id }, { db });
      return [q.id as string, a.id as string];
    });
    return (await listChat(submissionId)).filter((m) => ids.includes(m.id));
  } catch (err) {
    const pg = err as { code?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint === PENDING_ANSWER_INDEX) {
      throw new AppError(
        'CHAT_BUSY',
        409,
        'Claude is still answering the last question; ask again once it has answered',
      );
    }
    throw err;
  }
}

/** The `chat` job: answer one pending question. Failures are recorded on the row, not retried (each costs a Claude call). */
async function answerQuestion(messageId: string): Promise<void> {
  const {
    rows: [a],
  } = await pool.query(
    `SELECT a.submission_id, a.status, q.id AS question_id, q.content AS question, q.user_id AS asker, q.created_at AS asked_at
     FROM chat_messages a JOIN chat_messages q ON q.id=a.reply_to WHERE a.id=$1`,
    [messageId],
  );
  if (!a || a.status !== 'PENDING') return;
  const submissionId: string = a.submission_id;
  try {
    const [evidence, quotes, reports, history] = await Promise.all([
      buildEvidence(submissionId, { npi: 'all' }),
      quoteContext(submissionId),
      pool.query(
        `SELECT DISTINCT ON (kind) kind, version, content_markdown FROM reports
         WHERE submission_id=$1 AND status='COMPLETED' ORDER BY kind, version DESC`,
        [submissionId],
      ),
      // Earlier answered turns only: a question whose answer failed or is still pending is left out.
      pool.query(
        `SELECT m.role, m.content FROM chat_messages m
         WHERE m.submission_id=$1 AND m.status='COMPLETED' AND m.created_at < $2
           AND NOT EXISTS (SELECT 1 FROM chat_messages r WHERE r.reply_to=m.id AND r.status <> 'COMPLETED')
         ORDER BY m.created_at DESC, (m.role = 'assistant') DESC LIMIT $3`,
        [submissionId, a.asked_at, CHAT_HISTORY_TURNS],
      ),
    ]);
    // Reports are generated from untrusted evidence, so their text is escaped like the evidence itself (promptSafety.ts).
    // The safety notice (sources with instruction-like text) goes ahead of all submission data, not inside <evidence>.
    const { notice, evidence: evidenceBody } = splitSafetyNotice(evidence);
    const context = `${notice ? `${notice}\n\n` : ''}${reports.rows.map((r) => `<report kind="${escapeAttr(r.kind)}" version="${escapeAttr(r.version)}">\n${escapeContent(r.content_markdown)}\n</report>`).join('\n\n')}\n\n${quotes}\n\n<evidence>\n${evidenceBody}\n</evidence>`;
    const prior = history.rows.reverse() as { role: 'user' | 'assistant'; content: string }[];
    // The submission context rides in the first user turn (claude.ts chatMessages), never in the system prompt.
    const skill = loadSkill('workspace-chat');
    const { text, usage, model, truncated, callId } = await chatCall({
      skill,
      context,
      messages: [...prior, { role: 'user', content: a.question }],
      submissionId,
    });
    const answer = stripArithmeticPrefix(text) || '_(no answer)_';
    // Graded against what this call saw: the evidence, the latest reports and the quote context.
    const grounding = await gradeSafely({ submissionId, messageId }, async () =>
      gradeChatAnswer(
        answer,
        await groundingCorpus(
          submissionId,
          [
            ...reports.rows.map((r) => ({ label: 'report', text: (r.content_markdown as string | null) ?? '' })),
            { label: 'quote', text: quotes },
          ],
          { evidence },
        ),
      ),
    );
    await pool.query(
      `UPDATE chat_messages SET content=$2, status='COMPLETED', error=NULL, grounding=$3, llm_call_id=$4 WHERE id=$1`,
      [messageId, answer, grounding === null ? null : JSON.stringify(grounding), callId ?? null],
    );
    await audit({
      action: 'CHAT_QUESTION',
      entityType: 'chat_message',
      entityId: messageId,
      submissionId,
      actorId: a.asker,
      details: { model, skillVersion: skill.version, usage, chars: a.question.length, truncated: !!truncated },
    });
  } catch (err) {
    if (jobLeaseLost()) throw err; // another worker owns the job now and records its outcome
    const { message, detail } = describeError(err);
    await pool.query(`UPDATE chat_messages SET status='FAILED', error=$2 WHERE id=$1`, [
      messageId,
      message.slice(0, 2000),
    ]);
    await audit({
      action: 'CHAT_FAILED',
      entityType: 'chat_message',
      entityId: messageId,
      submissionId,
      actorId: a.asker,
      details: { error: message, ...(detail ? { detail: scrubText(detail).slice(0, 2000) } : {}) },
    });
    throw err;
  }
}

// A crash mid-answer (lapsed lease) runs it again while the row is still PENDING; an error does not.
jobs.register('chat', ({ messageId }) => answerQuestion(messageId), { retryOnError: false });

/** Startup recovery: pending answers whose job is gone are failed (the asker sees "Ask again"). */
export const failInterruptedChat = () => failOrphanedAnswers(null);

export async function listChat(submissionId: string): Promise<ChatMessageView[]> {
  const { rows } = await pool.query(
    `SELECT c.*, u.name AS user_name FROM chat_messages c LEFT JOIN users u ON u.id=c.user_id WHERE submission_id=$1
     ORDER BY c.created_at, (c.role = 'assistant')`,
    [submissionId],
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: new Date(r.created_at).toISOString(),
    userName: r.user_name,
    status: r.status,
    error: r.error ?? null,
    grounding: r.grounding ?? null,
  }));
}
