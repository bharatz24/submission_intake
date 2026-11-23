import { describe, expect, it } from 'vitest';

import { hasPermission } from './permissions';

describe('hasPermission', () => {
  it('grants admins everything, underwriters submission work only, viewers nothing', () => {
    expect(hasPermission({ role: 'ADMIN' }, 'settings:manage')).toBe(true);
    expect(hasPermission({ role: 'UNDERWRITER' }, 'submission:write')).toBe(true);
    expect(hasPermission({ role: 'UNDERWRITER' }, 'submission:delete')).toBe(false);
    expect(hasPermission({ role: 'VIEWER' }, 'submission:write')).toBe(false);
    expect(hasPermission(null, 'submission:write')).toBe(false);
  });
});
