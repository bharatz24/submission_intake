import { Router } from 'express';

import type { AppDeps } from '../../deps.js';
import { currentUser, parseBody, requirePermission, uuidParam } from '../../http.js';
import { BulkDeleteBody, InboxView, ListQuery, ReadAllBody } from './inbox.schemas.js';
import { createInboxService } from './inbox.service.js';

/**
 * The inbox: GET /submissions, unread counts, read/unread, and deletes. Mounted before the submissions module, so
 * /submissions/unread-count and /submissions/:view/... are matched before /submissions/:id.
 */
export function inboxRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createInboxService(deps);

  router.get('/submissions', async (req, res) => {
    res.json(await service.list(currentUser(req).id, parseBody(ListQuery, req.query)));
  });

  router.get('/submissions/unread-count', async (req, res) => {
    res.json({ unread: await service.unread(currentUser(req).id) });
  });

  router.post('/submissions/:id/read', async (req, res) => {
    res.json({ unread: await service.setRead(currentUser(req).id, uuidParam(req.params.id, 'Submission'), true) });
  });

  router.delete('/submissions/:id/read', async (req, res) => {
    res.json({ unread: await service.setRead(currentUser(req).id, uuidParam(req.params.id, 'Submission'), false) });
  });

  router.post('/submissions/:view/read-all', async (req, res) => {
    const view = parseBody(InboxView, req.params.view);
    res.json(await service.readAll(currentUser(req).id, view, parseBody(ReadAllBody, req.body)));
  });

  router.post('/submissions/:view/delete', requirePermission('submission:delete'), async (req, res) => {
    const view = parseBody(InboxView, req.params.view);
    res.json({ deleted: await service.bulkDelete(currentUser(req).id, view, parseBody(BulkDeleteBody, req.body)) });
  });

  router.delete('/submissions/:id', requirePermission('submission:delete'), async (req, res) => {
    res.json({ deleted: await service.deleteOne(currentUser(req).id, uuidParam(req.params.id, 'Submission')) });
  });

  return router;
}
