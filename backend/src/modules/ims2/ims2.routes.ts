import { Router } from 'express';
import { z } from 'zod';

import type { AppDeps } from '../../deps.js';
import { currentUser, parseBody, requirePermission, uuidParam } from '../../http.js';
import type { LookupQuery } from '../../services/ims2.js';
import { queueFormSchema } from '../../services/intakeQueuePayload.js';
import { createIms2Service } from './ims2.service.js';

/** The lookup query (API-03): known keys only, each a bounded string; blank ones are dropped. */
const lookupField = (max: number) => z.string().trim().max(max).optional();
const LookupQuerySchema = z.object({
  npi: lookupField(20),
  email: lookupField(320),
  licenseNumber: lookupField(50),
  name: lookupField(200),
  brokerCode: lookupField(50),
  brokerName: lookupField(200),
});

/**
 * /submissions/:id/ims2-queue (overview, lookup, send, status, status refresh) and /ims2-queue/sync. Mounted behind
 * requireAuth (app.ts).
 */
export function ims2Router(deps: AppDeps): Router {
  const router = Router();
  const service = createIms2Service(deps);
  const submissionId = (value: string | string[] | undefined) => uuidParam(value, 'Submission');

  router.get('/submissions/:id/ims2-queue', async (req, res) => {
    res.json(await service.overview(submissionId(req.params.id)));
  });

  router.get('/submissions/:id/ims2-queue/lookup', requirePermission('submission:write'), async (req, res) => {
    const id = submissionId(req.params.id);
    const query = parseBody(LookupQuerySchema, req.query);
    const given: LookupQuery = Object.fromEntries(Object.entries(query).filter(([, v]) => v));
    res.json(await service.lookup(id, given));
  });

  router.post('/submissions/:id/ims2-queue/send', requirePermission('submission:write'), async (req, res) => {
    const id = submissionId(req.params.id);
    const form = parseBody(queueFormSchema, req.body);
    res.json(await service.send(id, form, currentUser(req)));
  });

  /** The last known state, read-only (no IMS 2 call, no write): open to every signed-in user (SEC-07). */
  router.get('/submissions/:id/ims2-queue/status', async (req, res) => {
    res.json(await service.status(submissionId(req.params.id)));
  });

  /** Asks IMS 2 for the intake's state and stores it. */
  router.post('/submissions/:id/ims2-queue/status/refresh', requirePermission('submission:write'), async (req, res) => {
    res.json(await service.refreshStatus(submissionId(req.params.id), currentUser(req).id));
  });

  router.get('/ims2-queue/sync', async (_req, res) => {
    res.json(await service.syncOverview());
  });

  /** Starts a sync in the background (202, PERF-01); GET /ims2-queue/sync shows when it is done (lastSync.at >= since). */
  router.post('/ims2-queue/sync', requirePermission('submission:write'), async (req, res) => {
    res.status(202).json(await service.startSync(currentUser(req)));
  });

  return router;
}
