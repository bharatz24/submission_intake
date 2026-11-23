import { describe, expect, it } from 'vitest';

import { nextSort, sortRows } from './sort';

describe('table sorting', () => {
  it('flips the active column and starts a new one at its first order', () => {
    expect(nextSort({ key: 'at', order: 'desc' }, 'at')).toEqual({ key: 'at', order: 'asc' });
    expect(nextSort({ key: 'at', order: 'desc' }, 'task')).toEqual({ key: 'task', order: 'asc' });
    expect(nextSort({ key: 'at', order: 'asc' }, 'input', 'desc')).toEqual({ key: 'input', order: 'desc' });
  });

  it('sorts numbers, text and nulls', () => {
    const rows = [
      { n: 10, s: 'beta' },
      { n: 2, s: null },
      { n: 33, s: 'Alpha' },
    ];
    expect(sortRows(rows, (r) => r.n, 'asc').map((r) => r.n)).toEqual([2, 10, 33]);
    expect(sortRows(rows, (r) => r.n, 'desc').map((r) => r.n)).toEqual([33, 10, 2]);
    expect(sortRows(rows, (r) => r.s, 'asc').map((r) => r.s)).toEqual(['Alpha', 'beta', null]);
    expect(sortRows(rows, (r) => r.s, 'desc').map((r) => r.s)).toEqual(['beta', 'Alpha', null]);
  });
});
