/**
 * Unit tests for services/driveStorage.ts against a mocked googleapis Drive client (no network, no database).
 */
import { createHash } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.GOOGLE_REFRESH_TOKEN = 'refresh-token';
process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.GDRIVE_SHARED_DRIVE_ID = 'shared-drive';

const files = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
};
const authRequest = vi.fn();
const oauth = vi.hoisted(() => ({ clients: [] as unknown[][], credentials: [] as unknown[] }));
const recordSystemError = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../src/services/audit.js', () => ({ recordSystemError }));

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        request = authRequest;
        constructor(...args: unknown[]) {
          oauth.clients.push(args);
        }
        setCredentials(c: unknown) {
          oauth.credentials.push(c);
        }
      },
    },
    drive: () => ({ files }),
  },
}));

let drive: typeof import('../src/services/driveStorage.js');

beforeAll(async () => {
  drive = await import('../src/services/driveStorage.js');
});

beforeEach(() => {
  for (const fn of [...Object.values(files), authRequest, recordSystemError]) fn.mockReset();
  files.list.mockImplementation(listWithRoot(['root-folder']));
  files.update.mockResolvedValue({ data: {} });
  files.get.mockResolvedValue({ data: { id: 'root-folder', trashed: false, capabilities: { canAddChildren: true } } });
  drive.resetDriveClient();
});

const ROOT_NAME = `name='Submission Review'`;
const isRootQuery = (c: any) => c.q.includes(ROOT_NAME);
/** files.list answering root-folder queries with `roots` (oldest first) and everything else with nothing. */
const listWithRoot =
  (roots: string[]) =>
  async ({ q }: any) => ({ data: { files: q.includes(ROOT_NAME) ? roots.map((id) => ({ id })) : [] } });
const isRootCreate = ([c]: any) => c.requestBody.appProperties.role === 'root';
/** files.create handing out a root folder ID and a generic ID for anything else. */
const createWithRoot =
  (id: string) =>
  async ({ requestBody }: any) => ({ data: { id: requestBody.appProperties.role === 'root' ? id : 'other' } });

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const DOC = '11111111-2222-4333-8444-555555555555';
const SUB = '99999999-8888-4777-8666-555555555555';
const upload = (data: Buffer) => ({
  submissionId: SUB,
  documentId: DOC,
  filename: 'app.pdf',
  mimeType: 'application/pdf',
  sha256: sha(data),
  data,
});

