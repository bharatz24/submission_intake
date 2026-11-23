/** DB-14: the post-migration check compares constraint and index definitions, not only their names (no database). */
import { describe, expect, it } from 'vitest';

import { diffShapes, type SchemaShape } from '../src/db/migrate.js';

const shape = (defs: Record<string, string>): SchemaShape => ({
  columns: new Map([['t', new Map([['a', 'int4 notnull']])]]),
  objects: new Set(Object.keys(defs)),
  definitions: new Map(Object.entries(defs)),
});

describe('diffShapes', () => {
  const expected = shape({
    't.t_a_check (c)': 'CHECK ((a > 0))',
    't.t_idx': 'CREATE INDEX t_idx ON t USING btree (a)',
  });

  it('reports a constraint whose definition changed when asked to', () => {
    const actual = shape({
      't.t_a_check (c)': 'CHECK ((a > 1))',
      't.t_idx': 'CREATE INDEX t_idx ON t USING btree (a)',
    });
    expect(diffShapes(expected, actual, { definitions: true }).problems).toEqual([
      'constraint/index t.t_a_check (c) is "CHECK ((a > 1))", expected "CHECK ((a > 0))"',
    ]);
    // Legacy convergence keeps comparing by name only.
    expect(diffShapes(expected, actual).problems).toEqual([]);
  });

  it('accepts identical definitions and still reports missing objects', () => {
    expect(diffShapes(expected, expected, { definitions: true }).problems).toEqual([]);
    const missing = shape({ 't.t_a_check (c)': 'CHECK ((a > 0))' });
    expect(diffShapes(expected, missing, { definitions: true }).problems).toEqual([
      'constraint/index t.t_idx is missing',
    ]);
  });
});
