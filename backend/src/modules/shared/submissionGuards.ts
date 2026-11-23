import type { Queryable } from '../../db/pool.js';
import { AppError, notFound } from '../../http.js';

/** Checks every submission-scoped module makes before touching a submission. */

/** Whether the submission exists and is not deleted (hidden). */
export async function isLiveSubmission(db: Queryable, submissionId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM submissions WHERE id=$1 AND deleted_at IS NULL', [submissionId]);
  return !!rowCount;
}

/** 404 for a submission that does not exist or was deleted (hidden); its reports, chat, mail etc. go with it. */
export async function requireLiveSubmission(db: Queryable, submissionId: string): Promise<void> {
  if (!(await isLiveSubmission(db, submissionId))) throw notFound('Submission');
}

/** Duplicates are held back; only POST /submissions/:id/duplicate moves a submission in or out of that state. */
export function assertNotDuplicate(status: string): void {
  if (status === 'DUPLICATE') {
    throw new AppError(
      'IS_DUPLICATE',
      409,
      'This email is held as a duplicate; mark it "not a duplicate" to process it',
    );
  }
}

/** Emails still being processed are refused, so no job finishes on a changed or hidden submission. */
export function assertNotProcessing(status: string, message: string): void {
  if (status === 'NEW' || status === 'PROCESSING') throw new AppError('STILL_PROCESSING', 409, message);
}
