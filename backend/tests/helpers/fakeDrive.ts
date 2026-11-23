/**
 * In-memory Google Drive for suites that store attachments but do not test Drive itself: replaces the Drive calls of
 * services/driveStorage.ts and keeps the rest (StorageError, error mapping). Use as
 * `vi.mock('../src/services/driveStorage.js', async (orig) => (await import('./helpers/fakeDrive.js')).fakeDrive(await orig()))`.
 */
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

export const driveFiles = new Map<string, { data: Buffer; filename: string; documentId: string }>();

export function fakeDrive<T extends typeof import('../../src/services/driveStorage.js')>(real: T): T {
  return {
    ...real,
    ensureSubmissionFolder: async (submissionId: string) => `folder-${submissionId}`,
    uploadToDrive: async (
      _folderId: string,
      f: { documentId: string; filename: string; data: Buffer | { path: string } },
    ) => {
      const id = `drive-${f.documentId}`;
      // Browser uploads arrive as temporary files on disk: read them now, before the request deletes them.
      const data = Buffer.isBuffer(f.data) ? f.data : await readFile(f.data.path);
      driveFiles.set(id, { data, filename: f.filename, documentId: f.documentId });
      return id;
    },
    downloadDriveFile: async (id: string) => {
      const f = driveFiles.get(id);
      if (!f) throw new real.StorageError('NOT_FOUND', 'File not found');
      return Readable.from([f.data]);
    },
    trashDriveFile: async (id: string) => {
      driveFiles.delete(id);
    },
    driveProbe: async () => undefined,
    listAppFiles: async function* () {
      for (const [id, f] of driveFiles) yield { id, name: f.filename, documentId: f.documentId };
    },
  };
}
