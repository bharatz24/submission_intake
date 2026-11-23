import type { AppDeps } from '../../deps.js';
import { askChat, listChat } from '../../services/chat.js';
import { emailDraftState, requestEmailDraft, updateEmailDraft } from '../../services/emailDraft.js';
import { mapOutbound, OUTBOUND_SELECT, sendOutbound } from '../../services/outbound.js';
import { getSubmissionDetail } from '../../services/queries.js';
import type { EmailAudience } from '../../services/reportSchemas.js';
import { requireLiveSubmission } from '../shared/submissionGuards.js';
import type { OutboundBody } from './conversations.schemas.js';

/**
 * Talking about and from a submission: the underwriter chat, email drafts (one per audience, never sent), and replies
 * or forwards sent from the mailbox (services/outbound.ts, through the Gmail client).
 */
export function createConversationsService({ db }: Pick<AppDeps, 'db'>) {
  return {
    async chat(id: string) {
      await requireLiveSubmission(db, id);
      return listChat(id);
    },

    /** The question and its PENDING answer; the answer is written by a job (poll the chat until it is not PENDING). */
    async ask(id: string, userId: string, message: string) {
      await getSubmissionDetail(id);
      return askChat(id, userId, message);
    },

    /** The last completed draft for an audience and a newer generation still running or failed (each null when none). */
    async draft(id: string, audience: EmailAudience) {
      await requireLiveSubmission(db, id);
      return emailDraftState(id, audience);
    },

    /** Queues a new draft, only when the underwriter clicks Generate. */
    async requestDraft(id: string, userId: string, audience: EmailAudience) {
      await requireLiveSubmission(db, id);
      return requestEmailDraft(id, userId, audience);
    },

    /** Manual edits made in the dialog are saved onto the draft itself (no Claude call). */
    async editDraft(id: string, draftId: string, edit: { subject: string; body: string }) {
      await requireLiveSubmission(db, id);
      return updateEmailDraft(id, draftId, edit);
    },

    async sent(id: string) {
      await requireLiveSubmission(db, id);
      const { rows } = await db.query(`${OUTBOUND_SELECT} WHERE o.submission_id=$1 ORDER BY o.sent_at DESC`, [id]);
      return rows.map(mapOutbound);
    },

    /** A retry with the same idempotency key answers the email already sent (`replayed`) instead of sending it again. */
    send: (id: string, body: OutboundBody, idempotencyKey: string | null, actorId: string) =>
      sendOutbound(id, { ...body, idempotencyKey }, actorId),
  };
}
