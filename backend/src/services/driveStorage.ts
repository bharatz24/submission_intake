import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { type drive_v3, google } from 'googleapis';

import { config } from '../config.js';
import { DRIVE_CHUNK_BYTES, DRIVE_RESUMABLE_ABOVE_BYTES, DRIVE_RETRY_BASE_MS } from '../constants.js';
import { logger } from '../logger.js';
import { recordSystemError } from './audit.js';
import { byteLength, type FileBytes, readRange, streamBytes } from './fileBytes.js';
import { limits } from './limitsSettings.js';

/**
 * Google Drive storage for attachment bytes: the only module that talks to the Drive API.
 * Drive is used as one Google account (OAuth refresh token), so files are owned by that account and use its storage.
 * They go under the folder named GDRIVE_ROOT_FOLDER_NAME (at the top of My Drive or a Shared Drive), laid out as
 * <root>/<YYYY-MM>/<YYYY-MM-DD · label · id8>/<filename>, and every file and folder carries `appProperties`
 * ({ app, root, submissionId, documentId, sha256 }) so uploads are idempotent and orphans can be found.
 */

// `drive.file` only reaches files the app created, so it cannot write into a folder a person created.
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const APP_TAG = 'submission-review';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,size,sha256Checksum';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** NOT_FOUND: the file is gone. UNAVAILABLE: transient, retry later. CONFIG: credentials, folder or quota problem. */
export type StorageErrorKind = 'NOT_FOUND' | 'UNAVAILABLE' | 'CONFIG';

export class StorageError extends Error {
  constructor(
    public kind: StorageErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StorageError';
  }
}

export interface DriveUpload {
  submissionId: string;
  documentId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  /** In memory, or a temporary file on disk (a browser upload), read in chunks and never loaded whole. */
  data: FileBytes;
}

interface DriveFile {
  id?: string | null;
  size?: string | null;
  sha256Checksum?: string | null;
}

let clients: { drive: drive_v3.Drive; auth: InstanceType<typeof google.auth.OAuth2>; timeoutMs: number } | null = null;

/** Per-request timeout (Settings → Limits); without one a hung request would stall the Gmail queue drain or an upload. */
const requestTimeoutMs = () => limits().driveTimeoutSeconds * 1000;

/**
 * OAuth client for the Drive account; access tokens are refreshed automatically from the refresh token. The Drive
 * API object carries the timeout, so it is rebuilt (same OAuth client) when the setting changes.
 */
function client() {
  const timeoutMs = requestTimeoutMs();
  if (clients && clients.timeoutMs !== timeoutMs) {
    clients = { ...clients, timeoutMs, drive: google.drive({ version: 'v3', auth: clients.auth, timeout: timeoutMs }) };
  }
  if (!clients) {
    const auth = new google.auth.OAuth2({
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      endpoints: { oauth2TokenUrl: config.GOOGLE_TOKEN_URI },
    });
    auth.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN, scope: SCOPES.join(' ') });
    clients = { auth, timeoutMs, drive: google.drive({ version: 'v3', auth, timeout: timeoutMs }) };
  }
  return clients;
}

/** files.list scope: the Shared Drive when configured, otherwise the account's own Drive. */
function listScope() {
  const base = { supportsAllDrives: true, includeItemsFromAllDrives: true };
  return config.GDRIVE_SHARED_DRIVE_ID
    ? { ...base, corpora: 'drive', driveId: config.GDRIVE_SHARED_DRIVE_ID }
    : { ...base, corpora: 'user' };
}

/** Quote a value for a Drive `q` expression. Only app-generated values (UUIDs, dates, configured IDs and names) are ever passed. */
function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function assertUuid(id: string): string {
  if (!UUID.test(id)) throw new Error(`Not a UUID: ${id}`);
  return id;
}

