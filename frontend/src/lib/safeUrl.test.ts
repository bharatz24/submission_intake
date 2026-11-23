import { describe, expect, it } from 'vitest';

import { safeWebUrl } from './safeUrl';

describe('safeWebUrl', () => {
  it('keeps absolute http and https URLs', () => {
    expect(safeWebUrl('https://ims2.example.test/submissions/42')).toBe('https://ims2.example.test/submissions/42');
    expect(safeWebUrl(' http://ims2.internal/s/1 ')).toBe('http://ims2.internal/s/1');
  });

  it('refuses script, data and relative URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.test/x',
      '/submissions/1',
      'https//missing-colon',
      '',
      null,
      undefined,
    ]) {
      expect(safeWebUrl(bad)).toBeNull();
    }
  });
});
