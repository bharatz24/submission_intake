import { describe, expect, it } from 'vitest';

import { LIMIT_FIELDS, LIMIT_GROUPS, uploadCaption, uploadProblem } from './limits';

const file = (name: string, mb: number) => {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: mb * 1024 * 1024 });
  return f;
};

describe('upload pre-check', () => {
  it('blocks nothing while the limits are unknown', () => {
    expect(uploadProblem([file('a.pdf', 500)], null)).toBeNull();
  });

  it('names every file over the size limit', () => {
    expect(
      uploadProblem([file('a.pdf', 1), file('b.pdf', 30), file('c.pdf', 26)], { maxFileMb: 25, maxFiles: 20 }),
    ).toBe('These files are over the 25 MB limit: b.pdf (30.0 MB), c.pdf (26.0 MB).');
    expect(uploadProblem([file('a.pdf', 25)], { maxFileMb: 25, maxFiles: 20 })).toBeNull();
  });

  it('limits the number of files per upload', () => {
    const files = Array.from({ length: 3 }, (_, i) => file(`${i}.pdf`, 1));
    expect(uploadProblem(files, { maxFileMb: 25, maxFiles: 2 })).toBe('3 files chosen; one upload can carry up to 2.');
  });

  it('describes the limit', () => {
    expect(uploadCaption({ maxFileMb: 25, maxFiles: 20 })).toBe('Up to 20 files, 25 MB each');
    expect(uploadCaption({ maxFileMb: 20 })).toBe('Up to 20 MB');
  });
});

describe('limit definitions', () => {
  it('describes all 20 keys, each in one group, with the three report limits first in Output limits', () => {
    expect(Object.keys(LIMIT_FIELDS)).toHaveLength(20);
    const grouped = Object.values(LIMIT_GROUPS).flatMap((g) => g.keys);
    expect([...grouped].sort()).toEqual(Object.keys(LIMIT_FIELDS).sort());
    expect(LIMIT_GROUPS.claudeOutput.keys.slice(0, 3)).toEqual([
      'synthesisMaxTokens',
      'analysisMaxTokens',
      'comparisonMaxTokens',
    ]);
    expect(LIMIT_GROUPS.claudeOutput.keys.slice(0, 3).map((k) => LIMIT_FIELDS[k])).toEqual([
      { label: 'Synthesis report', unit: 'tokens' },
      { label: 'Analysis report', unit: 'tokens' },
      { label: 'Report comparison', unit: 'tokens' },
    ]);
  });
});
