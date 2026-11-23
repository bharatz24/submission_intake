import { z } from 'zod';

/** A field name as typed ("Practice State") becomes the stored key (practice_state). */
const fieldName = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/[\s-]+/g, '_'))
  .pipe(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Use letters, digits and underscores, starting with a letter'));
const fieldValue = z.string().trim().min(1).max(4000);
const fieldNote = z.string().trim().max(1000).nullable().optional();
const fieldDocument = z.uuid().nullable().optional();

export const AddFieldsBody = z.object({
  fields: z
    .array(z.object({ fieldName, value: fieldValue, note: fieldNote, documentId: fieldDocument }))
    .min(1)
    .max(50),
});
export type AddFieldsBody = z.infer<typeof AddFieldsBody>;

export const UpdateFieldBody = z
  .object({ value: fieldValue.optional(), note: fieldNote, documentId: fieldDocument })
  .refine((b) => b.value !== undefined || b.note !== undefined || b.documentId !== undefined, 'Nothing to update');
export type UpdateFieldBody = z.infer<typeof UpdateFieldBody>;
