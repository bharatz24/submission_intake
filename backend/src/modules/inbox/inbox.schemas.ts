import { z } from 'zod';

import { VIEWS } from '../../services/queries.js';
import { CLASSIFICATIONS, DUPLICATE_STRENGTHS, pageQuery, SUBMISSION_STATUSES } from '../shared/schemas.js';

export const InboxView = z.enum(VIEWS);

/** The per-tab filters and the search box. */
const InboxFilterFields = {
  q: z.string().max(200).optional(),
  status: z.enum(SUBMISSION_STATUSES).optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
  strength: z.enum(DUPLICATE_STRENGTHS).optional(),
};

export const ListQuery = z.object({ view: InboxView.optional(), ...InboxFilterFields, ...pageQuery(25, 100).shape });
export type ListQuery = z.infer<typeof ListQuery>;

export const ReadAllBody = z.object(InboxFilterFields);
export type ReadAllBody = z.infer<typeof ReadAllBody>;

/** The selected `ids`, otherwise every row matching the filters. */
export const BulkDeleteBody = z.object({ ids: z.array(z.uuid()).min(1).max(500).optional(), ...InboxFilterFields });
export type BulkDeleteBody = z.infer<typeof BulkDeleteBody>;
