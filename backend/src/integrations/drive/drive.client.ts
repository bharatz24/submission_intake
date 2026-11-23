import type { Readable } from 'node:stream';

import {
  downloadDriveFile,
  driveProbe,
  type DriveUpload,
  ensureSubmissionFolder,
  listAppFiles,
  trashDriveFile,
  uploadToDrive,
} from '../../services/driveStorage.js';

/**
 * Google Drive, where every attachment's bytes live (external-integrations skill: one adapter per system, an interface
 * the app is given). The real client keeps everything services/driveStorage.ts does: resumable chunked uploads,
 * retries, error mapping to StorageError. Tests give a fake through setIntegrations({ drive }) or createApp({ drive }).
 */
export interface DriveClient {
  /** The submission's folder (created on first use); its id. */
  ensureSubmissionFolder(submissionId: string, label: string, receivedAt: Date): Promise<string>;
  /** Uploads one file into a folder; the new file's id. */
  upload(folderId: string, file: DriveUpload): Promise<string>;
  /** A file's bytes, readable once Drive has answered. */
  download(fileId: string): Promise<Readable>;
  /** Moves a file to Drive's trash. */
  trash(fileId: string): Promise<void>;
  /** Checks the configured folder can be reached and written. */
  probe(): Promise<void>;
  /** Files this app uploaded before `olderThan` (the orphan sweep). */
  listAppFiles(olderThan: Date): AsyncIterable<{ id: string; documentId: string | null; name: string }>;
}

export function createDriveClient(): DriveClient {
  return {
    ensureSubmissionFolder: (submissionId, label, receivedAt) =>
      ensureSubmissionFolder(submissionId, label, receivedAt),
    upload: (folderId, file) => uploadToDrive(folderId, file),
    download: (fileId) => downloadDriveFile(fileId),
    trash: (fileId) => trashDriveFile(fileId),
    probe: () => driveProbe(),
    listAppFiles: (olderThan) => listAppFiles(olderThan),
  };
}
