/**
 * TanStack Query keys of Settings, Monitoring and the platform status. Every query and invalidation builds its key
 * here, never inline. Shorter keys are prefixes: invalidating `gmailKeys.all()` refreshes status and import settings.
 */
export const settingsKeys = {
  anthropic: () => ['settings', 'anthropic'] as const,
  ims2Queue: () => ['settings', 'ims2-queue'] as const,
  automation: () => ['settings', 'automation'] as const,
  limits: () => ['settings', 'limits'] as const,
  retention: () => ['settings', 'retention'] as const,
  connections: () => ['settings', 'connections'] as const,
};

export const gmailKeys = {
  all: () => ['gmail'] as const,
  status: () => ['gmail', 'status'] as const,
  importSettings: () => ['gmail', 'import-settings'] as const,
};

export const monitoringKeys = {
  all: () => ['monitoring'] as const,
  stats: (range: string) => ['monitoring', 'stats', range] as const,
  transcript: (callId: string) => ['monitoring', 'transcript', callId] as const,
  llmUsage: (range: string, page: number, pageSize: number, sort: string, order: string) =>
    ['monitoring', 'llm-usage', range, page, pageSize, sort, order] as const,
};

export const systemKeys = {
  status: () => ['system', 'status'] as const,
};

export const skillKeys = {
  all: () => ['skills'] as const,
  file: (name: string, path: string) => ['skill-file', name, path] as const,
  revisions: (name: string, path: string) => ['skill-revisions', name, path] as const,
};

export const userKeys = {
  /** Everyone who work can be assigned to (all roles see it). */
  all: () => ['users'] as const,
  /** Accounts with their state, for the Users screen (admins). */
  managed: () => ['users', 'managed'] as const,
};
