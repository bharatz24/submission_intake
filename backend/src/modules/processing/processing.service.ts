import { withTransaction } from '../../db/pool.js';
import type { AppDeps } from '../../deps.js';
import { AppError, notFound } from '../../http.js';
import { audit, auditMany } from '../../services/audit.js';
import { jobs } from '../../services/jobQueue.js';
import {
  enqueueExternalResults,
  enqueueProcessing,
  enqueueTextExport,
  retryProcessing,
  textExportKey,
} from '../../services/pipeline.js';
import { readProgress, resumeStep } from '../../services/pipelineProgress.js';
import { getSubmissionDetail } from '../../services/queries.js';
import { assertNotDuplicate, requireLiveSubmission } from '../shared/submissionGuards.js';
import * as repo from './processing.repository.js';
import type { ExternalResultsBody } from './processing.schemas.js';

/** The text export: ready (the text), or still reading documents. */
export type TextExport =
  | { ready: true; text: Awaited<ReturnType<typeof repo.textExport>> }
  | { ready: false; pending: number };

/** Bulk actions work in chunks of this many rows, one transaction and one job INSERT each (PERF-09)... */
export const BULK_CHUNK = 500;
/** ...and stop after this many, so one click never holds the API for an unbounded table. Clicking again continues. */
export const BULK_MAX = 5000;

/** The queued run of a resumed or released submission: same key and payload as enqueueProcessing / retryProcessing. */
const processJob = (submissionId: string, actorId: string, resume: boolean) => ({
  key: `process:${submissionId}`,
  payload: { submissionId, actorId, skipClassification: true, byPerson: true, ...(resume ? { resume: true } : {}) },
});

