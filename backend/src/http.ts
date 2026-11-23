import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { z } from 'zod';

import { config } from './config.js';
import { AUTH_CACHE_MS, FAILURE_MESSAGES } from './constants.js';
import { pool } from './db/pool.js';
import { logger } from './logger.js';
import { hasPermission, type Permission, type Role, ROLES } from './permissions.js';

export { type Role, ROLES } from './permissions.js';
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Token expiry (seconds since epoch), set by requireAuth; e.g. SSE streams close at this time. */
  exp?: number;
  /** How the request authenticated, set by requireAuth. */
  via?: 'cookie' | 'bearer';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** The login token's version (`tv`), set by authenticate; stillAuthorized re-checks it. */
      authTokenVersion?: number;
    }
  }
}

/**
 * An error the API answers with as `{ error: { code, message, details?, requestId } }` (errorHandler.ts). `code` is the
 * stable machine-readable name, `status` the HTTP status, `message` plain words for the user.
 */
export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', 404, `${what} not found`);

// ---- authentication ----
//
// Browsers authenticate with an httpOnly session cookie (AUTH_COOKIE, SameSite=Strict); scripts and the CLI send
// `Authorization: Bearer <token>`. Both carry the same login JWT. CSRF: SameSite=Strict keeps the cookie off
// cross-site requests, and a cookie-authenticated unsafe request must also carry `X-Requested-With: fetch`, a header
// a cross-site form or simple request cannot set (a preflighted one is refused by CORS). Bearer requests need no
// check: browsers never attach that header on their own.

export const AUTH_COOKIE = 'ims_session';
export const CSRF_HEADER = 'x-requested-with';
const TOKEN_ISSUER = 'ims-submission-review';
const TOKEN_AUDIENCE = 'ims-api';
const TOKEN_TYPE = 'access';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AccessClaims {
  sub: string;
  email: string;
  name: string;
  role: Role;
  tv: number;
  exp: number;
}

export function signToken(user: AuthUser, tokenVersion = 0): string {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role, tv: tokenVersion, typ: TOKEN_TYPE },
    config.JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    },
  );
}

/** Verify a login token: signature (HS256 only), issuer, audience, type and claims. Throws on anything else. */
export function verifyAccessToken(token: string): AccessClaims {
  const p = jwt.verify(token, config.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  });
  if (typeof p !== 'object' || p === null) throw new Error('Malformed token');
  const { sub, email, name, role, tv, typ, exp } = p as jwt.JwtPayload;
  if (
    typ !== TOKEN_TYPE ||
    typeof sub !== 'string' ||
    !ROLES.includes(role) ||
    !Number.isInteger(tv) ||
    typeof exp !== 'number'
  ) {
    throw new Error('Not a login token');
  }
  return { sub, email: String(email ?? ''), name: String(name ?? ''), role, tv, exp };
}

/** One cookie from the Cookie header (no cookie-parser). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** Set the session cookie for a freshly signed token; it expires with the token. */
export function setAuthCookie(res: Response, token: string): void {
  const exp = (jwt.decode(token) as jwt.JwtPayload | null)?.exp;
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    ...(exp ? { maxAge: Math.max(0, exp * 1000 - Date.now()) } : {}),
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
}

// Account state behind each token, cached briefly so every request is not a query. Changes made in this process
// call invalidateUserAuth; another process sees them within AUTH_CACHE_MS.
interface AuthRow {
  email: string;
  name: string;
  role: Role;
  tokenVersion: number;
  disabled: boolean;
}
const authCache = new Map<string, { at: number; row: AuthRow | null }>();

export function invalidateUserAuth(userId?: string): void {
  if (userId) authCache.delete(userId);
  else authCache.clear();
}

async function loadAuthRow(userId: string): Promise<AuthRow | null> {
  const hit = authCache.get(userId);
  if (hit && Date.now() - hit.at < AUTH_CACHE_MS) return hit.row;
  const {
    rows: [u],
  } = await pool.query('SELECT email, name, role, token_version, disabled_at FROM users WHERE id=$1', [userId]);
  const row: AuthRow | null = u
    ? { email: u.email, name: u.name, role: u.role, tokenVersion: u.token_version, disabled: u.disabled_at !== null }
    : null;
  if (authCache.size > 10_000) authCache.clear();
  authCache.set(userId, { at: Date.now(), row });
  return row;
}

