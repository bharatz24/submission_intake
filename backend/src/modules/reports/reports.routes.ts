import { Router } from 'express';

import type { AppDeps } from '../../deps.js';
import { currentUser, parseBody, requirePermission, uuidParam } from '../../http.js';
import { aiLimiter } from '../shared/rateLimits.js';
import {
  AnalysisBody,
  ComparisonBody,
  ExternalReportBody,
  KindQuery,
  ReportInputQuery,
  SynthesisBody,
} from './reports.schemas.js';
import { createReportsService } from './reports.service.js';

/** Reports (synthesis, analysis, written outside the portal) and comparisons. Mounted behind requireAuth (app.ts). */
export function reportsRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createReportsService(deps);

  router.post('/submissions/:id/synthesis', requirePermission('submission:write'), aiLimiter, async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    const body = parseBody(SynthesisBody, req.body ?? {});
    res.status(202).json(await service.start(id, 'SYNTHESIS', currentUser(req).id, { force: body.force }));
  });

  router.post('/submissions/:id/analysis', requirePermission('submission:write'), aiLimiter, async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    const body = parseBody(AnalysisBody, req.body ?? {});
    res.status(202).json(
      await service.start(id, 'ANALYSIS', currentUser(req).id, {
        basedOnReportId: body.synthesisReportId,
        force: body.force,
      }),
    );
  });

  router.get('/submissions/:id/report-input', requirePermission('submission:write'), async (req, res) => {
    const q = parseBody(ReportInputQuery, req.query);
    res.json(await service.input(uuidParam(req.params.id, 'Submission'), q.kind, q.basedOnReportId));
  });

  router.post('/submissions/:id/external-report', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    const body = parseBody(ExternalReportBody, req.body);
    res
      .status(201)
      .json(await service.saveExternal(id, body.kind, body.content, currentUser(req).id, body.basedOnReportId));
  });

  router.get('/submissions/:id/reports', async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    res.json({ items: await service.list(id, parseBody(KindQuery, req.query).kind) });
  });

  router.get('/reports/:id', async (req, res) => {
    res.json(await service.get(uuidParam(req.params.id, 'Report')));
  });

  /** Acknowledge a report generated automatically ("Mark reviewed"). */
  router.post('/submissions/:id/reports/:reportId/review', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    res.json(await service.review(id, uuidParam(req.params.reportId, 'Report'), currentUser(req).id));
  });

  router.post('/submissions/:id/comparisons', requirePermission('submission:write'), aiLimiter, async (req, res) => {
    const body = parseBody(ComparisonBody, req.body);
    const id = uuidParam(req.params.id, 'Submission');
    res
      .status(202)
      .json(await service.compare(id, body.kind, body.baseReportId, body.targetReportId, currentUser(req).id));
  });

  router.get('/submissions/:id/comparisons', async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    res.json({ items: await service.listComparisons(id, parseBody(KindQuery, req.query).kind) });
  });

  router.get('/comparisons/:id', async (req, res) => {
    res.json(await service.getComparison(uuidParam(req.params.id, 'Comparison')));
  });

  return router;
}
