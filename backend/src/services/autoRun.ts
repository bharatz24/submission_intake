import { pool } from '../db/pool.js';
import type { AutomationSettings } from './appSettings.js';
import { automationSettings } from './appSettings.js';
import { claudeAvailable } from './claude.js';

/**
 * How far the automatic work after processing has got: the Synthesis, the Underwriting Analysis chained on it, and
 * the automatic quote priced from that Analysis. Only automatic runs count (a report or quote someone started has
 * its own progress on its tab). `off`: not going to run by itself (Manual in Settings → Automation, no API key,
 * skipped, or an ignored or duplicate email).
 */
export type AutoRunState = 'off' | 'waiting' | 'running' | 'done' | 'failed';
export interface AutoRun {
  synthesis: AutoRunState;
  analysis: AutoRunState;
  quote: AutoRunState;
}

type Job = 'queued' | 'running' | 'done' | 'failed' | undefined;
interface Report {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  contextVersion: number;
  automatic: boolean;
}

export interface AutoRunInput {
  processing: boolean;
  contextVersion: number;
  settings: Pick<AutomationSettings, 'synthesis' | 'analysis' | 'autoQuote'>;
  ai: boolean;
  synthesis: Report | null;
  analysis: Report | null;
  /** The report job of each report, the auto-quote job of the Analysis, and the submission's processing job. */
  jobs: { synthesis: Job; analysis: Job; quote: Job; process?: Job };
  /** A quote exists for the current context version. */
  quoted: boolean;
}

const active = (j: Job) => j === 'queued' || j === 'running';
const fromReport = (r: Report): AutoRunState =>
  r.status === 'RUNNING' ? 'running' : r.status === 'COMPLETED' ? 'done' : 'failed';

export function autoRunState(i: AutoRunInput): AutoRun {
  const synthAuto = i.ai && i.settings.synthesis === 'AUTO';
  const analysisAuto = synthAuto && i.settings.analysis === 'AUTO';
  const quoteAuto = analysisAuto && i.settings.autoQuote === 'AUTO';
  const current = (r: Report | null) => (r && r.automatic && r.contextVersion === i.contextVersion ? r : null);
  const syn = current(i.synthesis);
  // While processing, the reports of an earlier run are not this run's: everything set to run waits. The processing
  // job marks the submission ready before it starts the Synthesis, so until that report exists it still waits.
  if (i.processing || (!syn && active(i.jobs.process))) {
    const wait = (on: boolean): AutoRunState => (on ? 'waiting' : 'off');
    return { synthesis: wait(synthAuto), analysis: wait(analysisAuto), quote: wait(quoteAuto) };
  }
  const ana = current(i.analysis);

  const synthesis: AutoRunState = syn ? fromReport(syn) : 'off';
  // The Analysis is started by the Synthesis job as it finishes, so it waits while that job is still going.
  const analysis: AutoRunState = ana
    ? fromReport(ana)
    : i.settings.analysis === 'AUTO' && (synthesis === 'running' || (synthesis === 'done' && active(i.jobs.synthesis)))
      ? 'waiting'
      : 'off';
  let quote: AutoRunState = 'off';
  if (ana?.status === 'COMPLETED') {
    if (i.jobs.quote === 'running' || i.jobs.quote === 'queued') quote = 'running';
    else if (i.jobs.quote === 'failed') quote = 'failed';
    else if (i.quoted) quote = 'done';
    // The Analysis job queues the quote as it finishes.
    else if (i.settings.autoQuote === 'AUTO' && active(i.jobs.analysis)) quote = 'waiting';
  } else if (i.settings.autoQuote === 'AUTO' && (analysis === 'running' || analysis === 'waiting')) {
    quote = 'waiting';
  }
  return { synthesis, analysis, quote };
}

const toReport = (
  r: { id: string; status: Report['status']; contextVersion: number; createdBy: unknown } | null,
): Report | null =>
  r ? { id: r.id, status: r.status, contextVersion: r.contextVersion, automatic: r.createdBy === null } : null;

/**
 * autoRunState for one submission's detail, from its newest reports, their jobs and its quotes; with it, whether its
 * processing job is queued or running (read from the same jobs query).
 */
export async function loadAutoRun(
  s: { id: string; status: string; contextVersion: number },
  synthesis: Parameters<typeof toReport>[0],
  analysis: Parameters<typeof toReport>[0],
): Promise<{ autoRun: AutoRun; processingQueued: boolean }> {
  const keys = [
    synthesis && `report:${synthesis.id}`,
    analysis && `report:${analysis.id}`,
    analysis && `auto-quote:${analysis.id}`,
    `process:${s.id}`,
  ];
  const [settings, jobs, quoted] = await Promise.all([
    automationSettings(),
    pool.query(
      // The newest job per key: a retried job leaves its earlier rows behind.
      `SELECT DISTINCT ON (dedupe_key) dedupe_key, status FROM jobs WHERE dedupe_key = ANY($1::text[]) ORDER BY dedupe_key, id DESC`,
      [keys.filter(Boolean)],
    ),
    pool.query('SELECT 1 FROM single_rating WHERE submission_id=$1 AND context_version=$2 LIMIT 1', [
      s.id,
      s.contextVersion,
    ]),
  ]);
  const job = (key: string | null | undefined): Job =>
    key ? jobs.rows.find((j) => j.dedupe_key === key)?.status : undefined;
  const processJob = job(keys[3]);
  const autoRun = autoRunState({
    processing: s.status === 'NEW' || s.status === 'PROCESSING',
    contextVersion: s.contextVersion,
    settings,
    ai: claudeAvailable(),
    synthesis: toReport(synthesis),
    analysis: toReport(analysis),
    jobs: { synthesis: job(keys[0]), analysis: job(keys[1]), quote: job(keys[2]), process: processJob },
    quoted: (quoted.rowCount ?? 0) > 0,
  });
  return { autoRun, processingQueued: active(processJob) };
}
