import { describe, expect, it } from 'vitest';

import { type AutoRunInput, autoRunState } from '../src/services/autoRun.js';

const AUTO = { synthesis: 'AUTO', analysis: 'AUTO', autoQuote: 'AUTO' } as const;
const report = (
  status: 'RUNNING' | 'COMPLETED' | 'FAILED',
  o: { contextVersion?: number; automatic?: boolean } = {},
) => ({ id: 'r', status, contextVersion: o.contextVersion ?? 2, automatic: o.automatic ?? true });
const run = (o: Partial<AutoRunInput>) =>
  autoRunState({
    processing: false,
    contextVersion: 2,
    settings: AUTO,
    ai: true,
    synthesis: null,
    analysis: null,
    jobs: { synthesis: undefined, analysis: undefined, quote: undefined },
    quoted: false,
    ...o,
  });

describe('autoRunState', () => {
  it('waits for every automatic step while processing, ignoring an earlier run’s reports', () => {
    expect(run({ processing: true, synthesis: report('COMPLETED') })).toEqual({
      synthesis: 'waiting',
      analysis: 'waiting',
      quote: 'waiting',
    });
    expect(run({ processing: true, settings: { ...AUTO, analysis: 'MANUAL' } })).toEqual({
      synthesis: 'waiting',
      analysis: 'off',
      quote: 'off',
    });
    expect(run({ processing: true, ai: false })).toEqual({ synthesis: 'off', analysis: 'off', quote: 'off' });
  });

  it('still waits after processing is marked done until its job has started the Synthesis', () => {
    const jobs = { synthesis: undefined, analysis: undefined, quote: undefined, process: 'running' } as const;
    expect(run({ jobs })).toEqual({ synthesis: 'waiting', analysis: 'waiting', quote: 'waiting' });
    expect(run({ jobs, synthesis: report('RUNNING') }).synthesis).toBe('running');
    // An earlier run's Synthesis is not this run's.
    expect(run({ jobs, synthesis: report('COMPLETED', { contextVersion: 1 }) }).synthesis).toBe('waiting');
    expect(run({ jobs: { ...jobs, process: 'done' } }).synthesis).toBe('off');
  });

  it('follows the chain: synthesis, then analysis, then the quote', () => {
    expect(run({ synthesis: report('RUNNING') })).toEqual({
      synthesis: 'running',
      analysis: 'waiting',
      quote: 'waiting',
    });
    // Synthesis written, its job is starting the analysis.
    expect(
      run({ synthesis: report('COMPLETED'), jobs: { synthesis: 'running', analysis: undefined, quote: undefined } })
        .analysis,
    ).toBe('waiting');
    expect(run({ synthesis: report('COMPLETED'), analysis: report('RUNNING') })).toEqual({
      synthesis: 'done',
      analysis: 'running',
      quote: 'waiting',
    });
    expect(
      run({
        synthesis: report('COMPLETED'),
        analysis: report('COMPLETED'),
        jobs: { synthesis: 'done', analysis: 'done', quote: 'running' },
      }).quote,
    ).toBe('running');
    expect(
      run({
        synthesis: report('COMPLETED'),
        analysis: report('COMPLETED'),
        jobs: { synthesis: 'done', analysis: 'done', quote: 'done' },
        quoted: true,
      }),
    ).toEqual({ synthesis: 'done', analysis: 'done', quote: 'done' });
  });

  it('shows failures, and a skipped quote as off', () => {
    expect(run({ synthesis: report('FAILED') })).toEqual({ synthesis: 'failed', analysis: 'off', quote: 'off' });
    expect(
      run({
        synthesis: report('COMPLETED'),
        analysis: report('COMPLETED'),
        jobs: { synthesis: 'done', analysis: 'done', quote: 'failed' },
      }).quote,
    ).toBe('failed');
    // No rate tables: the quote job finishes without a quote.
    expect(
      run({
        synthesis: report('COMPLETED'),
        analysis: report('COMPLETED'),
        jobs: { synthesis: 'done', analysis: 'done', quote: 'done' },
      }).quote,
    ).toBe('off');
  });

  it('ignores reports someone started by hand and reports of an older context version', () => {
    expect(run({ synthesis: report('RUNNING', { automatic: false }) })).toEqual({
      synthesis: 'off',
      analysis: 'off',
      quote: 'off',
    });
    expect(run({ synthesis: report('COMPLETED', { contextVersion: 1 }) }).synthesis).toBe('off');
  });
});
