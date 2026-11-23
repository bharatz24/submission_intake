import { Router } from 'express';
import { z } from 'zod';

import type { AppDeps } from '../../deps.js';
import { currentUser, notFound, parseBody, requirePermission } from '../../http.js';
import { GmailMessageId, pageQuery } from '../shared/schemas.js';
import { createIntakeService } from './intake.service.js';

const SkippedQuery = z.object({ q: z.string().max(200).optional(), ...pageQuery(25, 100).shape });
/** The selected `ids`, otherwise every skipped email matching `q`. */
const SkippedDeleteBody = z.object({
  ids: z.array(GmailMessageId).min(1).max(500).optional(),
  q: z.string().max(200).optional(),
});

/**
 * Gmail messages on their way in: the ingest queue (failed imports, retries) and emails skipped at intake as not a
 * submission (Ignored tab). Mounted behind requireAuth (app.ts).
 */
export function intakeRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createIntakeService(deps);

  /** Gmail messages that failed to import (Errors tab): nothing of them is stored until an attempt succeeds. */
  router.get('/ingest-queue/failed', async (_req, res) => {
    res.json({ items: await service.failed() });
  });

  /** Retry one failed Gmail message now, instead of waiting for its back-off. */
  router.post('/ingest-queue/:id/retry', requirePermission('submission:write'), async (req, res) => {
    await service.retryOne(parseBody(GmailMessageId, req.params.id), currentUser(req).id);
    res.status(202).json({ ok: true });
  });

  /** Make every queued Gmail message due now and drain the queue in the background. */
  router.post('/ingest-queue/retry-now', requirePermission('gmail:manage'), async (req, res) => {
    res.status(202).json({ queued: await service.retryAll(currentUser(req).id) });
  });

  /** Only sender, subject and the reasons are stored for a skipped email. */
  router.get('/skipped-emails', async (req, res) => {
    const q = parseBody(SkippedQuery, req.query);
    res.json(
      await service.skipped({ q: q.q?.trim() || undefined, limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
    );
  });

  /**
   * Override an intake skip: fetch the email from Gmail again and store it as a submission, then process it. Runs in
   * the background (202; `started` false when it already runs); GET the same path for the outcome.
   */
  router.post('/skipped-emails/:id/process', requirePermission('submission:write'), async (req, res) => {
    const id = parseBody(GmailMessageId, req.params.id);
    const user = currentUser(req);
    res.status(202).json({ started: await service.processSkipped(id, { id: user.id, name: user.name }) });
  });

  /** running | done (with submissionId) | failed (with the error) | idle. */
  router.get('/skipped-emails/:id/process', requirePermission('submission:write'), async (req, res) => {
    res.json(await service.processSkippedStatus(parseBody(GmailMessageId, req.params.id)));
  });

  /** Delete (hide) the selected skipped emails, or every one matching the search. */
  router.post('/skipped-emails/delete', requirePermission('submission:delete'), async (req, res) => {
    const body = parseBody(SkippedDeleteBody, req.body);
    res.json({
      deleted: await service.deleteSkipped(currentUser(req).id, { ids: body.ids, q: body.q?.trim() || undefined }),
    });
  });

  router.delete('/skipped-emails/:id', requirePermission('submission:delete'), async (req, res) => {
    const id = parseBody(GmailMessageId, req.params.id);
    const deleted = await service.deleteSkipped(currentUser(req).id, { ids: [id] });
    if (!deleted) throw notFound('Skipped email');
    res.json({ deleted });
  });

  return router;
}