/** Running the pipeline again: a full re-run, a resume from the failed step, and processing outside the portal. */
export function createProcessingService({ db }: Pick<AppDeps, 'db'>) {
  async function processImported(id: string, actorId: string, opts: { bulk?: boolean } = {}): Promise<boolean> {
    const released = await withTransaction(async (tx) => {
      if (!(await repo.lockHeldForImport(tx, id))) return false;
      await repo.releaseImportHold(tx, id);
      // The verdict reached at import is kept; a person asked, so every step runs.
      return enqueueProcessing(id, actorId, { skipClassification: true, byPerson: true }, tx);
    });
    if (released)
      await audit({
        action: 'IMPORT_PROCESS_REQUESTED',
        entityType: 'submission',
        entityId: id,
        submissionId: id,
        actorId,
        ...(opts.bulk ? { details: { bulk: true } } : {}),
      });
    return released;
  }

  return {
    /** "Re-run": every document read again and the pipeline from the start. */
    async rerun(id: string, actorId: string) {
      const { status } = await getSubmissionDetail(id);
      assertNotDuplicate(status);
      if (status === 'NOT_SUBMISSION') {
        throw new AppError(
          'NOT_PROCESSABLE',
          409,
          'Ignored emails are not processed; change the classification to process it',
        );
      }
      await repo.resetForRerun(db, id);
      // A run already waiting will read the documents just reset; asking again would only repeat it.
      if (!(await enqueueProcessing(id, actorId, { skipClassification: true, byPerson: true }))) {
        throw new AppError('ALREADY_QUEUED', 409, 'Reprocessing is already queued for this submission');
      }
      await audit({ action: 'REPROCESS_REQUESTED', entityType: 'submission', entityId: id, submissionId: id, actorId });
    },

    /**
     * "Retry from failed step": resume the failed run, keeping the steps it finished and the documents it read. For a
     * failed run only (status ERROR, or a decided submission whose refresh failed); "Re-run" starts over.
     */
    async retry(id: string, actorId: string) {
      const s = await repo.progressOf(db, id);
      if (!s) throw notFound('Submission');
      const progress = readProgress(s.pipeline_progress);
      if (s.status === 'NEW' || s.status === 'PROCESSING' || (await jobs.isActive(`process:${id}`))) {
        throw new AppError('ALREADY_QUEUED', 409, 'Processing is already queued or running for this submission');
      }
      if (s.status !== 'ERROR' && !progress.failedStep) {
        throw new AppError(
          'NOT_PROCESSABLE',
          409,
          'There is no failed processing run to retry; use Re-run to process it again',
        );
      }
      if (!(await retryProcessing(id, actorId)))
        throw new AppError('ALREADY_QUEUED', 409, 'Processing is already queued for this submission');
      await audit({
        action: 'PROCESSING_RETRIED',
        entityType: 'submission',
        entityId: id,
        submissionId: id,
        actorId,
        details: { fromStep: resumeStep(progress) },
      });
    },

    /**
     * "Process" on an imported email (Settings → Import older email): it was only classified when it arrived; this
     * runs everything else (documents, extraction, NPI, then the reports as set in Settings → Automation).
     * False when it is not held for Process (already processed, or processing).
     */
    processImported,

    /**
     * "Process all imported": every imported email still waiting for Process, in chunks (one transaction, one job
     * INSERT and one audit INSERT per chunk), at most BULK_MAX per click.
     */
    async processAllImported(actorId: string) {
      let held = 0;
      let queued = 0;
      while (held < BULK_MAX) {
        const chunk = await withTransaction(async (tx) => {
          const ids = await repo.heldChunk(tx, Math.min(BULK_CHUNK, BULK_MAX - held));
          if (!ids.length) return null;
          await repo.releaseImportHolds(tx, ids);
          const keys = new Set(
            await jobs.enqueueMany(
              'process',
              ids.map((id) => processJob(id, actorId, false)),
              { db: tx },
            ),
          );
          const started = ids.filter((id) => keys.has(`process:${id}`));
          await auditMany(
            started.map((id) => ({
              action: 'IMPORT_PROCESS_REQUESTED',
              entityType: 'submission',
              entityId: id,
              submissionId: id,
              actorId,
              details: { bulk: true },
            })),
            tx,
          );
          return { rows: ids.length, queued: started.length };
        });
        if (!chunk) break;
        held += chunk.rows;
        queued += chunk.queued;
        if (chunk.rows < BULK_CHUNK) break;
      }
      await audit({
        action: 'IMPORT_PROCESS_REQUESTED',
        entityType: 'submission',
        actorId,
        details: { bulk: true, held, queued, ...(held >= BULK_MAX ? { capped: BULK_MAX } : {}) },
      });
      return queued;
    },

    /** Errors tab "Retry all": every submission whose processing failed resumes from its failed step. */
    // In chunks like processAllImported; a submission whose run is already queued keeps its state, as with one retry.
    async retryAllFailed(actorId: string) {
      let failed = 0;
      let queued = 0;
      let after: string | null = null;
      while (failed < BULK_MAX) {
        const chunk: { rows: number; queued: number; last: string | null } | null = await withTransaction(
          async (tx) => {
            const rows = await repo.failedChunk(tx, after, Math.min(BULK_CHUNK, BULK_MAX - failed));
            if (!rows.length) return null;
            const keys = new Set(
              await jobs.enqueueMany(
                'process',
                rows.map((r) => processJob(r.id, actorId, true)),
                { db: tx },
              ),
            );
            const started = rows.filter((r) => keys.has(`process:${r.id}`));
            await repo.markRetrying(
              tx,
              started.map((r) => r.id),
            );
            await auditMany(
              started.map((r) => ({
                action: 'PROCESSING_RETRIED',
                entityType: 'submission',
                entityId: r.id,
                submissionId: r.id,
                actorId,
                details: { fromStep: resumeStep(readProgress(r.pipeline_progress)), bulk: true },
              })),
              tx,
            );
            return { rows: rows.length, queued: started.length, last: rows.at(-1)?.id ?? after };
          },
        );
        if (!chunk) break;
        failed += chunk.rows;
        queued += chunk.queued;
        after = chunk.last;
        if (chunk.rows < BULK_CHUNK) break;
      }
      await audit({
        action: 'PROCESSING_RETRIED',
        entityType: 'submission',
        actorId,
        details: { bulk: true, failed, queued, ...(failed >= BULK_MAX ? { capped: BULK_MAX } : {}) },
      });
      return queued;
    },

    /** Starts reading the documents not yet read (in the background), or answers the text when there is nothing to read. */
    async startTextExport(id: string, actorId: string): Promise<TextExport> {
      await requireLiveSubmission(db, id);
      const pending = await repo.pendingDocuments(db, id);
      if (!pending) return { ready: true, text: await repo.textExport(db, id) };
      await enqueueTextExport(id, actorId); // false: already queued, which is just as good
      return { ready: false, pending };
    },

    /** The text once every document is read; still reading; or 409 when the read finished with documents it could not read. */
    async textExport(id: string): Promise<TextExport> {
      await requireLiveSubmission(db, id);
      const pending = await repo.pendingDocuments(db, id);
      if (!pending) return { ready: true, text: await repo.textExport(db, id) };
      if (await jobs.isActive(textExportKey(id))) return { ready: false, pending };
      const lastError = await repo.lastJobError(db, textExportKey(id));
      throw new AppError(
        'EXTRACTION_INCOMPLETE',
        409,
        `${pending} document${pending === 1 ? ' was' : 's were'} not read${lastError ? `: ${lastError}` : ''}. POST /extract-text to try again.`,
      );
    },

    /**
     * Results computed outside the portal, run through the rest of the pipeline as a job (it can take minutes). Checked
     * and queued under a row lock, so of two concurrent posts only one queues a run; the other finds one queued or running.
     */
    async acceptExternalResults(id: string, external: ExternalResultsBody, actorId: string) {
      await withTransaction(async (tx) => {
        const cur = await repo.lockStatus(tx, id);
        if (!cur) throw notFound('Submission');
        assertNotDuplicate(cur.status);
        if ((await jobs.isActive(`process:${id}`, tx)) || !(await enqueueExternalResults(id, actorId, external, tx))) {
          throw new AppError(
            'STILL_PROCESSING',
            409,
            'This submission is already being processed; try again once it finishes',
          );
        }
        // An underwriter's IN_REVIEW/COMPLETED stays as it is: processSubmission keeps it, and its own lock serializes runs.
        if (cur.status !== 'IN_REVIEW' && cur.status !== 'COMPLETED') await repo.markProcessing(tx, id);
      });
      await audit({
        action: 'EXTERNAL_RESULTS_RECEIVED',
        entityType: 'submission',
        entityId: id,
        submissionId: id,
        actorId,
        details: { classification: external.classification, fields: external.fields.length },
      });
      return getSubmissionDetail(id);
    },
  };
}