describe('uploadToDrive', () => {
  it('creates the file in the Shared Drive folder with appProperties', async () => {
    const data = Buffer.from('hello');
    files.create.mockResolvedValue({ data: { id: 'file-1', size: '5', sha256Checksum: sha(data) } });
    expect(await drive.uploadToDrive('folder-1', upload(data))).toBe('file-1');

    const [list] = files.list.mock.calls[0]!;
    expect(list).toMatchObject({
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'drive',
      driveId: 'shared-drive',
    });
    expect(list.q).toContain(`appProperties has { key='documentId' and value='${DOC}' }`);
    const [create] = files.create.mock.calls[0]!;
    expect(create).toMatchObject({
      supportsAllDrives: true,
      requestBody: {
        name: 'app.pdf',
        parents: ['folder-1'],
        appProperties: { app: 'submission-review', submissionId: SUB, documentId: DOC, sha256: sha(data) },
      },
    });
    expect(authRequest).not.toHaveBeenCalled();
  });

  it('reuses a file already uploaded for the same document (idempotent retry)', async () => {
    const data = Buffer.from('hello');
    files.list.mockResolvedValue({ data: { files: [{ id: 'existing', size: '5', sha256Checksum: sha(data) }] } });
    expect(await drive.uploadToDrive('folder-1', upload(data))).toBe('existing');
    expect(files.create).not.toHaveBeenCalled();
  });

  it('trashes and retries once on a checksum mismatch, then fails', async () => {
    files.create.mockResolvedValue({ data: { id: 'bad', size: '5', sha256Checksum: 'f'.repeat(64) } });
    const err = await drive.uploadToDrive('folder-1', upload(Buffer.from('hello'))).catch((e) => e);
    expect(err).toBeInstanceOf(drive.StorageError);
    expect(err.kind).toBe('UNAVAILABLE');
    expect(files.create).toHaveBeenCalledTimes(2);
    expect(files.update).toHaveBeenCalledTimes(2);
    expect(files.update.mock.calls[0]![0]).toMatchObject({
      fileId: 'bad',
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
  });

  it('uploads a file on disk in chunks read from the file, never loading it whole', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'drive-test-'));
    try {
      const data = Buffer.alloc(9 * 1024 * 1024, 3);
      data[0] = 1;
      data[data.length - 1] = 9;
      const filePath = join(dir, 'upload');
      await writeFile(filePath, data);
      const chunk = 8 * 1024 * 1024;
      authRequest
        .mockResolvedValueOnce({
          status: 200,
          headers: new Headers({ location: 'https://upload.example/session' }),
          data: {},
        })
        .mockResolvedValueOnce({ status: 308, headers: new Headers({ range: `bytes=0-${chunk - 1}` }), data: '' })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Headers(),
          data: { id: 'disk', size: String(data.length), sha256Checksum: sha(data) },
        });
      expect(
        await drive.uploadToDrive('folder-1', { ...upload(data), data: { path: filePath, size: data.length } }),
      ).toBe('disk');
      const first = authRequest.mock.calls[1]![0].data as Buffer;
      const second = authRequest.mock.calls[2]![0].data as Buffer;
      expect(first.length).toBe(chunk);
      expect(first[0]).toBe(1);
      expect(second.length).toBe(data.length - chunk);
      expect(second[second.length - 1]).toBe(9);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses a resumable session above 5 MB and resumes from the reported offset', async () => {
    const data = Buffer.alloc(9 * 1024 * 1024, 7);
    const chunk = 8 * 1024 * 1024;
    authRequest
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ location: 'https://upload.example/session' }),
        data: {},
      })
      .mockResolvedValueOnce({ status: 308, headers: new Headers({ range: `bytes=0-${chunk - 1}` }), data: '' })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        data: { id: 'big', size: String(data.length), sha256Checksum: sha(data) },
      });
    expect(await drive.uploadToDrive('folder-1', upload(data))).toBe('big');
    expect(files.create).not.toHaveBeenCalled();
    expect(authRequest.mock.calls[0]![0]).toMatchObject({
      method: 'POST',
      params: { uploadType: 'resumable', supportsAllDrives: true },
    });
    expect(authRequest.mock.calls[1]![0].headers['Content-Range']).toBe(`bytes 0-${chunk - 1}/${data.length}`);
    expect(authRequest.mock.calls[2]![0].headers['Content-Range']).toBe(
      `bytes ${chunk}-${data.length - 1}/${data.length}`,
    );
  });
});

describe('folders', () => {
  it('creates the month folder once for concurrent submissions and never queries by email-derived names', async () => {
    files.create.mockImplementation(async ({ requestBody }: any) => ({
      data: { id: requestBody.appProperties.month ? 'month-folder' : `sub-${requestBody.appProperties.submissionId}` },
    }));
    const subs = [SUB, '99999999-8888-4777-8666-000000000001'];
    const ids = await Promise.all(
      subs.map((s) => drive.ensureSubmissionFolder(s, "Dr O'Brien's application", new Date('2026-10-29T12:00:00Z'))),
    );
    expect(ids).toEqual(subs.map((s) => `sub-${s}`));
    const monthCreates = files.create.mock.calls.filter(([c]: any) => c.requestBody.appProperties.month);
    expect(monthCreates).toHaveLength(1);
    expect(monthCreates[0]![0].requestBody).toMatchObject({ name: '2026-10', parents: ['root-folder'] });
    const subCreate = files.create.mock.calls.find(([c]: any) => c.requestBody.appProperties.submissionId === SUB)![0];
    expect(subCreate.requestBody.name).toBe("2026-10-29 · Dr O'Brien's application · 99999999");
    for (const [l] of files.list.mock.calls) expect(l.q).not.toContain('Brien');
  });
});

