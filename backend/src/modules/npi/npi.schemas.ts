import { z } from 'zod';

/** Re-verify one NPI (npi given) or every NPI on the submission, optionally with a corrected name or state. */
export const VerifyBody = z.object({
  npi: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
  claimedName: z.string().max(200).optional(),
  claimedState: z.string().max(2).optional(),
});
export type VerifyBody = z.infer<typeof VerifyBody>;

export const ManualNpiBody = z.object({
  npi: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'NPI must be 10 digits'),
  claimedName: z.string().trim().min(1).max(200).optional(),
  claimedState: z.string().trim().length(2).toUpperCase().optional(),
  claimedSpecialty: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type ManualNpiBody = z.infer<typeof ManualNpiBody>;

export const OverrideBody = z.object({
  status: z.enum(['MATCH', 'MISMATCH']),
  note: z.string().trim().min(1, 'Give a reason for the decision').max(1000),
});
export type OverrideBody = z.infer<typeof OverrideBody>;
