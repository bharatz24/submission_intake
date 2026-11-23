import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Baseline, EvalSummary } from '../evals/score.js';
import { moduleDir } from '../runtime/moduleDir.js';

/**
 * The eval evidence behind each evaluated skill, for Settings → Skills (llm-integration skill: "show the last eval
 * result next to skill edits"). The server never runs evals itself (they cost Claude calls and run in CI or by hand,
 * `npm run eval`); it reads what they recorded: evals/baseline.json (committed with the skill change that moved it)
 * and evals/results/latest.json (the last local run, when present).
 */

/** The skills the eval set exercises (src/evals/run.ts). */
export const EVALUATED_SKILLS = ['email-classification', 'field-extraction'] as const;

const EVALS_DIR = path.resolve(moduleDir(import.meta.url, 'backend/dist/services'), '..', '..', 'evals');

export interface EvalScores {
  classificationAccuracy: number;
  fieldRecall: number;
  evidenceRate: number;
}
export interface EvalRecord {
  scores: EvalScores;
  skillVersion: string | null;
  model: string | null;
  ranAt: string | null;
}
export interface SkillEvalStatus {
  baseline: EvalRecord | null;
  latest: EvalRecord | null;
  /** True when the baseline was recorded for the skill version in use now (Settings edits make a new version). */
  baselineCurrent: boolean;
}

type BaselineFile = Baseline & { model?: string; skills?: Record<string, string> };
type LatestFile = { ranAt?: string; model?: string; skills?: Record<string, string>; summary?: EvalSummary };

function readJson<T>(file: string): T | null {
  const full = path.join(EVALS_DIR, file);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The eval status of `skill` at `currentVersion`; null for a skill the eval set does not cover. */
export function skillEvalStatus(skill: string, currentVersion: string): SkillEvalStatus | null {
  if (!(EVALUATED_SKILLS as readonly string[]).includes(skill)) return null;
  const base = readJson<BaselineFile>('baseline.json');
  const last = readJson<LatestFile>(path.join('results', 'latest.json'));
  const baseline: EvalRecord | null = base
    ? {
        scores: {
          classificationAccuracy: base.classificationAccuracy,
          fieldRecall: base.fieldRecall,
          evidenceRate: base.evidenceRate,
        },
        skillVersion: base.skills?.[skill] ?? null,
        model: base.model ?? null,
        ranAt: null,
      }
    : null;
  const latest: EvalRecord | null = last?.summary
    ? {
        scores: {
          classificationAccuracy: last.summary.classification.accuracy,
          fieldRecall: last.summary.fields.recall,
          evidenceRate: last.summary.evidence.rate,
        },
        skillVersion: last.skills?.[skill] ?? null,
        model: last.model ?? null,
        ranAt: last.ranAt ?? null,
      }
    : null;
  return { baseline, latest, baselineCurrent: !!baseline && baseline.skillVersion === currentVersion };
}