describe('root folder', () => {
  let config: (typeof import('../src/config.js'))['config'];
  beforeAll(async () => {
    ({ config } = await import('../src/config.js'));
  });

  const at = new Date('2026-10-29T12:00:00Z');
  const rootLookups = () => files.list.mock.calls.filter(([c]: any) => isRootQuery(c));
  const rootCreates = () => files.create.mock.calls.filter(isRootCreate);

  it('defaults the name, and gdrive needs no folder ID', () => {
    expect(config.GDRIVE_ROOT_FOLDER_NAME).toBe('Submission Review');
    expect(config).not.toHaveProperty('GDRIVE_ROOT_FOLDER_ID');
  });

  it('reconnects to the folder with the configured name, oldest first, without creating one', async () => {
    await drive.driveProbe();
    expect(rootCreates()).toHaveLength(0);
    const [list] = rootLookups()[0]!;
    expect(list.q).toContain(`'shared-drive' in parents`);
    expect(list.q).toContain(`mimeType='application/vnd.google-apps.folder'`);
    expect(list.q).toContain(`appProperties has { key='app' and value='submission-review' }`);
    expect(list.q).toContain(`appProperties has { key='role' and value='root' }`);
    expect(list.q).toContain('trashed=false');
    expect(list).toMatchObject({ orderBy: 'createdTime', corpora: 'drive', driveId: 'shared-drive' });
  });

  it('creates it at the top of the Shared Drive when there is none', async () => {
    let roots: string[] = [];
    files.list.mockImplementation(async (a: any) => listWithRoot(roots)(a));
    files.create.mockImplementation(async (a: any) => {
      roots = ['new-root'];
      return createWithRoot('new-root')(a);
    });
    await drive.driveProbe();
    expect(rootCreates()).toHaveLength(1);
    expect(rootCreates()[0]![0]).toMatchObject({
      supportsAllDrives: true,
      requestBody: {
        name: 'Submission Review',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['shared-drive'],
        appProperties: { app: 'submission-review', role: 'root' },
      },
    });
    expect(files.update).not.toHaveBeenCalled();
    expect(recordSystemError).toHaveBeenCalledWith(
      'drive:root-folder',
      expect.stringContaining('Created Google Drive folder'),
    );
  });

  it('creates it at the top of My Drive without a Shared Drive', async () => {
    const saved = config.GDRIVE_SHARED_DRIVE_ID;
    config.GDRIVE_SHARED_DRIVE_ID = undefined;
    try {
      files.list.mockImplementation(listWithRoot([]));
      files.create.mockImplementation(createWithRoot('new-root'));
      await drive.driveProbe();
      expect(rootCreates()[0]![0].requestBody.parents).toEqual(['root']);
      expect(rootLookups()[0]![0]).toMatchObject({ corpora: 'user' });
      expect(rootLookups()[0]![0].q).toContain(`'root' in parents`);
    } finally {
      config.GDRIVE_SHARED_DRIVE_ID = saved;
    }
  });

  it('treats an empty GDRIVE_SHARED_DRIVE_ID as My Drive', async () => {
    const saved = config.GDRIVE_SHARED_DRIVE_ID;
    config.GDRIVE_SHARED_DRIVE_ID = '';
    try {
      files.list.mockImplementation(listWithRoot([]));
      files.create.mockImplementation(createWithRoot('new-root'));
      await drive.driveProbe();
      expect(rootCreates()[0]![0].requestBody.parents).toEqual(['root']);
    } finally {
      config.GDRIVE_SHARED_DRIVE_ID = saved;
    }
  });

  it('keeps searching past an empty page instead of creating a duplicate', async () => {
    files.list.mockResolvedValueOnce({ data: { files: [], nextPageToken: 'more' } });
    await drive.driveProbe();
    expect(rootCreates()).toHaveLength(0);
    expect(rootLookups()[1]![0]).toMatchObject({ pageToken: 'more' });
  });

  it('looks it up once for many concurrent callers', async () => {
    const data = Buffer.from('hello');
    files.create.mockResolvedValue({ data: { id: 'file-1', size: '5', sha256Checksum: sha(data) } });
    await Promise.all([1, 2, 3, 4].map(() => drive.uploadToDrive('folder-1', upload(data))));
    expect(rootLookups()).toHaveLength(1);
  });

  it('trashes its own folder and uses the older one when another server created one too', async () => {
    let roots: string[] = [];
    files.list.mockImplementation(async (a: any) => listWithRoot(roots)(a));
    files.create.mockImplementation(async (a: any) => {
      roots = ['older-root', 'new-root'];
      return createWithRoot('new-root')(a);
    });
    const seen: string[] = [];
    files.get.mockImplementation(async ({ fileId }: any) => {
      seen.push(fileId);
      return { data: { id: fileId } };
    });
    await drive.driveProbe();
    expect(files.update).toHaveBeenCalledTimes(1);
    expect(files.update.mock.calls[0]![0]).toMatchObject({ fileId: 'new-root', requestBody: { trashed: true } });
    expect(seen).toEqual(['older-root']);
  });

  it('keeps the folder it created when the search does not show it yet', async () => {
    files.list.mockImplementation(listWithRoot([]));
    files.create.mockImplementation(createWithRoot('new-root'));
    files.get.mockImplementation(async ({ fileId }: any) => ({ data: { id: fileId } }));
    await drive.driveProbe();
    expect(files.update).not.toHaveBeenCalled();
    expect(files.get.mock.calls[0]![0].fileId).toBe('new-root');
  });

  it('does not cache a failed lookup', async () => {
    files.list.mockRejectedValueOnce({ status: 503 });
    await expect(drive.driveProbe()).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    await expect(drive.driveProbe()).resolves.toBeUndefined();
    expect(rootLookups()).toHaveLength(2);
  });

  it('looks the root up only once across many calls, even after a month folder create returns 404', async () => {
    let months = 0;
    files.create.mockImplementation(async ({ requestBody }: any) => {
      if (requestBody.appProperties.month && ++months === 1)
        throw Object.assign(new Error('File not found'), { status: 404 });
      return { data: { id: 'folder' } };
    });
    await expect(drive.ensureSubmissionFolder(SUB, 'x', at)).resolves.toBe('folder');
    await expect(drive.ensureSubmissionFolder(SUB, 'x', at)).resolves.toBe('folder');
    expect(rootLookups()).toHaveLength(1);
  });

  it('checks Drive once per submission when the month folder is cached', async () => {
    files.create.mockImplementation(async () => ({ data: { id: 'folder' } }));
    await drive.ensureSubmissionFolder(SUB, 'x', at);
    files.get.mockClear();
    await drive.ensureSubmissionFolder(SUB, 'x', at);
    expect(files.get).toHaveBeenCalledTimes(1);
  });

  /** After a first submission cached 'root-folder', makes it unavailable; a replacement named 'new-root' can then be created. */
  const loseRoot = async (lose: () => void) => {
    const children = async ({ requestBody }: any) => ({ data: { id: `${requestBody.parents[0]}-child` } });
    files.create.mockImplementation(children);
    expect(await drive.ensureSubmissionFolder(SUB, 'x', at)).toBe('root-folder-child-child');
    files.create.mockClear();
    let roots: string[] = [];
    files.list.mockImplementation(async (a: any) => listWithRoot(roots)(a));
    files.create.mockImplementation(async (a: any) => {
      if (a.requestBody.appProperties.role !== 'root') return children(a);
      roots = ['new-root'];
      return { data: { id: 'new-root' } };
    });
    lose();
  };

  it('creates a new folder with the same name when the root was trashed, before creating anything in it', async () => {
    // Drive reports everything inside a trashed folder as trashed.
    await loseRoot(() =>
      files.get.mockImplementation(async ({ fileId }: any) => ({
        data: { id: fileId, trashed: fileId.startsWith('root-folder') },
      })),
    );
    expect(await drive.ensureSubmissionFolder(SUB, 'x', at)).toBe('new-root-child-child');
    expect(files.create.mock.calls.map(([c]: any) => c.requestBody.parents[0])).toEqual([
      'shared-drive',
      'new-root',
      'new-root-child',
    ]);
    expect(rootCreates()[0]![0].requestBody.name).toBe('Submission Review');
  });

  it('creates a new folder when the root was deleted, and reports it once for concurrent callers', async () => {
    await loseRoot(() =>
      files.get.mockImplementation(async ({ fileId }: any) => {
        if (fileId === 'root-folder') throw Object.assign(new Error('File not found'), { status: 404 });
        return { data: { id: fileId } };
      }),
    );
    await Promise.all([drive.driveProbe(), drive.driveProbe(), drive.driveProbe()]);
    expect(rootCreates()).toHaveLength(1);
    expect((recordSystemError.mock.calls as any[]).filter(([, m]) => m.includes('was trashed'))).toHaveLength(1);
    expect(recordSystemError).toHaveBeenCalledWith('drive:root-folder', expect.stringContaining('Submission Review'));
  });

  it('replaces a deleted root when a new month folder cannot be created in it', async () => {
    await loseRoot(() =>
      files.get.mockImplementation(async ({ fileId }: any) => {
        if (fileId === 'root-folder') throw Object.assign(new Error('File not found'), { status: 404 });
        return { data: { id: fileId } };
      }),
    );
    const create = files.create.getMockImplementation()!;
    files.create.mockImplementation(async (a: any) => {
      if (a.requestBody.parents[0] === 'root-folder') throw Object.assign(new Error('File not found'), { status: 404 });
      return create(a);
    });
    expect(await drive.ensureSubmissionFolder(SUB, 'x', new Date('2026-11-02T00:00:00Z'))).toBe('new-root-child-child');
  });

  it('reconnects to a surviving folder with the same name instead of creating one', async () => {
    await loseRoot(() => {
      files.list.mockImplementation(listWithRoot(['another-root']));
      files.get.mockImplementation(async ({ fileId }: any) => ({
        data: { id: fileId, trashed: fileId === 'root-folder' },
      }));
    });
    await drive.driveProbe();
    expect(rootCreates()).toHaveLength(0);
    expect(files.get.mock.calls.at(-1)![0].fileId).toBe('another-root');
  });

  it('fails rather than use a root the search still returns after it was trashed', async () => {
    files.get.mockResolvedValue({ data: { id: 'root-folder', trashed: true } });
    await expect(drive.driveProbe()).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  });

  it('does not report a Drive outage as a lost root', async () => {
    files.get.mockRejectedValue({ status: 503 });
    await expect(drive.driveProbe()).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    expect(rootCreates()).toHaveLength(0);
    expect(recordSystemError).not.toHaveBeenCalled();
  });

  it('replaces a cached month folder that was trashed', async () => {
    let n = 0;
    files.create.mockImplementation(async ({ requestBody }: any) => ({
      data: { id: requestBody.appProperties.month ? `month-${++n}` : 'sub' },
    }));
    await drive.ensureSubmissionFolder(SUB, 'x', at);
    files.get.mockImplementation(async ({ fileId }: any) => ({ data: { id: fileId, trashed: fileId === 'month-1' } }));
    await drive.ensureSubmissionFolder(SUB, 'x', at);
    expect(files.create.mock.calls.at(-1)![0].requestBody.parents).toEqual(['month-2']);
  });

  it('fails rather than use a month folder the search still returns after it was trashed', async () => {
    files.create.mockImplementation(async () => ({ data: { id: 'month-folder' } }));
    await drive.ensureSubmissionFolder(SUB, 'x', at);
    files.create.mockClear();
    files.list.mockImplementation(async (a: any) =>
      a.q.includes(`name='2026-10'`) ? { data: { files: [{ id: 'month-folder' }] } } : listWithRoot(['root-folder'])(a),
    );
    files.get.mockImplementation(async ({ fileId }: any) => ({
      data: { id: fileId, trashed: fileId === 'month-folder' },
    }));
    await expect(drive.ensureSubmissionFolder(SUB, 'x', at)).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    expect(files.create).not.toHaveBeenCalled();
  });

  it('probe creates a missing root and still reports it as read-only', async () => {
    files.list.mockImplementation(listWithRoot([]));
    files.create.mockImplementation(createWithRoot('new-root'));
    files.get.mockResolvedValue({ data: { id: 'new-root', capabilities: { canAddChildren: false } } });
    await expect(drive.driveProbe()).rejects.toMatchObject({
      kind: 'CONFIG',
      message: expect.stringContaining('share it as Editor'),
    });
    expect(rootCreates()).toHaveLength(1);
  });
});

