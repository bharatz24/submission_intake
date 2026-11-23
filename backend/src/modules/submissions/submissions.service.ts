import { withTransaction } from '../../db/pool.js';
import type { AppDeps } from '../../deps.js';
import { AppError, type AuthUser, notFound } from '../../http.js';
import { audit } from '../../services/audit.js';
import { bumpContextVersion } from '../../services/contextVersion.js';
import { type DuplicateBasis, rootOf } from '../../services/duplicates.js';
import { addUploadedDocuments, enqueueProcessing, ingestEmail } from '../../services/pipeline.js';
import { getSubmissionDetail } from '../../services/queries.js';
import { canTransition, MANUAL_TRANSITIONS, type SubmissionStatus } from '../../services/statusTransitions.js';
import { assertNotProcessing, isLiveSubmission } from '../shared/submissionGuards.js';
import { storageUnavailable } from '../shared/uploads.js';
import * as repo from './submissions.repository.js';
import type { ClassificationBody, DuplicateBody, UploadBody } from './submissions.schemas.js';

export interface SubmissionUpdate {
  /** A review state set by hand; DUPLICATE is never set here (POST /submissions/:id/duplicate does that). */
  status?: Exclude<SubmissionStatus, 'DUPLICATE'>;
  /** The underwriter who owns the submission; null unassigns it. */
  assignedToId?: string | null;
}

type Attachment = Parameters<typeof addUploadedDocuments>[1][number];
const DAY_MS = 86_400_000;

