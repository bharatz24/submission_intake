// Display labels for the processing pipeline's steps (error banner, Errors tab, auto-retry note).
import { FAILURE_MESSAGES } from '../constants';
import type { PipelineStep } from '../types';
import { friendlyError } from './friendlyError';

export const PIPELINE_STEP_LABELS: Record<PipelineStep, string> = {
  classification: 'Classification',
  documents: 'Reading documents',
  fields: 'Field extraction',
  npi: 'NPI verification',
};

export const pipelineStepLabel = (step: PipelineStep): string => PIPELINE_STEP_LABELS[step] ?? step;

/**
 * A processing failure in words a reviewer understands, plus the raw text (null when it was already plain) for
 * admins. Messages the server already wrote for people pass through unchanged.
 */
export const friendlyProcessingError = (
  raw: string | null | undefined,
): { message: string; technical: string | null } =>
  friendlyError(raw, { empty: FAILURE_MESSAGES.processingFailed, unknown: FAILURE_MESSAGES.processingUnknown });