/** files.list in the configured scope; without the all-drives flags Shared Drive items are invisible. */
async function findOne(query: string, fields = 'id', orderBy?: string): Promise<DriveFile | null> {
  const { drive } = client();
  let pageToken: string | undefined;
  do {
    // Drive can answer with an empty page and a token, which does not mean there is no match.
    const res = await drive.files.list({
      q: `${query} and trashed=false`,
      fields: `nextPageToken, files(${fields})`,
      pageSize: 2,
      orderBy,
      pageToken,
      ...listScope(),
    });
    const first = res.data.files?.[0];
    if (first) return first;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return null;
}

/**
 * Tags on everything this app creates. `root` ties a file to this server's root folder, so the orphan sweep of one
 * environment never touches files stored under another environment's folder with the same Google account.
 */
function appTags(root: string, extra: Record<string, string>): Record<string, string> {
  return { app: APP_TAG, root, ...extra };
}

async function createFolder(name: string, parent: string, appProperties: Record<string, string>): Promise<string> {
  const { drive } = client();
  const res = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parent], appProperties },
    fields: 'id',
    supportsAllDrives: true,
  });
  return res.data.id!;
}

/** Where the root folder lives: the top of the Shared Drive when configured, otherwise the top of My Drive. */
const rootParent = () => config.GDRIVE_SHARED_DRIVE_ID || 'root';

const ROOT_TAGS = { app: APP_TAG, role: 'root' };

/**
 * The oldest root folder of this app with the configured name, so every server that sees more than one uses the same one.
 * The tags keep attachments out of a folder that merely has the same name, which could be shared with anyone.
 */
async function findRootFolder(): Promise<string | null> {
  const tagged = Object.entries(ROOT_TAGS).map(
    ([key, value]) => `appProperties has { key=${q(key)} and value=${q(value)} }`,
  );
  const named = `name=${q(config.GDRIVE_ROOT_FOLDER_NAME)} and mimeType=${q(FOLDER_MIME)} and ${q(rootParent())} in parents`;
  const found = await findOne([named, ...tagged].join(' and '), 'id', 'createdTime');
  return found?.id ?? null;
}

async function createRootFolder(): Promise<string> {
  const created = await createFolder(config.GDRIVE_ROOT_FOLDER_NAME, rootParent(), ROOT_TAGS);
  // Another server may have created one at the same time: the oldest wins, and the new one is still empty.
  const oldest = await findRootFolder();
  if (oldest && oldest !== created) {
    await trashDriveFile(created);
    return oldest;
  }
  // Expected on a first run. Otherwise the previous folder was renamed or moved, and storage has just split in two.
  const message = `Created Google Drive folder "${config.GDRIVE_ROOT_FOLDER_NAME}" (${created}). If files were stored before, the previous folder was renamed, moved or not created by this app: see the README.`;
  logger.warn({ folderId: created }, message);
  await recordSystemError('drive:root-folder', message);
  return created;
}

let cachedRoot: Promise<string> | null = null;

/** The root folder's ID, found or created once and shared by concurrent callers. A failed lookup is retried next time. */
function rootFolder(): Promise<string> {
  if (!cachedRoot) {
    const p: Promise<string> = findRootFolder().then((found) => found ?? createRootFolder());
    p.catch(() => {
      if (cachedRoot === p) cachedRoot = null;
    });
    cachedRoot = p;
  }
  return cachedRoot;
}

