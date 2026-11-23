/**
 * What each role may do. Code checks a permission (`requirePermission('submission:write')`, `hasPermission(role, …)`),
 * never a role name, so a new role or a changed grant is one edit here. The frontend mirrors this table in
 * frontend/src/auth/permissions.ts (tests/permissions.test.ts keeps the two in step); the server is what enforces it.
 */
export const ROLES = ['ADMIN', 'UNDERWRITER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  /** Change submissions: fields, NPI, classification, re-runs, uploads, reports, chat, assessments, quotes, emails. */
  'submission:write',
  /** Delete submissions (soft delete) one at a time or in bulk. */
  'submission:delete',
  /** Upload with Gmail message/thread ids, which the importer then trusts. */
  'submission:import-gmail-ids',
  /** See the raw processing error text (provider messages) next to the plain-words message. */
  'submission:view-error-detail',
  /** Create users, change roles, disable accounts, reset passwords; see every account's state. */
  'user:manage',
  /** Settings: Claude API key, automation, limits, connection tests. */
  'settings:manage',
  /** Connect, poll, import from and disconnect Gmail; retry the ingest queue. */
  'gmail:manage',
  /** Monitoring: queue and LLM usage stats and system errors. */
  'monitoring:view',
  /** Clear the system errors shown in Monitoring. */
  'monitoring:manage',
  /** The global audit trail (outbound recipients, senders, subjects). */
  'audit:view',
  /** Edit or reset the runtime skills (prompts). */
  'skill:edit',
  /** Import rate workbooks and ZIP data. */
  'rate:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: ALL,
  UNDERWRITER: ['submission:write'],
  VIEWER: [],
};

export function hasPermission(role: Role | null | undefined, permission: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].includes(permission);
}
