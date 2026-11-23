import { Router } from 'express';

import type { AppDeps } from '../../deps.js';
import { currentUser, parseBody, requirePermission, uuidParam } from '../../http.js';
import { AddFieldsBody, UpdateFieldBody } from './fields.schemas.js';
import { createFieldsService } from './fields.service.js';

/** POST/PATCH/DELETE /submissions/:id/fields: values entered by hand. Mounted behind requireAuth (app.ts). */
export function fieldsRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createFieldsService(deps);

  router.post('/submissions/:id/fields', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    res.status(201).json(await service.add(id, parseBody(AddFieldsBody, req.body), currentUser(req).id));
  });

  router.patch('/submissions/:id/fields/:fieldId', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    const fieldId = uuidParam(req.params.fieldId, 'Field');
    res.json(await service.update(id, fieldId, parseBody(UpdateFieldBody, req.body), currentUser(req).id));
  });

  router.delete('/submissions/:id/fields/:fieldId', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    res.json(await service.remove(id, uuidParam(req.params.fieldId, 'Field'), currentUser(req).id));
  });

  return router;
}
