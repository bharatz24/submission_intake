/** TanStack Query keys of the audit trail; `all()` is the prefix of every audit list. */
export const auditKeys = {
  /** Every audit list (global and per submission). */
  all: () => ['audit'] as const,
  global: (params: Record<string, unknown>) => ['audit', 'global', params] as const,
  submission: (submissionId: string, params: Record<string, unknown>) =>
    ['audit', 'submission', submissionId, params] as const,
};
