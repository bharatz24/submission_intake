import { z } from 'zod';

import { CLASSIFICATIONS } from '../shared/schemas.js';

/** Every status but DUPLICATE, which only the duplicate endpoints set. */
const SETTABLE_STATUSES = [
  'NEW',
  'PROCESSING',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'COMPLETED',
  'NOT_SUBMISSION',
  'ERROR',
] as const;

export const UpdateBody = z.object({
  status: z.enum(SETTABLE_STATUSES).optional(),
  assignedToId: z.uuid().nullable().optional(),
});

export const UploadBody = z.object({
  subject: z.string().min(1).max(500),
  fromAddress: z.string().min(1).max(320),
  bodyText: z.string().max(200_000).default(''),
  // Optional Gmail identity (e.g. intake via the Claude CLI Gmail connector): makes the upload idempotent.
  gmailMessageId: z.string().min(1).max(200).optional(),
  // RFC 822 Message-ID: lets duplicate detection recognise the same message arriving twice.
  rfcMessageId: z.string().min(1).max(998).optional(),
  threadId: z.string().max(200).optional(),
  toAddress: z.string().max(1000).default(''),
  receivedAt: z.coerce.date().optional(),
});
export type UploadBody = z.infer<typeof UploadBody>;

export const ClassificationBody = z.object({
  classification: z.enum(CLASSIFICATIONS),
  reason: z.string().min(1).max(1000),
});
export type ClassificationBody = z.infer<typeof ClassificationBody>;

/** duplicateOfId null: "not a duplicate". */
export const DuplicateBody = z.object({
  duplicateOfId: z.uuid().nullable(),
  reason: z.string().trim().min(1).max(1000),
});
export type DuplicateBody = z.infer<typeof DuplicateBody>;
