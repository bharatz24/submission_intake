import { describe, expect, it } from 'vitest';

import type { AutoRun, DocumentInfo, PipelineStep } from '../types';
import { processingProgress, progressActive } from './processingProgress';

const doc = (extractionStatus: DocumentInfo['extractionStatus']) => ({ extractionStatus }) as DocumentInfo;
const ALL_WAITING: AutoRun = { synthesis: 'waiting', analysis: 'waiting', quote: 'waiting' };
type Status = 'NEW' | 'PROCESSING' | 'READY_FOR_REVIEW';
const p = (
  completedSteps: PipelineStep[],
  o: { documents?: DocumentInfo[]; status?: Status; autoRun?: AutoRun } = {},
) =>
  processingProgress({
    status: o.status ?? 'PROCESSING',
    documents: o.documents ?? [],
    pipeline: { completedSteps },
    autoRun: o.autoRun ?? ALL_WAITING,
  });
const states = (r: ReturnType<typeof p>) => r.steps.map((x) => x.state);
const ALL: PipelineStep[] = ['classification', 'documents', 'fields', 'npi'];

describe('processingProgress', () => {
  it('starts on classifying, with every later step waiting', () => {
    const r = p([], { status: 'NEW' });
    expect(r).toMatchObject({ percent: 0, label: 'Classifying this email', reviewable: false });
    expect(states(r)).toEqual(['active', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
  });

  it('moves with each document read', () => {
    const half = p(['classification'], { documents: [doc('EXTRACTED'), doc('PENDING')] });
    expect(half.label).toBe('Reading documents (1 of 2)');
    expect(half.steps[1]).toMatchObject({ state: 'active', fraction: 0.5, detail: '1 of 2' });
    // 4 (classify) + 10 (half of reading) of 100.
    expect(half.percent).toBe(14);
  });

  it('carries on into the automatic reports and quote once processing is over', () => {
    const synth = p(ALL, {
      status: 'READY_FOR_REVIEW',
      autoRun: { synthesis: 'running', analysis: 'waiting', quote: 'waiting' },
    });
    expect(synth).toMatchObject({ percent: 40, label: 'Writing the Synthesis report', reviewable: true });
    expect(states(synth)).toEqual(['done', 'done', 'done', 'done', 'active', 'pending', 'pending']);
    const quote = p(ALL, {
      status: 'READY_FOR_REVIEW',
      autoRun: { synthesis: 'done', analysis: 'done', quote: 'running' },
    });
    expect(quote).toMatchObject({ percent: 90, label: 'Pricing the automatic quote' });
    const done = p(ALL, {
      status: 'READY_FOR_REVIEW',
      autoRun: { synthesis: 'done', analysis: 'done', quote: 'done' },
    });
    expect(done).toMatchObject({ percent: 100, label: 'Done' });
  });

  it('leaves out steps that do not run by themselves, so the bar still reaches the end', () => {
    // Field extraction, analysis and quote Manual: classify 4 + read 20 + NPI 6 of 55 (with synthesis 25).
    const r = p(['classification', 'documents', 'npi'], {
      status: 'READY_FOR_REVIEW',
      autoRun: { synthesis: 'running', analysis: 'off', quote: 'off' },
    });
    expect(states(r)).toEqual(['done', 'done', 'skipped', 'done', 'active', 'skipped', 'skipped']);
    expect(r.percent).toBe(55);
  });

  it('says it is finishing up between the last processing step and the reports', () => {
    expect(p(ALL, { autoRun: { synthesis: 'off', analysis: 'off', quote: 'off' } })).toMatchObject({
      label: 'Finishing up',
      percent: 99,
    });
    expect(p(ALL).label).toBe('Writing the Synthesis report');
  });

  it('starts again from the beginning on a re-run', () => {
    expect(p([], { documents: [doc('EXTRACTED')] }).label).toBe('Classifying this email');
  });

  it('shows a failed report', () => {
    const r = p(ALL, { status: 'READY_FOR_REVIEW', autoRun: { synthesis: 'failed', analysis: 'off', quote: 'off' } });
    expect(r.steps[4]!.state).toBe('failed');
    expect(r.label).toBe('Synthesis failed');
  });
});

describe('progressActive', () => {
  it('is on while processing or while an automatic step is still to come', () => {
    const base = { documents: [], pipeline: { completedSteps: ALL } };
    expect(progressActive({ ...base, status: 'PROCESSING' })).toBe(true);
    expect(
      progressActive({
        ...base,
        status: 'READY_FOR_REVIEW',
        autoRun: { synthesis: 'done', analysis: 'running', quote: 'waiting' },
      }),
    ).toBe(true);
    expect(
      progressActive({
        ...base,
        status: 'READY_FOR_REVIEW',
        autoRun: { synthesis: 'done', analysis: 'done', quote: 'off' },
      }),
    ).toBe(false);
    expect(progressActive({ ...base, status: 'READY_FOR_REVIEW' })).toBe(false);
  });

  it('is on from the click of a re-run, before a worker takes the job, and for a submission in review', () => {
    const off = { synthesis: 'off', analysis: 'off', quote: 'off' } as const;
    // Re-run cleared the progress and queued the job; the status has not moved yet.
    for (const status of ['READY_FOR_REVIEW', 'IN_REVIEW', 'COMPLETED', 'ERROR'] as const) {
      const queued = { status, documents: [doc('PENDING')], pipeline: { completedSteps: [] }, processingQueued: true };
      expect(progressActive(queued)).toBe(true);
      const r = processingProgress({ ...queued, autoRun: off });
      expect(r).toMatchObject({ label: 'Classifying this email', reviewable: false });
      expect(r.percent).toBeLessThan(100);
    }
    // Every step done while the job winds down: processing is over, the page is not held as processing.
    expect(
      progressActive({
        status: 'IN_REVIEW',
        documents: [],
        pipeline: { completedSteps: ALL },
        processingQueued: true,
        autoRun: off,
      }),
    ).toBe(false);
  });
});
