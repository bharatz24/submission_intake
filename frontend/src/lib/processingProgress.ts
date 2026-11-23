// How far a submission has got, for the submission page's progress tracker: the processing run (classify → read
// documents → extract fields → verify NPIs), then the automatic Synthesis → Analysis → quote. The server keeps no
// percentage, but it records each finished processing step (`pipeline.completedSteps`, cleared when a run starts) and
// reports the automatic work (`autoRun`); the page polls the detail while any of it is going.
import type { AutoRun, AutoRunState, PipelineStep, SubmissionDetail } from '../types';

export type TrackedStep = 'classification' | 'documents' | 'fields' | 'npi' | 'synthesis' | 'analysis' | 'quote';
export type StepState = 'done' | 'active' | 'pending' | 'skipped' | 'failed';

export interface StepProgress {
  step: TrackedStep;
  /** Short name for the step tracker. */
  name: string;
  state: StepState;
  /** How much of this step is finished, 0-1 (only the documents step reports part way). */
  fraction: number;
  /** "1 of 3" while documents are being read. */
  detail?: string;
}

export interface ProcessingProgress {
  /** Whole percent, 0-100; below 100 while anything is still going. */
  percent: number;
  /** What is happening now. */
  label: string;
  /** Every step in order, with how far each has got. */
  steps: StepProgress[];
  /** Processing is over and only the automatic reports or quote are still going: the page is usable. */
  reviewable: boolean;
}

type Input = Pick<SubmissionDetail, 'status' | 'documents' | 'processingQueued'> & {
  pipeline?: Pick<SubmissionDetail['pipeline'], 'completedSteps'> | null;
  autoRun?: AutoRun | null;
};

/** Every step in order, with its share of the bar (the reports take longest) and what the tracker says while it runs. */
const STEPS: { step: TrackedStep; weight: number; name: string; label: string }[] = [
  { step: 'classification', weight: 4, name: 'Classify', label: 'Classifying this email' },
  { step: 'documents', weight: 20, name: 'Read documents', label: 'Reading documents' },
  { step: 'fields', weight: 10, name: 'Extract fields', label: 'Extracting fields' },
  { step: 'npi', weight: 6, name: 'Verify NPIs', label: 'Verifying NPIs' },
  { step: 'synthesis', weight: 25, name: 'Synthesis', label: 'Writing the Synthesis report' },
  { step: 'analysis', weight: 25, name: 'Analysis', label: 'Writing the Underwriting Analysis' },
  { step: 'quote', weight: 10, name: 'Quote', label: 'Pricing the automatic quote' },
];
const PIPELINE: PipelineStep[] = ['classification', 'documents', 'fields', 'npi'];

// Re-run and Process only queue the run: the status turns PROCESSING when a worker takes it, and a submission in
// review or completed keeps its status throughout. A queued or running job with steps still to do counts too.
const isProcessing = (s: Input) =>
  s.status === 'NEW' ||
  s.status === 'PROCESSING' ||
  (!!s.processingQueued && (s.pipeline?.completedSteps ?? []).length < PIPELINE.length);
const going = (a: AutoRunState | undefined) => a === 'waiting' || a === 'running';

/** True while the tracker has something to show: processing, or automatic reports or a quote still to come. */
export function progressActive(s: Input): boolean {
  if (isProcessing(s)) return true;
  const a = s.autoRun;
  return !!a && (going(a.synthesis) || going(a.analysis) || going(a.quote));
}

export function processingProgress(s: Input): ProcessingProgress {
  const processing = isProcessing(s);
  const completed = s.pipeline?.completedSteps ?? [];
  const auto: AutoRun = s.autoRun ?? { synthesis: 'off', analysis: 'off', quote: 'off' };

  // Processing steps: the one after the furthest finished is running; one passed over was Manual in Automation.
  // Once processing is over, a step it did not finish was passed over (an old run without a record: all done).
  const furthest = Math.max(-1, ...completed.map((c) => PIPELINE.indexOf(c)));
  const total = s.documents.length;
  const read = s.documents.filter((d) => d.extractionStatus !== 'PENDING').length;
  const pipelineState = (i: number): Omit<StepProgress, 'step' | 'name'> => {
    const step = PIPELINE[i]!;
    if (!processing)
      return completed.length === 0 || completed.includes(step)
        ? { state: 'done', fraction: 1 }
        : { state: 'skipped', fraction: 0 };
    if (i === furthest + 1) {
      return step === 'documents' && total > 0
        ? { state: 'active', fraction: read / total, detail: `${read} of ${total}` }
        : { state: 'active', fraction: 0 };
    }
    if (i > furthest) return { state: 'pending', fraction: 0 };
    return completed.includes(step) ? { state: 'done', fraction: 1 } : { state: 'skipped', fraction: 0 };
  };
  // Automatic steps: the first still to come runs (or is about to); later ones wait.
  // While a processing step is still running, the automatic ones only wait.
  let started = processing && furthest + 1 < PIPELINE.length;
  const autoState = (a: AutoRunState): Omit<StepProgress, 'step' | 'name'> => {
    if (a === 'done') return { state: 'done', fraction: 1 };
    if (a === 'failed') return { state: 'failed', fraction: 0 };
    if (a === 'off') return { state: 'skipped', fraction: 0 };
    if (started) return { state: 'pending', fraction: 0 };
    started = true;
    return { state: 'active', fraction: 0 };
  };

  const steps = STEPS.map(
    (x, i): StepProgress => ({
      step: x.step,
      name: x.name,
      ...(i < PIPELINE.length ? pipelineState(i) : autoState(auto[x.step as keyof AutoRun])),
    }),
  );

  // The bar fills by each step's share, leaving out steps that will not run.
  const counted = steps.filter((x) => x.state !== 'skipped');
  const weightOf = (x: StepProgress) => STEPS.find((d) => d.step === x.step)?.weight ?? 0;
  const sum = counted.reduce((n, x) => n + weightOf(x), 0) || 1;
  const filled = counted.reduce(
    (n, x) => n + weightOf(x) * (x.state === 'done' || x.state === 'failed' ? 1 : x.fraction),
    0,
  );
  const active = steps.find((x) => x.state === 'active');
  const percent = active ? Math.min(99, Math.round((filled / sum) * 100)) : 100;

  // Processing has passed its last step: status and the automatic reports' start are left.
  if (!active && processing) return { percent: Math.min(percent, 99), label: 'Finishing up', steps, reviewable: false };
  if (!active) {
    const failed = steps.find((x) => x.state === 'failed');
    return { percent, label: failed ? `${failed.name} failed` : 'Done', steps, reviewable: !processing };
  }
  const label =
    (STEPS.find((d) => d.step === active.step)?.label ?? active.name) + (active.detail ? ` (${active.detail})` : '');
  return { percent, label, steps, reviewable: !processing };
}
