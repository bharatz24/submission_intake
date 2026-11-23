import { z } from 'zod';

import { OUTBOUND_MODES } from '../../services/outbound.js';
import { EMAIL_AUDIENCES } from '../../services/reportSchemas.js';

export const ChatBody = z.object({ message: z.string().min(1).max(4000) });

export const AudienceParam = z.object({ audience: z.enum(EMAIL_AUDIENCES) });

export const DraftEditBody = z.object({ subject: z.string().max(998), body: z.string().max(50000) });

const addressList = z.array(z.string().trim().min(1).max(320)).max(50).default([]);

/** One per compose dialog, from the Idempotency-Key header or the body. */
export const IdempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits, ".", "_", ":" or "-"');

export const OutboundBody = z.object({
  mode: z.enum(OUTBOUND_MODES),
  to: addressList,
  cc: addressList,
  bcc: addressList,
  subject: z.string().trim().min(1, 'Subject is required').max(998),
  body: z.string().max(200_000).default(''),
  documentIds: z.array(z.uuid()).max(50).default([]),
  idempotencyKey: IdempotencyKey.optional(),
});
export type OutboundBody = z.infer<typeof OutboundBody>;
