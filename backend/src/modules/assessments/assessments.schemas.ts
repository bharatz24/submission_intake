import { z } from 'zod';

export const DECISIONS = ['ACCEPT', 'ACCEPT_WITH_CONDITIONS', 'DECLINE', 'REFER', 'REQUEST_INFORMATION'] as const;
export type Decision = (typeof DECISIONS)[number];
export const RISK_RATINGS = ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'] as const;
export type RiskRating = (typeof RISK_RATINGS)[number];

/** Decisions that close the submission (COMPLETED); the others leave it IN_REVIEW. */
export const TERMINAL_DECISIONS: readonly Decision[] = ['ACCEPT', 'ACCEPT_WITH_CONDITIONS', 'DECLINE'];
/** Decisions that accept the submission: they need a primary quote priced above zero (premium and total). */
export const ACCEPT_DECISIONS: readonly Decision[] = ['ACCEPT', 'ACCEPT_WITH_CONDITIONS'];
/** Statuses in which no assessment can be recorded: not processed yet, or not a submission at all. */
export const NOT_ASSESSABLE = ['NEW', 'PROCESSING', 'DUPLICATE', 'NOT_SUBMISSION'] as const;

export const RecordAssessmentBody = z.object({
  decision: z.enum(DECISIONS),
  riskRating: z.enum(RISK_RATINGS),
  notes: z.string().max(20_000).default(''),
  analysisReportId: z.uuid().nullable().optional(),
});
export type RecordAssessmentInput = z.infer<typeof RecordAssessmentBody>;
