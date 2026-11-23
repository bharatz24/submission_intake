// Status changes a person may make by hand (PATCH /submissions/:id). The pipeline owns NEW, PROCESSING and ERROR,
// duplicate handling owns DUPLICATE, and a classification override owns NOT_SUBMISSION: none of them is set here.
// Same-status updates are no-ops and always allowed.

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
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const MANUAL_TRANSITIONS: Record<SubmissionStatus, readonly SubmissionStatus[]> = {
  NEW: [],
  PROCESSING: [],
  READY_FOR_REVIEW: ['IN_REVIEW', 'COMPLETED'],
  IN_REVIEW: ['READY_FOR_REVIEW', 'COMPLETED'],
  // Reopen a decided submission.
  COMPLETED: ['IN_REVIEW'],
  // Processing failed: review what is there or close it; "Reprocess" is the way back into the pipeline.
  ERROR: ['IN_REVIEW', 'COMPLETED'],
  NOT_SUBMISSION: [],
  DUPLICATE: [],
};

export function canTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return (MANUAL_TRANSITIONS[from as SubmissionStatus] ?? []).includes(to as SubmissionStatus);
}
