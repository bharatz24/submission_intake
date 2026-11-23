/**
 * TanStack Query keys of the submissions feature. Every query and invalidation builds its key here, never inline, so a
 * key cannot drift between the query that reads it and the mutation that invalidates it. Shorter keys are prefixes:
 * invalidating `submissionKeys.lists()` refreshes every inbox page.
 */
import type { ReportKind } from '../../types';

export const submissionKeys = {
  /** Every inbox list (any tab, filter or page). */
  lists: () => ['submissions'] as const,
  list: (params: Record<string, unknown>) => ['submissions', params] as const,
  detail: (id: string) => ['submission', id] as const,
  unreadCount: () => ['unread-count'] as const,
  versions: (id: string) => ['versions', id] as const,
  skipped: () => ['skipped-emails'] as const,
  skippedPage: (q: string, page: number, pageSize: number) => ['skipped-emails', q, page, pageSize] as const,
  skippedCount: (q: string) => ['skipped-emails', 'count', q] as const,
  failedIngest: () => ['ingest-queue', 'failed'] as const,
};

export const reportKeys = {
  /** Every report list of a submission (both kinds). */
  all: (submissionId: string) => ['reports', submissionId] as const,
  list: (submissionId: string, kind?: ReportKind) => ['reports', submissionId, kind] as const,
  /** Every report detail (any submission). */
  details: () => ['report'] as const,
  /** null while no report is chosen (the query is disabled then). */
  detail: (reportId: string | null) => ['report', reportId] as const,
};

export const comparisonKeys = {
  all: (submissionId: string) => ['comparisons', submissionId] as const,
  list: (submissionId: string, kind?: ReportKind) => ['comparisons', submissionId, kind] as const,
  detail: (comparisonId: string | null) => ['comparison', comparisonId] as const,
};

export const assessmentKeys = {
  list: (submissionId: string) => ['assessments', submissionId] as const,
};

export const quoteKeys = {
  list: (submissionId: string) => ['quotes', submissionId] as const,
  editInputs: (submissionId: string, quoteId: string) => ['quote-edit-inputs', submissionId, quoteId] as const,
  /** Every submission's rating inputs. */
  allRatingInputs: () => ['rating-inputs'] as const,
  ratingInputs: (submissionId: string) => ['rating-inputs', submissionId] as const,
  specialityOptions: (submissionId: string, index: number, title: string | undefined, snapshot: unknown) =>
    ['speciality-options', submissionId, index, title, snapshot] as const,
};

export const rateKeys = {
  all: () => ['rates'] as const,
  groups: () => ['rates', 'groups'] as const,
  allOptions: () => ['rate-options'] as const,
  options: (state?: string) => ['rate-options', state] as const,
};

export const outboundKeys = {
  list: (submissionId: string) => ['outbound', submissionId] as const,
};

export const chatKeys = {
  thread: (submissionId: string) => ['chat', submissionId] as const,
};

export const emailDraftKeys = {
  latest: (submissionId: string, audience: string) => ['email-draft', submissionId, audience] as const,
};

export const ims2Keys = {
  all: () => ['ims2-queue'] as const,
  submission: (submissionId: string) => ['ims2-queue', submissionId] as const,
  status: (submissionId: string) => ['ims2-queue-status', submissionId] as const,
  lookup: (submissionId: string, searched: unknown) => ['ims2-queue-lookup', submissionId, searched] as const,
  sync: () => ['ims2-queue', 'sync'] as const,
};

export const npiKeys = {
  lookup: (npi: string) => ['npi-lookup', npi] as const,
};
