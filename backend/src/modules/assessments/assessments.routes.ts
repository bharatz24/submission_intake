import { Router } from 'express';

import type { AppDeps } from '../../deps.js';
import { currentUser, parseBody, requirePermission, uuidParam } from '../../http.js';
import { RecordAssessmentBody } from './assessments.schemas.js';
import { createAssessmentsService } from './assessments.service.js';

/** GET/POST /api/submissions/:id/assessments. Mounted behind requireAuth (app.ts). */
export function assessmentsRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createAssessmentsService(deps);

  router.get('/submissions/:id/assessments', async (req, res) => {
    res.json({ items: await service.list(uuidParam(req.params.id, 'Submission')) });
  });

  router.post('/submissions/:id/assessments', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    const created = await service.record(id, parseBody(RecordAssessmentBody, req.body), currentUser(req));
    res.status(201).location(`/api/submissions/${id}/assessments`).json(created);
  });

  return router;
}
