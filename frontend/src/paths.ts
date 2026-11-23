// Every in-app URL, in one place: routes are declared from these and links/navigation build URLs with them, so a
// renamed path can't leave a stale link behind.

export type WorkspaceTab = string;

export const paths = {
  login: '/login',
  inbox: '/',
  submission: (id: string, tab?: WorkspaceTab) =>
    `/submissions/${encodeURIComponent(id)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`,
  monitoring: '/monitoring',
  audit: '/audit',
  settings: '/settings',
  users: '/settings/users',
  documents: '/documents',
} as const;

/** Route patterns (relative to the app layout) for the router; kept beside the builders above. */
export const routePatterns = {
  submission: 'submissions/:id',
  monitoring: 'monitoring',
  audit: 'audit',
  settings: 'settings',
  users: 'settings/users',
  documents: 'documents',
} as const;
