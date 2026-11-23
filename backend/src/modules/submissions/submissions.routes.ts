import { Router } from 'express';

import type { AppDeps } from '../../deps.js';
import {
  AppError,
  can,
  currentUser,
  parseBody,
  removeUploadedFiles,
  requirePermission,
  uuidParam,
} from '../../http.js';
import { chunkedUploads, uploadedAttachments, uploadFiles, uploadGuard } from '../shared/uploads.js';
import { ClassificationBody, DuplicateBody, UpdateBody, UploadBody } from './submissions.schemas.js';
import { createSubmissionsService } from './submissions.service.js';

/**
 * One submission's own state: GET/PATCH /submissions/:id, uploads (new email, added documents), classification override
 * and duplicate link. Mounted behind requireAuth, after the inbox module (app.ts).
 */
export function submissionsRouter(deps: AppDeps): Router {
  const router = Router();
  const service = createSubmissionsService(deps);
  // Netlify: JSON { uploadIds } naming chunked uploads, as well as multipart (modules/shared/uploads.ts).
  const fromChunks = chunkedUploads(deps);

  router.post(
    '/submissions/upload',
    requirePermission('submission:write'),
    fromChunks,
    uploadGuard,
    uploadFiles,
    async (req, res) => {
      try {
        const body = parseBody(UploadBody, req.body);
        // Admin only (P2-07): the Gmail ids are trusted as-is, and an upload claiming a message id makes the importer skip the
        // real Gmail message with that id for good (ingestEmail is idempotent on it); a thread id files it under another thread.
        if ((body.gmailMessageId || body.rfcMessageId || body.threadId) && !can(req, 'submission:import-gmail-ids')) {
          throw new AppError(
            'FORBIDDEN',
            403,
            'Only an admin can upload with Gmail message ids (gmailMessageId, rfcMessageId, threadId)',
          );
        }
        const { created, submission } = await service.upload(body, uploadedAttachments(req), currentUser(req).id);
        res.status(created ? 201 : 200).json(submission);
      } finally {
        await removeUploadedFiles(req);
      }
    },
  );

  router.get('/submissions/:id', async (req, res) => {
    res.json(await service.get(uuidParam(req.params.id, 'Submission')));
  });

  router.patch('/submissions/:id', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    res.json(await service.update(id, parseBody(UpdateBody, req.body), currentUser(req)));
  });

  router.post(
    '/submissions/:id/documents',
    requirePermission('submission:write'),
    fromChunks,
    uploadGuard,
    uploadFiles,
    async (req, res) => {
      try {
        const id = uuidParam(req.params.id, 'Submission');
        res.status(201).json(await service.addDocuments(id, uploadedAttachments(req), currentUser(req).id));
      } finally {
        await removeUploadedFiles(req);
      }
    },
  );

  router.post('/submissions/:id/classification', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    res.json(await service.overrideClassification(id, parseBody(ClassificationBody, req.body), currentUser(req)));
  });

  router.post('/submissions/:id/duplicate', requirePermission('submission:write'), async (req, res) => {
    const id = uuidParam(req.params.id, 'Submission');
    res.json(await service.setDuplicate(id, parseBody(DuplicateBody, req.body), currentUser(req)));
  });

  return router;
}