const unauthenticated = (message: string) => new AppError('UNAUTHENTICATED', 401, message);

/** Authenticate a request from its bearer token or session cookie. Throws AppError 401 (or 403 for a missing CSRF header). */
export async function authenticate(req: Request): Promise<AuthUser> {
  const header = req.headers.authorization;
  let token: string | null = null;
  let via: AuthUser['via'] = 'bearer';
  if (header?.startsWith('Bearer ')) token = header.slice(7).trim();
  else {
    token = readCookie(req.headers.cookie, AUTH_COOKIE);
    via = 'cookie';
  }
  if (!token) throw unauthenticated('Not signed in');
  let claims: AccessClaims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    throw unauthenticated('Invalid or expired token');
  }
  if (via === 'cookie' && UNSAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== 'fetch') {
    throw new AppError('CSRF_HEADER_REQUIRED', 403, 'Missing X-Requested-With header');
  }
  const row = await checkAccount(claims.sub, claims.tv);
  req.authTokenVersion = claims.tv;
  return { id: claims.sub, email: row.email, name: row.name, role: row.role, exp: claims.exp, via };
}

/** The account behind a token must still exist, be enabled and carry the token's version. Throws AppError 401. */
async function checkAccount(userId: string, tokenVersion: number): Promise<AuthRow> {
  const row = await loadAuthRow(userId);
  if (!row) throw unauthenticated('User no longer exists');
  if (row.disabled) throw unauthenticated('This account is disabled');
  if (row.tokenVersion !== tokenVersion) throw unauthenticated('Session was revoked; sign in again');
  return row;
}

/**
 * Re-check an authenticated request's account, for long-lived responses (SSE): false once the user is gone, disabled,
 * signed out everywhere (token version) or has another role than when the request began. Uses the auth cache, so a
 * change made on another instance is seen within AUTH_CACHE_MS.
 */
export async function stillAuthorized(req: Request): Promise<boolean> {
  const user = req.user;
  if (!user || req.authTokenVersion === undefined) return false;
  try {
    const row = await checkAccount(user.id, req.authTokenVersion);
    return row.role === user.role;
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  // Mounted ahead of several routers; authenticate once per request.
  if (req.user) return next();
  authenticate(req).then((user) => {
    req.user = user;
    next();
  }, next);
};

/** 403 unless the signed-in user's role grants `permission` (permissions.ts); routes never check role names. */
export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission))
      return next(new AppError('FORBIDDEN', 403, FAILURE_MESSAGES.forbidden));
    next();
  };

/** The signed-in user of a request behind requireAuth; 401 if there is none (a route mounted without requireAuth). */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 401, 'Not signed in');
  return req.user;
}

/** Whether the request's user may do `permission`, for checks inside a handler. */
export const can = (req: Request, permission: Permission): boolean => hasPermission(req.user?.role, permission);

/** Whether any string in `value` (deeply) holds a NUL character, which PostgreSQL text columns cannot store. */
export function containsNul(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (!value || typeof value !== 'object' || depth > 20) return false;
  return Object.entries(value).some(([k, v]) => k.includes('\u0000') || containsNul(v, depth + 1));
}

/** A request body validated by `schema`. A NUL character anywhere is a 400, never a database error (500). */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  if (containsNul(body)) throw new AppError('VALIDATION_ERROR', 400, 'Text must not contain NUL (\\0) characters');
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError('VALIDATION_ERROR', 400, FAILURE_MESSAGES.invalidBody, z.flattenError(r.error));
  return r.data;
}

export const uuidParam = (value: string | string[] | undefined, what = 'Resource'): string => {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !z.uuid().safeParse(v).success) throw notFound(what);
  return v;
};

/** Where browser uploads are written while a request is handled; each file is deleted when its request ends. */
export const UPLOAD_TMP_DIR = path.join(tmpdir(), 'submission-review-uploads');

