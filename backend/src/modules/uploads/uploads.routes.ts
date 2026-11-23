import express, { Router } from 'express';
import { z } from 'zod';

import { config } from '../../config.js';
import { UPLOAD_CHUNK_BYTES } from '../../constants.js';
import type { AppDeps } from '../../deps.js';
import { AppError, currentUser, parseBody, requirePermission, uuidParam } from '../../http.js';
import { limits } from '../../services/limitsSettings.js';
import type { ChunkStore, UploadMeta } from './chunkStore.js';

const MIB = 1024 * 1024;

const CreateUploadBody = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !v.includes('\u0000'), 'File names must not contain NUL (\\0) characters'),
  mimeType: z.string().max(255).default('application/octet-stream'),
  size: z.number().int().min(0),
});

/** The largest file one upload may declare: the per-file limit (Settings → Limits), never above the request total. */
export const maxUploadFileBytes = () => Math.min(config.UPLOAD_MAX_TOTAL_MB, limits().uploadMaxFileMb) * MIB;

/** Bytes chunk `index` of `meta` must have: full chunks, then whatever is left in the last one. */
const expectedChunkBytes = (meta: UploadMeta, index: number) =>
  index < meta.chunkCount - 1 ? UPLOAD_CHUNK_BYTES : meta.size - (meta.chunkCount - 1) * UPLOAD_CHUNK_BYTES;

/** The upload, if it exists and belongs to the signed-in user (403 for anyone else's). */
export async function ownUpload(store: ChunkStore, id: string, userId: string): Promise<UploadMeta> {
  const meta = await store.meta(id);
  if (!meta) throw new AppError('NOT_FOUND', 404, 'Upload not found');
  if (meta.userId !== userId) throw new AppError('FORBIDDEN', 403, 'This upload belongs to another user');
  return meta;
}

/**
 * Chunked uploads (RUNTIME=netlify, whose functions take at most 6 MB per request): POST /uploads declares a file and
 * gets its chunk size and count; each PUT /uploads/:id/chunks/:index sends one chunk as raw bytes. The upload is then
 * named by id in a submission or document upload (`{ uploadIds }`), which assembles it (modules/shared/uploads.ts).
 * Mounted behind requireAuth, on the Netlify runtime only (app.ts).
 */
export function uploadsRouter({ chunks }: Pick<AppDeps, 'chunks'>): Router {
  const router = Router();

  router.post('/uploads', requirePermission('submission:write'), async (req, res) => {
    const body = parseBody(CreateUploadBody, req.body);
    const max = maxUploadFileBytes();
    if (body.size > max)
      throw new AppError('PAYLOAD_TOO_LARGE', 413, `Each file can be at most ${max / MIB} MB`, { limitMb: max / MIB });
    const chunkCount = Math.max(1, Math.ceil(body.size / UPLOAD_CHUNK_BYTES));
    const uploadId = await chunks.create({
      userId: currentUser(req).id,
      filename: body.filename,
      mimeType: body.mimeType,
      size: body.size,
      chunkCount,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json({ uploadId, chunkBytes: UPLOAD_CHUNK_BYTES, chunkCount });
  });

  router.put(
    '/uploads/:id/chunks/:index',
    requirePermission('submission:write'),
    (req, _res, next) => {
      // Refused before a byte is read when the size is stated; express.raw's limit catches the rest.
      if (Number(req.headers['content-length']) > UPLOAD_CHUNK_BYTES)
        return next(new AppError('PAYLOAD_TOO_LARGE', 413, `A chunk can be at most ${UPLOAD_CHUNK_BYTES} bytes`));
      if (!req.is('application/octet-stream'))
        return next(new AppError('UNSUPPORTED_MEDIA_TYPE', 415, 'Chunks must be sent as application/octet-stream'));
      next();
    },
    express.raw({ type: 'application/octet-stream', limit: UPLOAD_CHUNK_BYTES }),
    async (req, res) => {
      const id = uuidParam(req.params.id, 'Upload');
      const index = Number(req.params.index);
      const meta = await ownUpload(chunks, id, currentUser(req).id);
      if (!Number.isInteger(index) || index < 0 || index >= meta.chunkCount)
        throw new AppError('INVALID_CHUNK', 400, `Chunk index must be 0 to ${meta.chunkCount - 1}`);
      const bytes: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const expected = expectedChunkBytes(meta, index);
      if (bytes.length !== expected)
        throw new AppError('INVALID_CHUNK', 400, `Chunk ${index} must be ${expected} bytes; got ${bytes.length}`);
      await chunks.put(id, index, bytes);
      res.status(204).end();
    },
  );

  return router;
}
