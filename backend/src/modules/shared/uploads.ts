import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

import { config, isNetlifyRuntime } from '../../config.js';
import type { AppDeps } from '../../deps.js';
import { AppError, currentUser, limitedUpload, parseBody, UPLOAD_TMP_DIR, uploadedFiles } from '../../http.js';
import { logger } from '../../logger.js';
import { limits } from '../../services/limitsSettings.js';
import { StorageError } from '../../services/storage.js';
import { ChunkMissingError } from '../uploads/chunkStore.js';
import { ownUpload } from '../uploads/uploads.routes.js';

/**
 * Uploads go to temporary files (multer), so both the size of one request and the number read at once are capped:
 * Content-Length over UPLOAD_MAX_TOTAL_MB is refused before any byte is read (413; without one, 411), and at most
 * UPLOAD_CONCURRENCY uploads are read at a time, the rest waiting their turn (503 when the queue is long). One queue
 * for the whole process, shared by every upload route.
 */
const UPLOAD_MAX_TOTAL_BYTES = config.UPLOAD_MAX_TOTAL_MB * 1024 * 1024;

const notMultipart = () => new AppError('UNSUPPORTED_MEDIA_TYPE', 415, 'Uploads must be sent as multipart/form-data');
const UPLOAD_QUEUE_MAX = 50;
let uploadsActive = 0;
const uploadQueue: (() => void)[] = [];

export const uploadGuard: RequestHandler = (req, res, next) => {
  if (chunkedOf(res)) return next(); // already assembled from chunks (chunkedUploads)
  if (!req.is('multipart/form-data')) return next(notMultipart());
  const length = Number(req.headers['content-length']);
  if (!req.headers['content-length'] || !Number.isFinite(length)) {
    return next(new AppError('LENGTH_REQUIRED', 411, 'Uploads must state their size (Content-Length)'));
  }
  if (length > UPLOAD_MAX_TOTAL_BYTES) {
    return next(
      new AppError(
        'PAYLOAD_TOO_LARGE',
        413,
        `Uploads are limited to ${config.UPLOAD_MAX_TOTAL_MB} MB in total per request`,
      ),
    );
  }
  if (uploadQueue.length >= UPLOAD_QUEUE_MAX)
    return next(new AppError('UPLOADS_BUSY', 503, 'Too many uploads in progress; try again in a moment'));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    uploadsActive--;
    uploadQueue.shift()?.();
  };
  const start = () => {
    // The client gave up while waiting: pass the slot on. Its socket says so; `req.destroyed` does not, since the
    // request stream is also destroyed once a body parser has read it to the end (QA-005: that request was never answered).
    if (req.socket.destroyed) return void uploadQueue.shift()?.();
    uploadsActive++;
    res.once('finish', release);
    res.once('close', release);
    next();
  };
  if (uploadsActive < config.UPLOAD_CONCURRENCY) start();
  else uploadQueue.push(start);
};

// Any file type is accepted, like Gmail attachments. Files are stored under opaque keys, downloads are forced
// to `attachment` with nosniff, and only script-free types are served inline (see previewMimeType).
// Types text extraction can't read are kept and marked UNSUPPORTED. Size and count limits come from Settings → Limits.
const multipartFiles = limitedUpload('files', () => ({
  maxFileMb: limits().uploadMaxFileMb,
  maxFiles: limits().uploadMaxFiles,
}));
export const uploadFiles: RequestHandler = (req, res, next) =>
  chunkedOf(res) ? next() : multipartFiles(req, res, next);

/** An upload as the services take it: a temporary file on disk, streamed to Drive (never loaded whole). */
interface UploadedAttachment {
  filename: string;
  mimeType: string;
  data: { path: string; size: number };
}

const chunkedOf = (res: Response | undefined): UploadedAttachment[] | undefined =>
  res?.locals.chunkedUploads as UploadedAttachment[] | undefined;

/** The request's uploads as attachments: multipart files, or the chunked uploads it named (chunkedUploads). */
export const uploadedAttachments = (req: Request): UploadedAttachment[] =>
  chunkedOf(req.res) ??
  uploadedFiles(req).map((f) => ({
    filename: f.originalname,
    mimeType: f.mimetype,
    data: { path: f.path, size: f.size },
  }));

const UploadIdsBody = z.object({ uploadIds: z.array(z.uuid()) });

/**
 * RUNTIME=netlify: an upload route may take JSON `{ ...fields, uploadIds }` naming chunked uploads (modules/uploads)
 * instead of multipart. Each must be the user's own (403) and complete (409 UPLOAD_INCOMPLETE: nothing is stored, the
 * chunks are kept for a retry); the same file count and total size limits apply. They are assembled into temporary
 * files that the route then uses exactly like multer's, deleted when the response ends; once the route has succeeded
 * the chunks are deleted too. Put before uploadGuard; any other request passes through untouched.
 */
export function chunkedUploads({ chunks }: Pick<AppDeps, 'chunks'>): RequestHandler {
  return (req, res, next) => {
    if (!isNetlifyRuntime() || !req.is('application/json')) return next();
    void (async () => {
      const { uploadIds } = parseBody(UploadIdsBody, req.body);
      const maxFiles = limits().uploadMaxFiles;
      if (uploadIds.length > maxFiles)
        throw new AppError(
          'TOO_MANY_FILES',
          400,
          `At most ${maxFiles} ${maxFiles === 1 ? 'file' : 'files'} per upload`,
          {
            limit: maxFiles,
          },
        );
      const userId = currentUser(req).id;
      const metas = [];
      for (const id of uploadIds) metas.push(await ownUpload(chunks, id, userId));
      if (metas.reduce((n, m) => n + m.size, 0) > UPLOAD_MAX_TOTAL_BYTES)
        throw new AppError(
          'PAYLOAD_TOO_LARGE',
          413,
          `Uploads are limited to ${config.UPLOAD_MAX_TOTAL_MB} MB in total per request`,
        );

      const files: string[] = [];
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        void Promise.all(files.map((f) => rm(f, { force: true }))).catch(() => undefined);
        if (res.writableFinished && res.statusCode < 400)
          for (const id of uploadIds)
            void chunks.remove(id).catch((err: unknown) => logger.warn({ err, uploadId: id }, 'chunk cleanup failed'));
      };
      res.once('finish', cleanup);
      res.once('close', cleanup);

      await mkdir(UPLOAD_TMP_DIR, { recursive: true });
      const attachments: UploadedAttachment[] = [];
      for (const [i, id] of uploadIds.entries()) {
        const meta = metas[i]!;
        const dest = path.join(UPLOAD_TMP_DIR, randomUUID());
        files.push(dest);
        try {
          await chunks.assemble(id, dest);
        } catch (err) {
          if (err instanceof ChunkMissingError)
            throw new AppError('UPLOAD_INCOMPLETE', 409, `${meta.filename} was not fully uploaded; send it again`);
          throw err;
        }
        attachments.push({ filename: meta.filename, mimeType: meta.mimeType, data: { path: dest, size: meta.size } });
      }
      res.locals.chunkedUploads = attachments;
      next();
    })().catch(next);
  };
}

/** Files are stored before anything is recorded, so a storage failure leaves nothing behind: say so. */
export function storageUnavailable(err: unknown): never {
  if (err instanceof StorageError) {
    throw new AppError(
      'STORAGE_UNAVAILABLE',
      502,
      "Couldn't save the files to Google Drive. Nothing was saved; please try again.",
    );
  }
  throw err;
}
