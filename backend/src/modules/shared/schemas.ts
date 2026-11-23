import { z } from 'zod';

/** Zod pieces more than one module's requests use. */

export const SUBMISSION_STATUSES = [
  'NEW',
  'PROCESSING',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'COMPLETED',
  'NOT_SUBMISSION',
  'DUPLICATE',
  'ERROR',
] as const;
export const CLASSIFICATIONS = ['SUBMISSION', 'NOT_SUBMISSION', 'REVIEW_REQUIRED'] as const;
export const DUPLICATE_STRENGTHS = ['CERTAIN', 'HIGH', 'POSSIBLE'] as const;
export const REPORT_KINDS = ['SYNTHESIS', 'ANALYSIS'] as const;

/** `?page=&pageSize=` with a default and a cap. */
export const pageQuery = (defaultSize: number, maxSize: number) =>
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(maxSize).default(defaultSize),
  });

/** A Gmail message id as Gmail writes them. */
export const GmailMessageId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
