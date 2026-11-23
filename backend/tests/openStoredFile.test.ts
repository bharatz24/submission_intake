import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const drive = vi.hoisted(() => ({ downloads: 0 }));
vi.mock('../src/services/driveStorage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/driveStorage.js')>()),
  downloadDriveFile: vi.fn(async (fileId: string) => {
    drive.downloads++;
    return Readable.from([Buffer.from(`bytes of ${fileId}`)]);
  }),
}));

const { DOWNLOAD_BUFFER_MAX_BYTES } = await import('../src/constants.js');
const fileCache = await import('../src/services/fileCache.js');
const { openStoredFile } = await import('../src/services/storage.js');

const doc = (id: string, size: number) => ({
  id,
  storage_backend: 'GDRIVE',
  storage_key: `drive-${id}`,
  size_bytes: String(size),
});

beforeEach(() => {
  drive.downloads = 0;
  fileCache.clear();
});

describe('openStoredFile', () => {
  it('reads a small file whole and caches it, so a re-open skips Drive', async () => {
    expect(await text(await openStoredFile(doc('small', 1000)))).toBe('bytes of drive-small');
    expect(await text(await openStoredFile(doc('small', 1000)))).toBe('bytes of drive-small');
    expect(drive.downloads).toBe(1);
    expect(fileCache.stats().entries).toBe(1);
  });

  it('streams a large file straight through without caching it', async () => {
    const big = doc('big', DOWNLOAD_BUFFER_MAX_BYTES + 1);
    expect(await text(await openStoredFile(big))).toBe('bytes of drive-big');
    expect(await text(await openStoredFile(big))).toBe('bytes of drive-big');
    expect(drive.downloads).toBe(2);
    expect(fileCache.stats().entries).toBe(0);
  });

  it('serves a large file from the cache when ingest already put it there', async () => {
    fileCache.put('big', Buffer.from('cached at ingest'));
    expect(await text(await openStoredFile(doc('big', DOWNLOAD_BUFFER_MAX_BYTES + 1)))).toBe('cached at ingest');
    expect(drive.downloads).toBe(0);
  });
});
