import { describe, expect, it } from 'vitest';
import { backTarget, parentPath } from './navigation';

describe('back navigation', () => {
  it('uses the Inbox as the parent of every page', () => {
    expect(parentPath('/submissions/abc')).toBe('/');
    expect(parentPath('/audit')).toBe('/');
    expect(parentPath('/settings')).toBe('/');
  });

  it('goes back in history only when an earlier app page exists', () => {
    expect(backTarget({ idx: 3, key: 'k' }, '/submissions/abc')).toEqual({ kind: 'history' });
    // idx 0: opened directly, in a new tab or right after sign-in
    expect(backTarget({ idx: 0 }, '/submissions/abc')).toEqual({ kind: 'replace', to: '/' });
    expect(backTarget(null, '/audit')).toEqual({ kind: 'replace', to: '/' });
    expect(backTarget({ usr: {} }, '/audit')).toEqual({ kind: 'replace', to: '/' });
  });
});
