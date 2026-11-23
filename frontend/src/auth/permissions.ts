import type { User } from '../types';
import { useAuth } from './AuthContext';

/**
 * What each role may do: a mirror of backend/src/permissions.ts (backend tests/permissions.test.ts keeps the two in
 * step). Screens check a permission, never a role name; the server enforces the same table, so this only decides what
 * the UI offers.
 */
export const PERMISSIONS = [
  'submission:write',
  'submission:delete',
  'submission:import-gmail-ids',
  'submission:view-error-detail',
  'user:manage',
  'settings:manage',
  'gmail:manage',
  'monitoring:view',
  'monitoring:manage',
  'audit:view',
  'skill:edit',
  'rate:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type Role = User['role'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  UNDERWRITER: ['submission:write'],
  VIEWER: [],
};

export function hasPermission(user: Pick<User, 'role'> | null | undefined, permission: Permission): boolean {
  return !!user && ROLE_PERMISSIONS[user.role].includes(permission);
}

/** Whether the signed-in user may do `permission`. */
export function useHasPermission(permission: Permission): boolean {
  const { user } = useAuth();
  return hasPermission(user, permission);
}