/** The folder as Drive reports it, or null if it is trashed, deleted or no longer accessible (Drive answers 404 for both). */
async function liveFolder(fileId: string): Promise<drive_v3.Schema$File | null> {
  try {
    const res = await client().drive.files.get({
      fileId,
      fields: 'id,trashed,capabilities(canAddChildren)',
      supportsAllDrives: true,
    });
    return res.data.trashed ? null : res.data;
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

/**
 * The root folder, checked against Drive. A cached ID can go stale, and creating inside a trashed folder does not fail,
 * so without this check files would land in the trash. A lost root is replaced by the folder with the configured name
 * (a new one if there is none) and reported on Monitoring, because the old files stay behind in the trash or elsewhere.
 */
async function liveRootFolder(): Promise<drive_v3.Schema$File> {
  const cached = rootFolder();
  const id = await cached;
  const root = await liveFolder(id);
  if (root) return root;
  // Only the first caller to notice drops the cache, so concurrent callers share one replacement.
  if (cachedRoot === cached) {
    cachedRoot = null;
    const message = `Google Drive folder "${config.GDRIVE_ROOT_FOLDER_NAME}" (${id}) was trashed, deleted or can no longer be reached: new files go to a replacement. Restore the old folder if it holds files.`;
    logger.error({ folderId: id }, message);
    await recordSystemError('drive:root-folder', message);
  }
  const replacement = await liveFolder(await rootFolder());
  // The search can still return a folder trashed moments ago: fail so the caller retries, rather than write to the trash.
  if (!replacement) throw new StorageError('UNAVAILABLE', 'The Google Drive root folder is not available yet');
  return replacement;
}

// Month folders are shared by every submission, so lookups are cached and concurrent creates are collapsed.
const monthFolders = new Map<string, Promise<string>>();
const monthKey = (root: string, month: string) => `${root}/${month}`;

function monthFolder(root: string, month: string): Promise<string> {
  const key = monthKey(root, month);
  const cached = monthFolders.get(key);
  if (cached) return cached;
  const p = (async () => {
    const found = await findOne(`name=${q(month)} and mimeType=${q(FOLDER_MIME)} and ${q(root)} in parents`);
    return found?.id ?? createFolder(month, root, appTags(root, { month }));
  })();
  p.catch(() => {
    if (monthFolders.get(key) === p) monthFolders.delete(key);
  });
  monthFolders.set(key, p);
  return p;
}

/**
 * The month folder and its root, with one Drive check on the usual path: a folder inside a trashed root reports itself
 * as trashed. Only when the month folder is not usable is the root checked too, and the month folder found again.
 */
async function liveMonthFolder(month: string): Promise<{ root: string; id: string }> {
  const root = await rootFolder();
  const cached = monthFolder(root, month);
  // Creating a month folder in a deleted root answers 404.
  const id = await cached.catch((err) => {
    if (statusOf(err) === 404) return null;
    throw err;
  });
  if (id && (await liveFolder(id))) return { root, id };
  if (monthFolders.get(monthKey(root, month)) === cached) monthFolders.delete(monthKey(root, month));

  const liveRoot = (await liveRootFolder()).id!;
  const replacement = await monthFolder(liveRoot, month);
  if (await liveFolder(replacement)) return { root: liveRoot, id: replacement };
  // The search can still return a folder trashed moments ago: fail so the caller retries, rather than write to the trash.
  monthFolders.delete(monthKey(liveRoot, month));
  throw new StorageError('UNAVAILABLE', 'The Google Drive month folder is not available yet');
}

/** Drive names are not paths: any readable name is safe. Control characters are dropped and the length capped. */
function folderLabel(label: string): string {
  return (
    label
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'Submission'
  );
}

/** Find (by appProperties.submissionId) or create the submission's folder under its month folder. */
export async function ensureSubmissionFolder(submissionId: string, label: string, receivedAt: Date): Promise<string> {
  try {
    const found = await findOne(
      `mimeType=${q(FOLDER_MIME)} and appProperties has { key='submissionId' and value=${q(assertUuid(submissionId))} }`,
    );
    if (found?.id) return found.id;
    const day = receivedAt.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const { root, id: parent } = await liveMonthFolder(month);
    // The label comes from email content: it is only ever set as `name`, never put into a query.
    return await createFolder(
      `${day} · ${folderLabel(label)} · ${submissionId.slice(0, 8)}`,
      parent,
      appTags(root, { submissionId }),
    );
  } catch (err) {
    throw toStorageError(err);
  }
}

/**
 * Upload one file and return its Drive file ID. Idempotent on documentId: a retry after a lost response reuses
 * the file already there. The checksum Drive reports must match the sha256 of the buffer; one mismatch is retried.
 */
export async function uploadToDrive(folderId: string, file: DriveUpload): Promise<string> {
  try {
    const existing = await findOne(
      `appProperties has { key='documentId' and value=${q(assertUuid(file.documentId))} }`,
      FILE_FIELDS,
    );
    if (existing?.id) {
      if (verified(existing, file)) return existing.id;
      await trashDriveFile(existing.id);
    }
    const root = await rootFolder();
    for (let attempt = 1; ; attempt++) {
      const created = await createFile(folderId, root, file);
      if (verified(created, file)) return created.id!;
      await trashDriveFile(created.id!);
      if (attempt >= 2) throw new StorageError('UNAVAILABLE', `Checksum mismatch after upload of ${file.filename}`);
      logger.warn({ documentId: file.documentId }, 'drive checksum mismatch; retrying upload');
    }
  } catch (err) {
    throw toStorageError(err);
  }
}

function verified(f: DriveFile, file: DriveUpload): boolean {
  if (f.sha256Checksum) return f.sha256Checksum.toLowerCase() === file.sha256;
  logger.warn({ documentId: file.documentId, fileId: f.id }, 'drive returned no sha256Checksum; comparing size only');
  return Number(f.size) === byteLength(file.data);
}

function createFile(folderId: string, root: string, file: DriveUpload): Promise<DriveFile> {
  const metadata: drive_v3.Schema$File = {
    name: file.filename,
    parents: [folderId],
    mimeType: file.mimeType,
    appProperties: appTags(root, { submissionId: file.submissionId, documentId: file.documentId, sha256: file.sha256 }),
  };
  if (byteLength(file.data) > DRIVE_RESUMABLE_ABOVE_BYTES) return resumableUpload(metadata, file);
  return client()
    .drive.files.create({
      requestBody: metadata,
      media: { mimeType: file.mimeType, body: streamBytes(file.data) },
      fields: FILE_FIELDS,
      supportsAllDrives: true,
    })
    .then((r) => r.data);
}

const isUploadDone = (s: number) => s === 308 || (s >= 200 && s < 300);

/** Resumable upload protocol: open a session, PUT chunks, and on a dropped connection ask where to resume. */
async function resumableUpload(metadata: drive_v3.Schema$File, file: DriveUpload): Promise<DriveFile> {
  const { auth } = client();
  const total = byteLength(file.data);
  const init = await auth.request({
    url: 'https://www.googleapis.com/upload/drive/v3/files',
    method: 'POST',
    timeout: requestTimeoutMs(),
    params: { uploadType: 'resumable', supportsAllDrives: true, fields: FILE_FIELDS },
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': file.mimeType,
      'X-Upload-Content-Length': String(total),
    },
    data: metadata,
  });
  const session = init.headers.get('location');
  if (!session) throw new StorageError('UNAVAILABLE', 'Drive did not return a resumable upload session');

  let offset = 0;
  let failures = 0;
  for (;;) {
    const end = Math.min(offset + DRIVE_CHUNK_BYTES, total);
    try {
      const res = await auth.request<DriveFile>({
        url: session,
        method: 'PUT',
        retry: false,
        validateStatus: isUploadDone,
        timeout: requestTimeoutMs(),
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
        data: await readRange(file.data, offset, end),
      });
      if (res.status !== 308) return res.data;
      offset = resumeOffset(res.headers.get('range'));
      failures = 0;
    } catch (err) {
      if (!isRetryableDriveError(err) || ++failures > 3) throw err;
      await new Promise((r) => setTimeout(r, DRIVE_RETRY_BASE_MS * 2 ** failures));
      const st = await auth.request<DriveFile>({
        url: session,
        method: 'PUT',
        validateStatus: isUploadDone,
        timeout: requestTimeoutMs(),
        headers: { 'Content-Range': `bytes */${total}` },
      });
      if (st.status !== 308) return st.data;
      offset = resumeOffset(st.headers.get('range'));
    }
  }
}

/** "bytes=0-1048575" → 1048576; no Range header means nothing was stored yet. */
function resumeOffset(range: string | null): number {
  const m = range ? /bytes=0-(\d+)/.exec(range) : null;
  return m ? Number(m[1]) + 1 : 0;
}

export async function downloadDriveFile(fileId: string): Promise<Readable> {
  try {
    const res = await client().drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    );
    const body = res.data as unknown;
    return body instanceof Readable ? body : Readable.fromWeb(body as WebReadableStream);
  } catch (err) {
    throw toStorageError(err);
  }
}