/**
 * Multer upload of the `field` file(s) whose limits are read on each request (Settings → Limits), so a change applies
 * without a restart. A file over the size limit, or more files than allowed, is a 4xx naming the limit.
 *
 * `storage: 'disk'` (the default) streams each file to a temporary file (`file.path`), so a 100 MB upload never sits in
 * memory; the handler passes `{ path, size }` on and calls `removeUploadedFiles(req)` when done. `'memory'` gives
 * `file.buffer`, for small files the handler parses at once (rate workbooks).
 */
export function limitedUpload(
  field: string,
  current: () => { maxFileMb: number; maxFiles: number },
  mode: 'single' | 'array' = 'array',
  storage: 'disk' | 'memory' = 'disk',
): RequestHandler {
  return (req, res, next) => {
    const { maxFileMb, maxFiles } = current();
    const upload = multer({
      storage: storage === 'disk' ? multer.diskStorage({ destination: UPLOAD_TMP_DIR }) : multer.memoryStorage(),
      limits: { fileSize: maxFileMb * 1024 * 1024, files: maxFiles },
    });
    // Temporary files go once the response is sent, whatever the handler did (a 404 before using them included).
    if (storage === 'disk') res.once('finish', () => void removeUploadedFiles(req));
    (mode === 'single' ? upload.single(field) : upload.array(field))(req, res, (err?: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(
          new AppError('PAYLOAD_TOO_LARGE', 413, `Each file can be at most ${maxFileMb} MB`, {
            limitMb: maxFileMb,
            field: err.field,
          }),
        );
      }
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_COUNT') {
        return next(
          new AppError('TOO_MANY_FILES', 400, `At most ${maxFiles} ${maxFiles === 1 ? 'file' : 'files'} per upload`, {
            limit: maxFiles,
            field: err.field,
          }),
        );
      }
      // A body the multipart parser (busboy) cannot read, such as a part header broken by a NUL in a file name, is the
      // client's error. Its errors carry no `code`; a failure writing the temporary file (ENOSPC…) does, and stays a 500.
      if (err instanceof Error && !(err instanceof multer.MulterError) && !(err as { code?: unknown }).code) {
        // busboy's message can quote part headers (file names): logged, not sent.
        logger.warn({ err, path: req.path }, 'unreadable multipart upload');
        return next(new AppError('INVALID_UPLOAD', 400, 'The upload could not be read. Send the files again.'));
      }
      // A NUL in a file name ("evil.exe\0.txt") is a truncation trick and cannot be stored: refused, not a 500.
      if (!err && uploadedFiles(req).some((f) => f.originalname.includes('\u0000'))) {
        return next(new AppError('INVALID_FILENAME', 400, 'File names must not contain NUL (\\0) characters'));
      }
      next(err);
    });
  };
}

/** The request's uploaded files (multer `req.files`/`req.file`). */
export function uploadedFiles(req: Request): Express.Multer.File[] {
  if (Array.isArray(req.files)) return req.files;
  if (req.files) return Object.values(req.files).flat();
  return req.file ? [req.file] : [];
}

/** Delete the request's temporary upload files (disk storage); never throws. */
export async function removeUploadedFiles(req: Request): Promise<void> {
  await Promise.all(
    uploadedFiles(req).map((f) => (f.path ? rm(f.path, { force: true }).catch(() => undefined) : undefined)),
  );
}

/** Submission rows as answered: a summary or detail, a page of them ({ items }), or a list, without the raw error. */
function withoutErrorDetail(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(withoutErrorDetail);
  if (!body || typeof body !== 'object') return body;
  const o = body as Record<string, unknown>;
  if (Array.isArray(o.items)) return { ...o, items: o.items.map(withoutErrorDetail) };
  return 'processingErrorDetail' in o ? { ...o, processingErrorDetail: null } : o;
}

/**
 * The raw processing error (provider messages, stack-like text) is for users allowed to see it; everyone else gets
 * the plain-words processingError. Routers answering with submissions apply it to every response, so no route forgets.
 */
export const hideErrorDetail: RequestHandler = (req, res, next) => {
  if (can(req, 'submission:view-error-detail')) return next();
  const json = res.json.bind(res);
  res.json = (body: unknown) => json(withoutErrorDetail(body));
  next();
};
