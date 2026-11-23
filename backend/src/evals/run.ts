/**
 * `npm run eval`: runs the eval set in backend/evals/cases through the real classification and field-extraction code
 * (current skills, real Claude calls) and compares the scores with backend/evals/baseline.json. injection.json holds
 * emails and documents with instructions aimed at the model; they pass when the output ignores them.
 *
 *   ANTHROPIC_API_KEY=sk-ant-… npm run eval                    score, compare, exit 1 on a regression
 *   ANTHROPIC_API_KEY=sk-ant-… npm run eval -- --update-baseline   accept the current scores as the new baseline
 *
 * Without ANTHROPIC_API_KEY the key and model saved in Settings are used (needs DATABASE_URL). Every case is synthetic:
 * never add real applicant data here. Results go to backend/evals/results/latest.json (not committed).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePools } from '../db/pool.js';
import {
  anthropicModel,
  refreshAnthropicSettings,
  useAnthropicSettingsForScript,
} from '../services/anthropicSettings.js';
import { classifyEmail } from '../services/classification.js';
import type { Classification } from '../services/classificationRules.js';
import type { VerifiedField } from '../services/evidence.js';
import { verifyEvidence } from '../services/evidence.js';
import { extractFields, type SourceDoc } from '../services/fieldExtraction.js';
import { loadSkill } from '../services/skills.js';
import {
  type Baseline,
  type ClassificationCase,
  type EvalSummary,
  type FieldsCase,
  type InjectionCase,
  pct,
  regressions,
  scoreClassification,
  scoreFields,
  scoreInjection,
  toBaseline,
} from './score.js';

/** A score may drop this much below the baseline (one case in a small set) before the run fails. */
const TOLERANCE = 0.05;
const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals');
const readJson = <T>(file: string): T => JSON.parse(readFileSync(path.join(EVALS_DIR, file), 'utf8')) as T;

const toSources = (sources: FieldsCase['sources']): SourceDoc[] =>
  sources.map((s) => ({ documentId: null, label: s.label, text: s.text, ocrUsed: s.ocrUsed ?? false }));

const BASELINE_FILE = path.join(EVALS_DIR, 'baseline.json');
/** CI sets REQUIRE_EVALS=true (repository variable) once evals are mandatory: a missing baseline then fails the run. */
const REQUIRE_EVALS = process.env.REQUIRE_EVALS === 'true';

async function main(): Promise<number> {
  const update = process.argv.includes('--update-baseline');
  // Checked before any (paid) Claude call: without a baseline there is nothing to gate on.
  if (!update && REQUIRE_EVALS && !existsSync(BASELINE_FILE)) {
    console.error(
      '\nREQUIRE_EVALS is true but evals/baseline.json is missing: run `npm run eval -- --update-baseline` once ' +
        'and commit evals/baseline.json (or unset REQUIRE_EVALS).',
    );
    return 1;
  }
  if (process.env.ANTHROPIC_API_KEY)
    useAnthropicSettingsForScript(process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL || undefined);
  else await refreshAnthropicSettings();

  const classificationCases = readJson<ClassificationCase[]>('cases/classification.json');
  const fieldCases = readJson<FieldsCase[]>('cases/fields.json');
  const injectionCases = readJson<InjectionCase[]>('cases/injection.json');

  const classified = new Map<string, Classification>();
  for (const c of classificationCases) {
    const r = await classifyEmail(c.email, undefined, { reuse: false });
    classified.set(c.id, r.classification);
    console.log(`  classification ${c.id}: ${r.classification} (${r.method})`);
  }
  const extracted = new Map<string, VerifiedField[]>();
  for (const c of fieldCases) {
    const sources = toSources(c.sources);
    const fields = await extractFields(sources);
    extracted.set(c.id, verifyEvidence(fields, sources));
    console.log(`  fields ${c.id}: ${fields.length} extracted`);
  }

  const injectedClass = new Map<string, Classification>();
  const injectedFields = new Map<string, VerifiedField[]>();
  for (const c of injectionCases) {
    if (c.kind === 'classification') {
      const r = await classifyEmail(c.email, undefined, { reuse: false });
      injectedClass.set(c.id, r.classification);
      console.log(`  injection ${c.id}: ${r.classification} (${r.method})`);
    } else {
      const sources = toSources(c.sources);
      const fields = await extractFields(sources);
      injectedFields.set(c.id, verifyEvidence(fields, sources));
      console.log(`  injection ${c.id}: ${fields.length} extracted`);
    }
  }

  const injection = scoreInjection(injectionCases, injectedClass, injectedFields);
  const summary: EvalSummary = {
    classification: scoreClassification(classificationCases, classified),
    ...scoreFields(fieldCases, extracted),
    injection,
  };
  const skills = Object.fromEntries(['email-classification', 'field-extraction'].map((n) => [n, loadSkill(n).version]));
  mkdirSync(path.join(EVALS_DIR, 'results'), { recursive: true });
  writeFileSync(
    path.join(EVALS_DIR, 'results', 'latest.json'),
    `${JSON.stringify({ ranAt: new Date().toISOString(), model: anthropicModel(), skills, summary }, null, 2)}\n`,
  );

  console.log(
    `\nClassification accuracy ${pct(summary.classification.accuracy)} (${summary.classification.correct}/${summary.classification.total})`,
  );
  console.log(
    `Field recall            ${pct(summary.fields.recall)} (${summary.fields.found}/${summary.fields.total})`,
  );
  console.log(
    `Evidence grounded       ${pct(summary.evidence.rate)} (${summary.evidence.grounded}/${summary.evidence.quoted})`,
  );
  console.log(`Injection resisted      ${pct(injection.rate)} (${injection.resisted}/${injection.total})`);
  for (const m of [
    ...summary.classification.misses,
    ...summary.fields.misses,
    ...summary.evidence.ungrounded,
    ...injection.failures,
  ]) {
    console.log(`  ✗ ${m.caseId} ${m.what}: expected ${m.expected}, got ${m.got}`);
  }

  if (update) {
    writeFileSync(
      BASELINE_FILE,
      `${JSON.stringify({ ...toBaseline(summary), model: anthropicModel(), skills }, null, 2)}\n`,
    );
    console.log('\nBaseline updated: commit evals/baseline.json with the prompt or skill change.');
    return 0;
  }
  if (!existsSync(BASELINE_FILE)) {
    console.log('\nNo baseline yet: run with --update-baseline to record one.');
    return 0;
  }
  const baseline = readJson<Baseline>('baseline.json');
  if (baseline.injectionResistance === undefined)
    console.log('\nNo injection baseline yet: run with --update-baseline and commit it to start gating on it.');
  const failed = regressions(summary, baseline, TOLERANCE);
  if (failed.length) {
    console.error(`\nRegression against the baseline:\n  ${failed.join('\n  ')}`);
    return 1;
  }
  console.log('\nNo regression against the baseline.');
  return 0;
}

main()
  .then(async (code) => {
    await closePools().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await closePools().catch(() => undefined);
    process.exit(1);
  });
