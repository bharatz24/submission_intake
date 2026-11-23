/** The permission table (src/permissions.ts) and its frontend mirror must not drift apart. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hasPermission, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../src/permissions.js';

const frontend = readFileSync(new URL('../../frontend/src/auth/permissions.ts', import.meta.url), 'utf8');
const listed = (block: string) => [...block.matchAll(/'([a-z]+:[a-z-]+)'/g)].map((m) => m[1]);

describe('permissions', () => {
  it('lists the same permissions as the frontend', () => {
    const block = /export const PERMISSIONS = \[([\s\S]*?)\] as const;/.exec(frontend)![1]!;
    expect(listed(block)).toEqual([...PERMISSIONS]);
  });

  it('grants each role the same permissions as the frontend', () => {
    for (const role of ROLES) {
      const line = new RegExp(`${role}: ([^\n]+),`).exec(frontend)![1]!;
      const granted = line.trim() === 'PERMISSIONS' ? [...PERMISSIONS] : listed(line);
      expect(granted, role).toEqual([...ROLE_PERMISSIONS[role]]);
    }
  });

  it('gives viewers no write access and admins everything', () => {
    expect(PERMISSIONS.every((p) => hasPermission('ADMIN', p))).toBe(true);
    expect(PERMISSIONS.some((p) => hasPermission('VIEWER', p))).toBe(false);
    expect(hasPermission(undefined, 'submission:write')).toBe(false);
  });
});
