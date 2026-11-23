import { z } from 'zod';

import { REPORT_KINDS } from '../shared/schemas.js';

const Kind = z.enum(REPORT_KINDS);

/** `force`: a new report even when a completed one exists for the same evidence and skill version. */
export const SynthesisBody = z.object({ force: z.boolean().optional() });
export const AnalysisBody = z.object({ synthesisReportId: z.uuid().optional(), force: z.boolean().optional() });
export const KindQuery = z.object({ kind: Kind.optional() });
export const ReportInputQuery = z.object({ kind: Kind, basedOnReportId: z.uuid().optional() });
export const ExternalReportBody = z.object({ kind: Kind, content: z.unknown(), basedOnReportId: z.uuid().optional() });
export const ComparisonBody = z.object({ kind: Kind, baseReportId: z.uuid(), targetReportId: z.uuid() });