/** Trash (not delete), so an operator can still restore a file removed by mistake. */
export async function trashDriveFile(fileId: string): Promise<void> {
  try {
    await client().drive.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true });
  } catch (err) {
    const e = toStorageError(err);
    if (e.kind !== 'NOT_FOUND') throw e;
  }
}

/** Cheap check that the credentials work and files can be added to the root folder, which is created if missing. */
export async function driveProbe(): Promise<void> {
  let canAdd: boolean | null | undefined;
  try {
    canAdd = (await liveRootFolder()).capabilities?.canAddChildren;
  } catch (err) {
    throw toStorageError(err);
  }
  if (canAdd === false) {
    throw new StorageError(
      'CONFIG',
      'The Google account can see the folder but cannot add files to it: share it as Editor',
    );
  }
}

/** Files (not folders) this server stored under its root folder, older than `olderThan`, in pages; used by the orphan sweep. */
export async function* listAppFiles(
  olderThan: Date,
): AsyncGenerator<{ id: string; documentId: string | null; name: string }> {
  const { drive } = client();
  const tagged = `appProperties has { key='app' and value=${q(APP_TAG)} } and appProperties has { key='root' and value=${q(await rootFolder())} }`;
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `${tagged} and mimeType!=${q(FOLDER_MIME)} and createdTime < ${q(olderThan.toISOString())} and trashed=false`,
      fields: 'nextPageToken, files(id,name,appProperties)',
      pageSize: 1000,
      pageToken,
      ...listScope(),
    });
    for (const f of res.data.files ?? []) {
      yield { id: f.id!, name: f.name ?? '', documentId: f.appProperties?.documentId ?? null };
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}

