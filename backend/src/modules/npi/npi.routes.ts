import { Router } from 'express';

import type { AppDeps } from '../../deps.js';
import { AppError, currentUser, parseBody, requirePermission, uuidParam } from '../../http.js';
import { ManualNpiBody, OverrideBody, VerifyBody } from './npi.schemas.js';
import { createNpiService } from './npi.service.js';

/** GET /npi/lookup/:npi (through the injected NPI client) and a submission's NPI checks. Mounted behind requireAuth (app.ts). */
export function npiRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createNpiService(deps);
  const ids = (params: Record<string, string | string[] | undefined>) =>
    [uuidParam(params.id, 'Submission'), uuidParam(params.verificationId, 'NPI verification')] as const;

  router.get('/npi/lookup/:npi', async (req, res) => {
    const npi = String(req.params.npi);
    if (!/^\d{10}$/.test(npi)) throw new AppError('VALIDATION_ERROR', 400, 'NPI must be 10 digits');
    res.json(await service.lookup(npi));
  });

  router.post('/submissions/:id/npi/verify', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    res.json(await service.verify(id, parseBody(VerifyBody, req.body ?? {}), currentUser(req).id));
  });

  router.post('/submissions/:id/npi/manual', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    res.status(201).json(await service.addManual(id, parseBody(ManualNpiBody, req.body), currentUser(req).id));
  });

  router.delete('/submissions/:id/npi/:verificationId', requirePermission('submission:write'), async (req, res) => {
    const [id, verificationId] = ids(req.params);
    res.json(await service.removeManual(id, verificationId, currentUser(req).id));
  });

  router.put(
    '/submissions/:id/npi/:verificationId/override',
    requirePermission('submission:write'),
    async (req, res) => {
      const [id, verificationId] = ids(req.params);
      const body = parseBody(OverrideBody, req.body);
      res.json(await service.override(id, verificationId, body, currentUser(req).id));
    },
  );

  router.delete(
    '/submissions/:id/npi/:verificationId/override',
    requirePermission('submission:write'),
    async (req, res) => {
      const [id, verificationId] = ids(req.params);
      res.json(await service.undoOverride(id, verificationId, currentUser(req).id));
    },
  );

  return router;
}
