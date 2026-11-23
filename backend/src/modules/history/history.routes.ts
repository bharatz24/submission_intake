import { Router } from 'express';
import { z } from 'zod';

import { AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX } from '../../constants.js';
import type { AppDeps } from '../../deps.js';
import { parseBody, requirePermission, uuidParam } from '../../http.js';
import { pageQuery } from '../shared/schemas.js';
import { requireLiveSubmission } from '../shared/submissionGuards.js';
import * as repo from './history.repository.js';

const AuditQuery = z.object({
  action: z.string().max(100).optional(),
  submissionId: z.uuid().optional(),
  ...pageQuery(50, 200).shape,
});

/**
 * GET /submissions/:id/versions, /submissions/:id/audit and the global /audit (admins: it shows applicant names and
 * email recipients). Reads only, so no service layer. Mounted behind requireAuth (app.ts).
 */
export function historyRouter({ db }: AppDeps): Router {
  const router = Router();

  router.get('/submissions/:id/versions', async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    await requireLiveSubmission(db, id);
    res.json(await repo.versions(db, id));
  });

  /** One submission's audit trail, newest first, a page at a time (the same shape as GET /audit). */
  router.get('/submissions/:id/audit', async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    const page = parseBody(pageQuery(AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX), req.query);
    await requireLiveSubmission(db, id);
    res.json(await repo.auditPage(db, { submissionId: id }, page));
  });

  router.get('/audit', requirePermission('audit:view'), async (req, res) => {
    const q = parseBody(AuditQuery, req.query);
    res.json(await repo.auditPage(db, { action: q.action, submissionId: q.submissionId }, q));
  });

  return router;
}
