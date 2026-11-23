import { withTransaction } from '../../db/pool.js';
import type { AppDeps } from '../../deps.js';
import { isPgUniqueViolation } from '../../errorHandler.js';
import { AppError, type AuthUser, notFound } from '../../http.js';
import { audit } from '../../services/audit.js';
import * as repo from './assessments.repository.js';
import {
  ACCEPT_DECISIONS,
  NOT_ASSESSABLE,
  type RecordAssessmentInput,
  TERMINAL_DECISIONS,
} from './assessments.schemas.js';

/** Why an accept decision is refused: the underwriter is told what to fix in Coverage & Rating. */
const NO_PRIMARY_QUOTE_MESSAGE =
  'This submission cannot be accepted yet because it has no primary quote. Open Coverage & Rating, price a quote and make it the primary one, then accept. You can still refer, request information or decline.';
const UNPRICED_PRIMARY_QUOTE_MESSAGE =
  'This submission cannot be accepted yet because its primary quote has no premium or total above $0. Open Coverage & Rating and price the primary quote (or make a priced quote primary), then accept. You can still refer, request information or decline.';

/**
 * Underwriter assessments: append-only versions of a decision and risk rating. Recording one also moves the
 * submission to COMPLETED (accept, accept with conditions, decline) or IN_REVIEW (refer, request information).
 */
export function createAssessmentsService({ db }: Pick<AppDeps, 'db'>) {
  return {
    async list(submissionId: string) {
      if (!(await repo.isLiveSubmission(db, submissionId))) throw notFound('Submission');
      return repo.listAssessments(db, submissionId);
    },

    async record(submissionId: string, input: RecordAssessmentInput, actor: AuthUser) {
      const analysisReportId = input.analysisReportId ?? null;
      if (analysisReportId && !(await repo.isAnalysisOf(db, analysisReportId, submissionId))) {
        throw new AppError('VALIDATION_ERROR', 400, 'analysisReportId does not belong to this submission');
      }
      // Version number, status and audit row together under the submission's row lock: two reviewers recording at
      // once get versions n and n+1, never a clash (a unique violation that slips through still answers 409).
      const id = await withTransaction(async (tx) => {
        const sub = await repo.lockSubmission(tx, submissionId);
        if (!sub) throw notFound('Submission');
        if ((NOT_ASSESSABLE as readonly string[]).includes(sub.status)) {
          throw new AppError(
            'NOT_READY',
            409,
            `An assessment cannot be recorded while the submission is ${sub.status}`,
          );
        }
        // Accepting binds terms, so there must be a priced primary quote to bind; checked under the row lock so a
        // primary change in flight cannot slip past it.
        if (ACCEPT_DECISIONS.includes(input.decision)) {
          const primary = await repo.primaryQuotePricing(tx, submissionId);
          if (!primary) throw new AppError('NO_PRIMARY_QUOTE', 409, NO_PRIMARY_QUOTE_MESSAGE);
          if (!((primary.premium ?? 0) > 0 && (primary.total ?? 0) > 0)) {
            throw new AppError('PRIMARY_QUOTE_NOT_PRICED', 409, UNPRICED_PRIMARY_QUOTE_MESSAGE);
          }
        }
        const entry = {
          submissionId,
          decision: input.decision,
          riskRating: input.riskRating,
          notes: input.notes,
          analysisReportId,
        };
        // A double click or a repeat save would only add a copy of the current decision to the history.
        if (await repo.sameAsLatest(tx, entry)) {
          throw new AppError(
            'DUPLICATE_ASSESSMENT',
            409,
            'This decision is already the current one. Change the outcome, risk level, report or reason to record a new one.',
          );
        }
        const created = await repo.insertAssessment(tx, {
          ...entry,
          contextVersion: sub.context_version,
          createdBy: actor.id,
        });
        await repo.setSubmissionStatus(
          tx,
          submissionId,
          TERMINAL_DECISIONS.includes(input.decision) ? 'COMPLETED' : 'IN_REVIEW',
        );
        await audit(
          {
            action: 'ASSESSMENT_RECORDED',
            entityType: 'assessment',
            entityId: created,
            submissionId,
            actorId: actor.id,
            details: {
              decision: input.decision,
              riskRating: input.riskRating,
              analysisReportId,
              contextVersion: sub.context_version,
            },
          },
          tx,
        );
        // The decision is the review of whatever was generated automatically.
        const reviewed = await repo.markAutomaticOutputReviewed(tx, submissionId, actor.id);
        for (const r of reviewed.reports)
          await audit(
            {
              action: 'REPORT_REVIEWED',
              entityType: 'report',
              entityId: r.id,
              submissionId,
              actorId: actor.id,
              details: { kind: r.kind, version: r.version, assessmentId: created },
            },
            tx,
          );
        for (const q of reviewed.quotes)
          await audit(
            {
              action: 'QUOTE_REVIEWED',
              entityType: 'quote',
              entityId: q.id,
              submissionId,
              actorId: actor.id,
              details: { version: q.version, assessmentId: created },
            },
            tx,
          );
        return created;
      }).catch((err) => {
        if (isPgUniqueViolation(err))
          throw new AppError('CONFLICT', 409, 'Another assessment was recorded at the same time; please try again');
        throw err;
      });
      const saved = await repo.getAssessment(db, id);
      if (!saved) throw notFound('Assessment');
      return saved;
    },
  };
}
