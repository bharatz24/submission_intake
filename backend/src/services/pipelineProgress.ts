import { pool, type Queryable } from '../db/pool.js';

/**
 * The steps of a processing run (services/pipeline.ts processLocked), in order, and how far the last run got
 * (submissions.pipeline_progress, migration 013). A resumed run skips the completed steps; a full re-run clears them.
 */
export const PIPELINE_STEPS = ['classification', 'documents', 'fields', 'npi'] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export interface PipelineProgress {
  completedSteps: PipelineStep[];
  /** The step the last run failed at; null when it succeeded or is still running. */
  failedStep: PipelineStep | null;
  /** A short-lived failure waiting for its automatic retry (the job is queued with a backoff). */
  autoRetrying: boolean;
}

/** The stored jsonb read defensively: '{}' (never run since migration 013) or unknown steps give an empty progress. */
export function readProgress(raw: unknown): PipelineProgress {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof PipelineProgress, unknown>>;
  const isStep = (s: unknown): s is PipelineStep => PIPELINE_STEPS.includes(s as PipelineStep);
  return {
    completedSteps: Array.isArray(p.completedSteps)
      ? PIPELINE_STEPS.filter((s) => (p.completedSteps as unknown[]).includes(s))
      : [],
    failedStep: isStep(p.failedStep) ? p.failedStep : null,
    autoRetrying: p.autoRetrying === true,
  };
}

/** The first step a resumed run would do: the failed one, else the first not completed. */
export const resumeStep = (p: PipelineProgress): PipelineStep | null =>
  p.failedStep ?? PIPELINE_STEPS.find((s) => !p.completedSteps.includes(s)) ?? null;

/** `pipeline` on the submission summary and detail; `error` is the plain message of the failed step. */
export function pipelineState(row: { pipeline_progress?: unknown; processing_error?: string | null }) {
  const p = readProgress(row.pipeline_progress);
  return { ...p, error: p.failedStep ? (row.processing_error ?? null) : null };
}

export async function saveProgress(submissionId: string, p: PipelineProgress, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE submissions SET pipeline_progress=$2 WHERE id=$1', [submissionId, JSON.stringify(p)]);
}
