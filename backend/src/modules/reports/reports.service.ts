import { withTransaction } from '../../db/pool.js';
import type { AppDeps } from '../../deps.js';
import { AppError, notFound } from '../../http.js';
import { audit } from '../../services/audit.js';
import { startComparison } from '../../services/comparisons.js';
import { reportInput, saveExternalReport, startReport } from '../../services/reports.js';
import { requireLiveSubmission } from '../shared/submissionGuards.js';
import * as repo from './reports.repository.js';

type Kind = 'SYNTHESIS' | 'ANALYSIS';

/**
 * Synthesis and Analysis reports and comparisons of two versions. Starting one queues the Claude call (a job); a
 * COMPLETED report for the same evidence (context version) and skill version is returned as-is unless `force`.
 */
export function createReportsService({ db }: Pick<AppDeps, 'db'>) {
  return {
    async start(id: string, kind: Kind, actorId: string, opts: { basedOnReportId?: string; force?: boolean }) {
      await requireLiveSubmission(db, id);
      const reportId = await startReport(id, kind, actorId, opts.basedOnReportId, { force: opts.force });
      return repo.reportSummary(db, reportId);
    },

    /** What the Claude CLI needs to write a report outside the portal (no API key needed). */
    input: (id: string, kind: Kind, basedOnReportId?: string) => reportInput(id, kind, basedOnReportId),

    async saveExternal(id: string, kind: Kind, content: unknown, actorId: string, basedOnReportId?: string) {
      await requireLiveSubmission(db, id);
      return repo.reportSummary(db, await saveExternalReport(id, kind, content, actorId, basedOnReportId));
    },

    async list(id: string, kind?: Kind) {
      await requireLiveSubmission(db, id);
      return repo.listReports(db, id, kind ?? null);
    },

    async get(reportId: string) {
      const report = await repo.getLiveReport(db, reportId);
      if (!report) throw notFound('Report');
      return report;
    },

    /** Acknowledge an automatic report (idempotent: the first reviewer is kept); returns the report. */
    async review(id: string, reportId: string, actorId: string) {
      await requireLiveSubmission(db, id);
      const found = await withTransaction(async (tx) => {
        const r = await repo.markReportReviewed(tx, id, reportId, actorId);
        if (r === 'NOT_COMPLETED')
          throw new AppError('REPORT_NOT_COMPLETED', 409, 'Only a completed report can be marked reviewed');
        if (r?.reviewed)
          await audit(
            {
              action: 'REPORT_REVIEWED',
              entityType: 'report',
              entityId: reportId,
              submissionId: id,
              actorId,
              details: { kind: r.kind, version: r.version },
            },
            tx,
          );
        return r !== null;
      });
      if (!found) throw notFound('Report');
      return this.get(reportId);
    },

    async compare(id: string, kind: Kind, baseReportId: string, targetReportId: string, actorId: string) {
      await requireLiveSubmission(db, id);
      return repo.comparisonSummary(db, await startComparison(id, kind, baseReportId, targetReportId, actorId));
    },

    async listComparisons(id: string, kind?: Kind) {
      await requireLiveSubmission(db, id);
      return repo.listComparisons(db, id, kind ?? null);
    },

    async getComparison(comparisonId: string) {
      const comparison = await repo.getLiveComparison(db, comparisonId);
      if (!comparison) throw notFound('Comparison');
      return comparison;
    },
  };
}
