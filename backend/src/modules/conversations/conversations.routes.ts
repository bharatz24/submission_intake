import { Router } from 'express';

import type { AppDeps } from '../../deps.js';
import { currentUser, parseBody, requirePermission, uuidParam } from '../../http.js';
import { aiLimiter, sendLimiter } from '../shared/rateLimits.js';
import { AudienceParam, ChatBody, DraftEditBody, IdempotencyKey, OutboundBody } from './conversations.schemas.js';
import { createConversationsService } from './conversations.service.js';

/** /submissions/:id/chat, /email-drafts and /outbound-emails. Mounted behind requireAuth (app.ts). */
export function conversationsRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createConversationsService(deps);
  const submissionId = (value: string | string[] | undefined) => uuidParam(value, 'Submission');

  router.get('/submissions/:id/chat', async (req, res) => {
    res.json({ items: await service.chat(submissionId(req.params.id)) });
  });

  router.post('/submissions/:id/chat', requirePermission('submission:write'), aiLimiter, async (req, res) => {
    const id = submissionId(req.params.id);
    const { message } = parseBody(ChatBody, req.body);
    res.status(202).json(await service.ask(id, currentUser(req).id, message));
  });

  // Draft Emails dialog: one draft per audience (broker, insured, quote) from the latest completed analysis
  // (services/emailDraft.ts). POST queues a new one (202); poll GET until `run` is no longer PENDING.
  router.get('/submissions/:id/email-drafts', async (req, res) => {
    const id = submissionId(req.params.id);
    res.json(await service.draft(id, parseBody(AudienceParam, req.query).audience));
  });

  router.post('/submissions/:id/email-drafts', requirePermission('submission:write'), aiLimiter, async (req, res) => {
    const id = submissionId(req.params.id);
    res
      .status(202)
      .json(await service.requestDraft(id, currentUser(req).id, parseBody(AudienceParam, req.body).audience));
  });

  router.put('/submissions/:id/email-drafts/:draftId', requirePermission('submission:write'), async (req, res) => {
    const id = submissionId(req.params.id);
    const body = parseBody(DraftEditBody, req.body);
    res.json(await service.editDraft(id, uuidParam(req.params.draftId, 'Draft'), body));
  });

  router.get('/submissions/:id/outbound-emails', async (req, res) => {
    res.json({ items: await service.sent(submissionId(req.params.id)) });
  });

  /**
   * Send a reply/forward. Clients send an Idempotency-Key header (or `idempotencyKey` in the body), one per compose
   * dialog: a retry with it answers 200 with the email already sent instead of sending it again.
   */
  router.post(
    '/submissions/:id/outbound-emails',
    requirePermission('submission:write'),
    sendLimiter,
    async (req, res) => {
      const id = submissionId(req.params.id);
      const body = parseBody(OutboundBody, req.body);
      const header = req.get('Idempotency-Key');
      const key = header !== undefined ? parseBody(IdempotencyKey, header) : body.idempotencyKey;
      const { email, replayed } = await service.send(id, body, key ?? null, currentUser(req).id);
      res.status(replayed ? 200 : 201).json(email);
    },
  );

  return router;
}
