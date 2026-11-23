import { describe, expect, it } from 'vitest';

import { stripArithmeticPrefix } from '../src/services/chatAnswer.js';

const SCOPE =
  "I can only help with this submission's file (SUB-2026-00125). I can cover the quote, the missing items, or the NPI results.";

describe('stripArithmeticPrefix', () => {
  it.each([
    ['2. ', '1 + 1'],
    ['7. ', '5 + 2'],
    ['2 ', 'no punctuation'],
    ['2\n\n', 'result on its own line'],
    ['1 + 1 = 2. ', 'echoed expression'],
    ['-3: ', 'negative result'],
    ['1,000) ', 'thousands separator'],
    ['2.5 — ', 'decimal and dash'],
    ['**1 + 3 = 4.**\n\n', 'bold echoed expression'],
    ['**4.** ', 'bold result'],
    ['**4**. ', 'punctuation outside bold'],
    ['_4._ ', 'italic result'],
  ])('removes %j before the scope reply (%s)', (prefix) => {
    expect(stripArithmeticPrefix(`${prefix}${SCOPE}`)).toBe(SCOPE);
  });

  it('leaves the scope reply unchanged when there is no prefix', () => {
    expect(stripArithmeticPrefix(SCOPE)).toBe(SCOPE);
  });

  it.each([
    '1. Missing items: loss runs (email body)\n2. NPI mismatch (NPI Registry)',
    '2 claims in the last 5 years (loss_runs.pdf).',
    'The premium is $12,400 (Quote v2).',
    `Two open items. ${SCOPE}`,
  ])('leaves other answers untouched: %j', (answer) => {
    expect(stripArithmeticPrefix(answer)).toBe(answer);
  });
});
