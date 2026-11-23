import type { AppDeps } from '../../deps.js';
import { AppError, notFound } from '../../http.js';
import { logger } from '../../logger.js';
import { audit } from '../../services/audit.js';
import { runInBackground, start, taskSnapshot } from '../../services/backgroundTasks.js';
import { GmailSendError } from '../../services/gmail.js';
import { listFailed, retryMessage, retryNow } from '../../services/ingestQueue.js';
import { deleteSkippedEmails, listSkippedEmails } from '../../services/pipeline.js';

export type SkippedProcessStatus =
  | { state: 'running' | 'idle' }
  | { state: 'done'; submissionId: string }
  | { state: 'failed'; error: { code: string; status: number; message: string } };

const skippedTaskKey = (id: string) => `skipped-import:${id}`;

/** The coded failure of the last run per message (an AppError keeps its code and status for the client). */
const lastFailure = new Map<string, { code: string; status: number; message: string }>();

/** The Gmail ingest queue and skipped emails, through the injected Gmail client. */
export function createIntakeService({ db, gmail }: Pick<AppDeps, 'db' | 'gmail'>) {
  /**
   * Drains the queue in the background; a failure is logged, never answered (the request has its answer). Netlify:
   * worker (a poll can take minutes); await it before answering.
   */
  const pollSoon = (why: string): Promise<void> =>
    runInBackground(
      `gmail:${why}`,
      () => gmail.pollOnce().catch((err) => logger.error({ err }, `${why} poll failed`)),
      { worker: { task: 'gmail-poll' } },
    );

  return {
    failed: () => listFailed(),

    async retryOne(id: string, actorId: string) {
      if (!(await retryMessage(id))) throw notFound('Failed Gmail message');
      await audit({ action: 'INGEST_RETRY_REQUESTED', entityType: 'gmail_message', entityId: id, actorId });
      await pollSoon('manual ingest retry');
    },

    async retryAll(actorId: string) {
      const queued = await retryNow();
      await audit({ action: 'INGEST_RETRY_REQUESTED', entityType: 'gmail_ingest_queue', actorId, details: { queued } });
      await pollSoon('retry-now');
      return queued;
    },

    skipped: (q: { q?: string; limit: number; offset: number }) => listSkippedEmails(q),

    /** Hide skipped emails from the Ignored tab; Gmail still never imports them again. */
    deleteSkipped: (actorId: string, sel: { ids?: string[]; q?: string }) => deleteSkippedEmails(actorId, sel),

    /**
     * "Process as submission" (PERF-01): fetching the email and its attachments from Gmail again and storing them runs
     * in the background; the request answers at once. False when this email is already being processed here.
     * `processSkippedStatus` reports the outcome.
     */
    async processSkipped(id: string, actor: { id: string; name: string }): Promise<boolean> {
      const { rowCount } = await db.query(
        'SELECT 1 FROM skipped_emails WHERE gmail_message_id=$1 AND deleted_at IS NULL',
        [id],
      );
      if (!rowCount) throw notFound('Skipped email');
      // Netlify: awaited in the request (one email and its attachments), and a failure is the request's answer.
      return start(
        skippedTaskKey(id),
        async () => {
          lastFailure.delete(id);
          const submissionId = await gmail.importSkippedMessage(id, actor).catch((err) => {
            if (err instanceof GmailSendError) throw new AppError('GMAIL_NOT_CONNECTED', 409, err.message);
            throw err;
          });
          if (!submissionId)
            throw new AppError('GMAIL_MESSAGE_GONE', 410, 'The email is no longer in the Gmail mailbox');
          return { submissionId };
        },
        (err) => {
          // An unexpected error keeps its text out of the answer (500, like the error handler does).
          lastFailure.set(
            id,
            err instanceof AppError
              ? { code: err.code, status: err.status, message: err.message }
              : { code: 'INTERNAL', status: 500, message: 'Processing the email failed; try again' },
          );
        },
      );
    },

    /**
     * Where "Process as submission" stands: done (with the new submission, read from the database, so any instance
     * answers it), running or failed (this instance's run), or idle (never started here and not imported).
     */
    async processSkippedStatus(id: string): Promise<SkippedProcessStatus> {
      const task = taskSnapshot(skippedTaskKey(id));
      if (task.running) return { state: 'running' };
      const {
        rows: [done],
      } = await db.query<{ id: string }>(
        `SELECT s.id FROM emails e JOIN submissions s ON s.email_id = e.id
         WHERE e.gmail_message_id=$1 AND s.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM skipped_emails k WHERE k.gmail_message_id=$1)
         ORDER BY s.created_at DESC LIMIT 1`,
        [id],
      );
      if (done) return { state: 'done', submissionId: done.id };
      if (task.error) {
        const failure = lastFailure.get(id);
        return { state: 'failed', error: failure ?? { code: 'PROCESS_FAILED', status: 500, message: task.error } };
      }
      return { state: 'idle' };
    },
  };
}
