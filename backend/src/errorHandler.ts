import Anthropic from '@anthropic-ai/sdk';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

import { FAILURE_MESSAGES } from './constants.js';
import { AppError } from './http.js';
import { logger } from './logger.js';
import { recordSystemError } from './services/audit.js';
import { describeError } from './services/friendlyError.js';
import { StorageError } from './services/storage.js';

// Kept out of http.ts: friendlyError.ts reaches modules whose classes extend AppError, so importing it there is a cycle.

/**
 * Every API failure as `{ error: { code, message, details?, requestId } }`, the message in plain words (what happened +
 * what to do). `requestId` matches the X-Request-Id header and the log lines of this request.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    // The response already started (a stream, SSE, a download): a JSON body cannot follow. Express's default handler
    // closes the connection, so the client sees a failed transfer instead of a truncated success.
    logger.error({ err, path: req.path }, 'error after the response started');
    next(err);
    return;
  }
  const requestId = req.id as string | undefined;
  const send = (status: number, error: { code: string; message: string; details?: unknown }) => {
    res.status(status).json({ error: { ...error, requestId } });
  };
  if (err instanceof AppError) {
    send(err.status, { code: err.code, message: err.message, details: err.details });
    return;
  }
  const clientError = mapClientError(err);
  if (clientError) {
    // The client's fault (malformed JSON, too large, bad upload): a 4xx in the usual shape, logged as a warning.
    logger.warn(
      {
        err: {
          message: (err as Error).message,
          type: (err as { type?: string }).type,
          code: (err as { code?: string }).code,
        },
        path: req.path,
        status: clientError.status,
      },
      'client request rejected',
    );
    send(clientError.status, { code: clientError.code, message: clientError.message, details: clientError.details });
    return;
  }
  if (isPgUniqueViolation(err)) {
    // Two requests raced for the same row (a version number, a unique name): the caller can retry or reload.
    logger.warn({ path: req.path, constraint: (err as { constraint?: string }).constraint }, 'unique violation');
    send(409, { code: 'CONFLICT', message: FAILURE_MESSAGES.conflict });
    return;
  }
  if (isDbBusy(err)) {
    // DB-10: no pool connection within DB_CONNECTION_TIMEOUT_MS, or a row lock not granted within DB_LOCK_TIMEOUT_MS.
    // Overload, not a bug: 503 with Retry-After, logged as a warning (not a system error) so a burst does not flood it.
    logger.warn({ err, path: req.path }, 'database busy');
    res.setHeader('Retry-After', '5');
    send(503, { code: 'DB_BUSY', message: 'The server is busy right now. Wait a moment, then retry.' });
    return;
  }
  if (err instanceof StorageError) {
    // Attachment bytes missing or Drive unreachable: a clear JSON error instead of a 500 (e.g. text extraction).
    logger.warn({ err, path: req.path }, 'attachment storage error');
    if (err.kind === 'NOT_FOUND') {
      send(404, { code: 'FILE_MISSING', message: FAILURE_MESSAGES.fileMissing });
    } else {
      send(502, { code: 'STORAGE_UNAVAILABLE', message: FAILURE_MESSAGES.storageDown });
    }
    return;
  }
  if (err instanceof Anthropic.APIError) {
    // Surface upstream LLM failures (bad key, rate limit, overload) in plain words instead of a generic 500.
    logger.error({ err, path: req.path }, 'claude api error');
    void recordSystemError(`api:${req.method} ${req.path}`, err);
    send(err instanceof Anthropic.RateLimitError ? 429 : 502, {
      code: 'LLM_ERROR',
      message: describeError(err).message,
    });
    return;
  }
  // The raw error goes to Monitoring → Errors, which the message points admins to.
  logger.error({ err, path: req.path }, 'unhandled error');
  void recordSystemError(`api:${req.method} ${req.path}`, err);
  send(500, { code: 'INTERNAL', message: FAILURE_MESSAGES.internal });
}

/**
 * The database is saturated rather than broken: pg-pool gave up waiting for a free connection (connectionTimeoutMillis)
 * or a new connection did not open in time, or Postgres refused a lock within lock_timeout (SQLSTATE 55P03).
 */
export function isDbBusy(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code === '55P03') return true;
  const message = (err as { message?: unknown }).message;
  return (
    message === 'timeout exceeded when trying to connect' ||
    message === 'Connection terminated due to connection timeout'
  );
}

/** A PostgreSQL unique_violation (SQLSTATE 23505). */
export function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/** Errors express.json (body-parser) and multer raise for a bad request, as the API's 4xx; null for anything else. */
function mapClientError(err: unknown): AppError | null {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return new AppError('PAYLOAD_TOO_LARGE', 413, 'File too large');
    const details = err.field ? { field: err.field } : undefined;
    if (err.code === 'LIMIT_FILE_COUNT')
      return new AppError('TOO_MANY_FILES', 400, 'Too many files in one upload', details);
    if (err.code === 'LIMIT_UNEXPECTED_FILE')
      return new AppError(
        'UNEXPECTED_FILE_FIELD',
        400,
        `Unexpected file field${err.field ? ` "${err.field}"` : ''}; send files as "files"`,
        details,
      );
    // multer's own wording names its internals; the reason code says which limit (it is logged with the raw message).
    return new AppError('INVALID_UPLOAD', 400, 'The upload was rejected', { reason: err.code, ...details });
  }
  const { status, type } = err as { status?: unknown; type?: unknown };
  if (type === 'entity.parse.failed') return new AppError('INVALID_JSON', 400, 'The request body is not valid JSON');
  if (status === 413 || type === 'entity.too.large')
    return new AppError('PAYLOAD_TOO_LARGE', 413, 'Request body too large');
  // Other body-parser failures (unsupported charset or encoding, aborted request) carry their own 4xx status. Their
  // message is logged by the caller, not sent: it can echo request content.
  if (typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500) {
    return new AppError('BAD_REQUEST', status, 'The request body could not be read', { reason: type });
  }
  return null;
}
