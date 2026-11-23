import { pipeline } from 'node:stream/promises';

import { type Response, Router } from 'express';

import type { AppDeps } from '../../deps.js';
import { currentUser, uuidParam } from '../../http.js';
import { logger } from '../../logger.js';
import { createDocumentsService, type OpenedDocument } from './documents.service.js';

/** Headers are already sent by now: a failure mid-stream can only cut the connection. */
async function send({ body }: OpenedDocument, res: Response) {
  try {
    await pipeline(body, res);
  } catch (err) {
    logger.warn({ err }, 'document stream failed');
    res.destroy();
  }
}

/** Shared by both: never sniffed, and never left in the browser cache (documents can hold PHI; shared computers). */
function documentHeaders(res: Response, doc: OpenedDocument, disposition: 'attachment' | 'inline') {
  res.setHeader('Content-Type', doc.contentType);
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(doc.filename)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
}

/** GET /documents/:id/download and /documents/:id/view (the in-app viewer). Mounted behind requireAuth (app.ts). */
export function documentsRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createDocumentsService(deps);

  router.get('/documents/:id/download', async (req, res) => {
    const doc = await service.openForDownload(uuidParam(req.params.id, 'Document'), currentUser(req).id);
    documentHeaders(res, doc, 'attachment');
    await send(doc, res);
  });

  router.get('/documents/:id/view', async (req, res) => {
    const doc = await service.openForView(uuidParam(req.params.id, 'Document'), currentUser(req).id);
    documentHeaders(res, doc, 'inline');
    res.setHeader(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    );
    await send(doc, res);
  });

  return router;
}
