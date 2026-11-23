import type { Classification, InboxView, SubmissionStatus } from '../../../types';

// Statuses a person can set (DUPLICATE is only set through the duplicate actions).
export const STATUSES: SubmissionStatus[] = [
  'NEW',
  'PROCESSING',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'COMPLETED',
  'NOT_SUBMISSION',
  'ERROR',
];

export const CLASSIFICATIONS: Classification[] = ['SUBMISSION', 'NOT_SUBMISSION', 'REVIEW_REQUIRED'];

export const VIEWS: { key: InboxView; label: string }[] = [
  { key: 'submissions', label: 'Submissions' },
  { key: 'ignored', label: 'Ignored' },
  { key: 'duplicates', label: 'Duplicates' },
  { key: 'errors', label: 'Errors' },
];

// Filters on the Submissions tab only offer what that tab can hold.
export const SUBMISSION_STATUSES = STATUSES.filter((s) => s !== 'NOT_SUBMISSION' && s !== 'ERROR');

export const SUBMISSION_CLASSIFICATIONS = CLASSIFICATIONS.filter((c) => c !== 'NOT_SUBMISSION');

export const EMPTY: Record<InboxView, { title: string; description: string }> = {
  submissions: {
    title: 'No submissions yet',
    description: 'Connect Gmail in Settings or create a manual submission to get started.',
  },
  ignored: {
    title: 'No ignored emails',
    description: 'Emails classified as not related to a submission appear here. They are not processed.',
  },
  duplicates: {
    title: 'No duplicates',
    description: 'Emails that repeat a submission already in the inbox appear here. They are not processed.',
  },
  errors: {
    title: 'No failed submissions',
    description: 'Submissions whose processing failed appear here, with the error. Retry them once the cause is fixed.',
  },
};

export const NOUN: Record<InboxView, string> = {
  submissions: 'submission',
  ignored: 'ignored email',
  duplicates: 'duplicate',
  errors: 'failed submission',
};