function statusOf(err: any): number | null {
  const s = err?.status ?? err?.response?.status ?? (typeof err?.code === 'number' ? err.code : null);
  return typeof s === 'number' ? s : null;
}

function driveReasons(err: any): string[] {
  return (err?.errors ?? err?.response?.data?.error?.errors ?? []).map((x: any) => x?.reason);
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ECONNABORTED',
  'TimeoutError',
  'AbortError',
]);

/** 429, 5xx, 403 rate limits and network errors are transient; anything else is a configuration problem. */
export function isRetryableDriveError(err: unknown): boolean {
  if (err instanceof StorageError) return err.kind === 'UNAVAILABLE';
  const e = err as any;
  const status = statusOf(e);
  if (status === 429 || (status !== null && status >= 500)) return true;
  if (status === 403) return driveReasons(e).some((r) => RATE_LIMIT_REASONS.has(r));
  if (status !== null) return false;
  // The Google client wraps the network failure, so the cause chain is checked too.
  for (let c = e, depth = 0; c && depth < 4; c = c.cause, depth++) {
    if (NETWORK_CODES.has(String(c.code)) || NETWORK_CODES.has(String(c.name)) || c.name === 'FetchError') return true;
    // Node's fetch reports a dropped connection as TypeError('fetch failed').
    if (c instanceof TypeError && /fetch failed/i.test(c.message)) return true;
  }
  return false;
}

export function toStorageError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (statusOf(err) === 404) return new StorageError('NOT_FOUND', message, { cause: err });
  if (driveReasons(err).includes('storageQuotaExceeded')) {
    return new StorageError('CONFIG', 'The Google account has no Drive storage left', { cause: err });
  }
  // The token endpoint answers 400 invalid_grant once a refresh token is revoked or expired.
  if ((err as any)?.response?.data?.error === 'invalid_grant') {
    return new StorageError('CONFIG', 'GOOGLE_REFRESH_TOKEN was revoked or has expired: generate a new one', {
      cause: err,
    });
  }
  return new StorageError(isRetryableDriveError(err) ? 'UNAVAILABLE' : 'CONFIG', message, { cause: err });
}

/** For tests: drop the cached client, root folder and month folders. */
export function resetDriveClient(): void {
  clients = null;
  cachedRoot = null;
  monthFolders.clear();
}
