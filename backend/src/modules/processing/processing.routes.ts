import { type Response, Router } from 'express';

import type { AppDeps } from '../../deps.js';
import { AppError, currentUser, parseBody, requirePermission, uuidParam } from '../../http.js';
import { ExternalResultsBody } from './processing.schemas.js';
import { createProcessingService, type TextExport } from './processing.service.js';

/** Seconds a client waits before asking again while the documents are read. */
const EXPORT_RETRY_AFTER_S = '5';

/** 200 with the text, or 202 with Retry-After while documents are still being read. */
function sendTextExport(res: Response, id: string, result: TextExport) {
  if (result.ready) return void res.json(result.text);
  res
    .status(202)
    .set('Retry-After', EXPORT_RETRY_AFTER_S)
    .json({ id, status: 'EXTRACTING', pendingDocuments: result.pending });
}

/**
 * Re-run, retry from the failed step, and processing outside the portal (the Claude CLI does classification and field
 * extraction; no API key needed). Mounted behind requireAuth (app.ts).
 */
export function processingRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createProcessingService(deps);

  router.post('/submissions/:id/reprocess', requirePermission('submission:write'), async (req, res) => {
    await service.rerun(uuidParam(req.params.id, 'Submission'), currentUser(req).id);
    res.status(202).json({ ok: true });
  });

  router.post('/submissions/:id/retry', requirePermission('submission:write'), async (req, res) => {
    await service.retry(uuidParam(req.params.id, 'Submission'), currentUser(req).id);
    res.status(202).json({ ok: true });
  });

  // Imported emails (Settings → Import older email) are only classified on arrival; Process runs the rest.
  router.post('/submissions/:id/process', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    if (!(await service.processImported(id, currentUser(req).id)))
      throw new AppError('NOT_HELD', 409, 'This email is not waiting to be processed');
    res.status(202).json({ ok: true });
  });

  router.post('/submissions/imported/process-all', requirePermission('submission:write'), async (req, res) => {
    res.status(202).json({ queued: await service.processAllImported(currentUser(req).id) });
  });

  router.post('/submissions/errors/retry-all', requirePermission('submission:write'), async (req, res) => {
    res.status(202).json({ queued: await service.retryAllFailed(currentUser(req).id) });
  });

  // POST starts reading the documents not yet read (202), or answers the text at once when there is nothing to read
  // (200). GET answers the text once every document is read (200), 202 while the read runs, and 409
  // EXTRACTION_INCOMPLETE when it finished with documents it could not read.
  router.post('/submissions/:id/extract-text', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    sendTextExport(res, id, await service.startTextExport(id, currentUser(req).id));
  });

  router.get('/submissions/:id/extract-text', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    sendTextExport(res, id, await service.textExport(id));
  });

  // Answered 202 with the submission PROCESSING; poll GET /submissions/:id until it is no longer.
  router.post('/submissions/:id/external-results', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    const external = parseBody(ExternalResultsBody, req.body);
    res.status(202).json(await service.acceptExternalResults(id, external, currentUser(req).id));
  });

  return router;
}