/** A submission's own state: detail, upload, review status and owner, classification, duplicate link. */
export function createSubmissionsService({ db, clock }: Pick<AppDeps, 'db' | 'clock'>) {
  return {
    get: (id: string) => getSubmissionDetail(id),

    /** A new submission from an uploaded email and its files; `created` false when the Gmail id was already imported. */
    async upload(body: UploadBody, attachments: Attachment[], actorId: string) {
      const { submissionId, created } = await ingestEmail(
        {
          gmailMessageId: body.gmailMessageId ?? null,
          rfcMessageId: body.rfcMessageId ?? null,
          threadId: body.threadId ?? null,
          fromAddress: body.fromAddress,
          toAddress: body.toAddress,
          subject: body.subject,
          bodyText: body.bodyText,
          receivedAt: body.receivedAt ?? clock.now(),
          attachments,
        },
        actorId,
      ).catch(storageUnavailable);
      return { created, submission: await getSubmissionDetail(submissionId) };
    },

    /** Documents added by hand; their text is extracted in the background (the detail shows PENDING). */
    async addDocuments(id: string, files: Attachment[], actorId: string) {
      await getSubmissionDetail(id);
      if (!files.length) throw new AppError('VALIDATION_ERROR', 400, 'Choose at least one file to upload');
      const documentIds = await addUploadedDocuments(id, files, actorId).catch(storageUnavailable);
      return { documentIds, submission: await getSubmissionDetail(id) };
    },

    async update(id: string, change: SubmissionUpdate, actor: AuthUser) {
      // Only active accounts take work: a disabled user would never see it.
      if (change.assignedToId && !(await repo.isActiveUser(db, change.assignedToId))) {
        throw new AppError('VALIDATION_ERROR', 400, 'Unknown or disabled user');
      }
      // Read, check and write under a row lock, so the pipeline or another reviewer cannot change the status in between.
      await withTransaction(async (tx) => {
        const before = await repo.lockForUpdate(tx, id);
        if (!before) throw notFound('Submission');
        if (change.status) {
          if (before.status === 'DUPLICATE') {
            throw new AppError(
              'IS_DUPLICATE',
              409,
              'This email is held as a duplicate; mark it "not a duplicate" to process it',
            );
          }
          // Only review states are set by hand (services/statusTransitions.ts); reprocessing and overrides do the rest.
          if (!canTransition(before.status, change.status)) {
            const allowed = MANUAL_TRANSITIONS[before.status] ?? [];
            throw new AppError(
              'INVALID_TRANSITION',
              409,
              `A submission cannot be moved from ${before.status} to ${change.status} by hand${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ''}`,
              { from: before.status, to: change.status, allowed },
            );
          }
          await repo.setStatus(tx, id, change.status);
        }
        if (change.assignedToId !== undefined) await repo.setAssignee(tx, id, change.assignedToId);
        await audit(
          {
            action: 'SUBMISSION_UPDATED',
            entityType: 'submission',
            entityId: id,
            submissionId: id,
            actorId: actor.id,
            details: { from: { status: before.status, assignedTo: before.assigned_to }, to: change },
          },
          tx,
        );
      });
      return getSubmissionDetail(id);
    },

    /** An underwriter's verdict on what the email is; releases a duplicate or a held email, and processes it when needed. */
    async overrideClassification(id: string, body: ClassificationBody, actor: AuthUser) {
      // Status read and update under one row lock, so the pipeline cannot change it in between.
      const before = await withTransaction(async (tx) => {
        const cur = await repo.lockClassification(tx, id);
        if (!cur) throw notFound('Submission');
        assertNotProcessing(
          cur.status,
          'This email is still being processed; change its classification once processing finishes',
        );
        const wasDuplicate = cur.status === 'DUPLICATE';
        if (wasDuplicate) {
          // Overriding a duplicate's classification says it is not a duplicate: release it first.
          await repo.releaseDuplicateForClassification(tx, id, body.classification);
          await audit(
            {
              action: 'DUPLICATE_CLEARED',
              entityType: 'submission',
              entityId: id,
              submissionId: id,
              actorId: actor.id,
              details: {
                originalId: cur.duplicate_of,
                previousBasis: cur.duplicate_basis,
                reason: body.reason,
                to: body.classification,
              },
            },
            tx,
          );
        }
        await repo.overrideClassification(
          tx,
          id,
          body.classification,
          `Manual override by ${actor.name}: ${body.reason}`,
        );
        await audit(
          {
            action: 'CLASSIFICATION_OVERRIDDEN',
            entityType: 'submission',
            entityId: id,
            submissionId: id,
            actorId: actor.id,
            details: {
              from: wasDuplicate ? 'DUPLICATE' : cur.classification,
              to: body.classification,
              reason: body.reason,
            },
          },
          tx,
        );
        if (body.classification === 'NOT_SUBMISSION') await repo.markNotSubmission(tx, id);
        // Held for a verdict (manual classification, uncertain email): a definite one releases it; REVIEW_REQUIRED keeps it held.
        if (cur.held_for_classification && body.classification !== 'REVIEW_REQUIRED')
          await repo.releaseClassificationHold(tx, id);
        return cur;
      });
      if (
        body.classification !== 'NOT_SUBMISSION' &&
        (before.status === 'NOT_SUBMISSION' || before.status === 'DUPLICATE')
      ) {
        await enqueueProcessing(id, actor.id, { skipClassification: true, byPerson: true });
      } else if (body.classification === 'SUBMISSION' && before.held_for_classification) {
        // Released by the verdict alone, not a re-run: the remaining steps follow their own Settings → Automation modes.
        await enqueueProcessing(id, actor.id, { skipClassification: true });
      }
      await bumpContextVersion(id, 'Classification override', actor.id);
      return getSubmissionDetail(id);
    },

    /**
     * Mark as a duplicate of another submission (resolved to its original), or clear with duplicateOfId null:
     * "not a duplicate" releases it into the pipeline, classification included when it never ran.
     */
    async setDuplicate(id: string, body: DuplicateBody, actor: AuthUser) {
      const before = await getSubmissionDetail(id);
      if (body.duplicateOfId === null) {
        // Check and release under a row lock, so two releases (or a release and a re-mark) cannot interleave.
        await withTransaction(async (tx) => {
          const cur = await repo.lockDuplicateState(tx, id);
          if (!cur) throw notFound('Submission');
          if (cur.status !== 'DUPLICATE')
            throw new AppError('NOT_DUPLICATE', 409, 'This submission is not marked as a duplicate');
          await repo.clearDuplicate(tx, id);
          await audit(
            {
              action: 'DUPLICATE_CLEARED',
              entityType: 'submission',
              entityId: id,
              submissionId: id,
              actorId: actor.id,
              details: { originalId: cur.duplicate_of, previousBasis: cur.duplicate_basis, reason: body.reason },
            },
            tx,
          );
        });
        await enqueueProcessing(id, actor.id, { skipClassification: true, byPerson: true });
        return getSubmissionDetail(id);
      }

      if (before.status === 'NEW' || before.status === 'PROCESSING')
        throw new AppError('NOT_READY', 409, 'Submission is still being processed');
      // A deleted (hidden) submission cannot be an original.
      if (!(await isLiveSubmission(db, body.duplicateOfId))) throw notFound('Original submission');
      const originalId = await rootOf(db, body.duplicateOfId);
      if (originalId === id)
        throw new AppError('VALIDATION_ERROR', 400, 'A submission cannot be a duplicate of itself');
      const originalReceived = await repo.receivedAt(db, originalId);
      const basis: DuplicateBasis = {
        rule: 'MANUAL',
        strength: 'CERTAIN',
        similarity: null,
        sharedAttachments: [],
        originalId,
        method: 'MANUAL',
        daysSinceOriginal: Math.round(
          Math.abs(new Date(before.receivedAt!).getTime() - new Date(originalReceived!).getTime()) / DAY_MS,
        ),
        by: actor.id,
        reason: body.reason,
        explanation: `Marked as a duplicate by ${actor.name}: ${body.reason}`,
      };
      await withTransaction(async (tx) => {
        const cur = await repo.lockForUpdate(tx, id);
        if (!cur) throw notFound('Submission');
        if (cur.status === 'NEW' || cur.status === 'PROCESSING')
          throw new AppError('NOT_READY', 409, 'Submission is still being processed');
        await repo.repointCopies(tx, id, originalId);
        await repo.markDuplicate(tx, id, originalId, basis);
        await audit(
          {
            action: 'DUPLICATE_MARKED',
            entityType: 'submission',
            entityId: id,
            submissionId: id,
            actorId: actor.id,
            details: { ...basis, previousStatus: before.status },
          },
          tx,
        );
      });
      return getSubmissionDetail(id);
    },
  };
}
