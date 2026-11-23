import { z } from 'zod';

import { FIELD_NAMES } from '../../services/fieldExtraction.js';
import { CLASSIFICATIONS } from '../shared/schemas.js';

/** Classification and field extraction done outside the portal (the Claude CLI), posted back for the rest of the pipeline. */
export const ExternalResultsBody = z.object({
  classification: z.enum(CLASSIFICATIONS),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().max(1000)).max(20),
  fields: z
    .array(
      z.object({
        fieldName: z.enum(FIELD_NAMES),
        value: z.string().min(1).max(4000),
        confidence: z.number().min(0).max(1),
        evidenceQuote: z.string().max(1000).nullable(),
        sourceLabel: z.string().min(1).max(500),
      }),
    )
    .max(500),
});
export type ExternalResultsBody = z.infer<typeof ExternalResultsBody>;