describe('errors', () => {
  it('classifies transient and permanent Drive errors', () => {
    expect(drive.isRetryableDriveError({ status: 429 })).toBe(true);
    expect(drive.isRetryableDriveError({ status: 503 })).toBe(true);
    expect(drive.isRetryableDriveError({ status: 403, errors: [{ reason: 'userRateLimitExceeded' }] })).toBe(true);
    expect(drive.isRetryableDriveError({ status: 403, errors: [{ reason: 'insufficientFilePermissions' }] })).toBe(
      false,
    );
    expect(drive.isRetryableDriveError({ status: 401 })).toBe(false);
    expect(drive.isRetryableDriveError({ code: 'ECONNRESET' })).toBe(true);
    expect(drive.isRetryableDriveError(new TypeError('fetch failed'))).toBe(true);
    expect(drive.isRetryableDriveError(new TypeError('x is not a function'))).toBe(false);
  });

  it('maps 404 to NOT_FOUND and other failures to UNAVAILABLE or CONFIG', async () => {
    expect(drive.toStorageError({ status: 404, message: 'gone' }).kind).toBe('NOT_FOUND');
    expect(drive.toStorageError({ status: 500 }).kind).toBe('UNAVAILABLE');
    expect(drive.toStorageError({ status: 400 }).kind).toBe('CONFIG');
    files.get.mockRejectedValue(Object.assign(new Error('File not found'), { status: 404 }));
    await expect(drive.downloadDriveFile('nope')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('treats trashing a file that is already gone as done', async () => {
    files.update.mockRejectedValue({ status: 404 });
    await expect(drive.trashDriveFile('gone')).resolves.toBeUndefined();
  });
});

describe('Google account (OAuth refresh token)', () => {
  let config: (typeof import('../src/config.js'))['config'];
  beforeAll(async () => {
    ({ config } = await import('../src/config.js'));
  });

  it("signs in with the refresh token and searches the account's own Drive when no Shared Drive is set", async () => {
    const saved = config.GDRIVE_SHARED_DRIVE_ID;
    config.GDRIVE_SHARED_DRIVE_ID = undefined;
    try {
      const data = Buffer.from('hello');
      files.create.mockResolvedValue({ data: { id: 'file-1', size: '5', sha256Checksum: sha(data) } });
      await drive.uploadToDrive('folder-1', upload(data));
      expect(oauth.clients.at(-1)).toEqual([
        {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          endpoints: { oauth2TokenUrl: 'https://oauth2.googleapis.com/token' },
        },
      ]);
      expect(oauth.credentials.at(-1)).toMatchObject({ refresh_token: 'refresh-token' });
      const [list] = files.list.mock.calls[0]!;
      expect(list).toMatchObject({ corpora: 'user', supportsAllDrives: true, includeItemsFromAllDrives: true });
      expect(list).not.toHaveProperty('driveId');
    } finally {
      config.GDRIVE_SHARED_DRIVE_ID = saved;
    }
  });

  it('reports a revoked refresh token as a configuration error', () => {
    const err = drive.toStorageError({
      status: 400,
      message: 'invalid_grant',
      response: { status: 400, data: { error: 'invalid_grant' } },
    });
    expect(err.kind).toBe('CONFIG');
    expect(err.message).toContain('GOOGLE_REFRESH_TOKEN');
  });

  it('probe fails with a clear message when the folder is shared read-only', async () => {
    files.get.mockResolvedValue({ data: { id: 'root-folder', capabilities: { canAddChildren: false } } });
    await expect(drive.driveProbe()).rejects.toMatchObject({
      kind: 'CONFIG',
      message: expect.stringContaining('share it as Editor'),
    });
    files.get.mockResolvedValue({ data: { id: 'root-folder', capabilities: { canAddChildren: true } } });
    await expect(drive.driveProbe()).resolves.toBeUndefined();
  });

  it('explains storageQuotaExceeded instead of retrying it', () => {
    const err = drive.toStorageError({ status: 403, message: 'quota', errors: [{ reason: 'storageQuotaExceeded' }] });
    expect(err.kind).toBe('CONFIG');
    expect(err.message).toContain('no Drive storage left');
  });
});

describe('audit fixes', () => {
  it("tags files with the root folder and sweeps only this root's files", async () => {
    const data = Buffer.from('hello');
    files.create.mockResolvedValue({ data: { id: 'file-1', size: '5', sha256Checksum: sha(data) } });
    await drive.uploadToDrive('folder-1', upload(data));
    expect(files.create.mock.calls[0]![0].requestBody.appProperties).toMatchObject({
      app: 'submission-review',
      root: 'root-folder',
    });

    for await (const _ of drive.listAppFiles(new Date())) {
      /* drain */
    }
    expect(files.list.mock.calls.at(-1)![0].q).toContain(`appProperties has { key='root' and value='root-folder' }`);
  });

  it('treats a network failure wrapped by the Google client as transient', () => {
    const wrapped = Object.assign(new Error('request to drive failed'), {
      name: 'GaxiosError',
      cause: new TypeError('fetch failed'),
    });
    expect(drive.isRetryableDriveError(wrapped)).toBe(true);
    expect(drive.isRetryableDriveError({ name: 'GaxiosError', cause: { code: 'ETIMEDOUT' } })).toBe(true);
  });
});
