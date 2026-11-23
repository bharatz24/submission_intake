import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

/**
 * The bytes of one file to store: in memory (an email attachment, which Gmail hands over whole) or in a temporary
 * file on disk (a browser upload, which multer writes to disk so a large upload is never held in memory). Code that
 * stores files reads them through these helpers, so it works with either without loading a disk file whole.
 */
export interface DiskFile {
  path: string;
  size: number;
}
export type FileBytes = Buffer | DiskFile;

export const byteLength = (bytes: FileBytes): number => (Buffer.isBuffer(bytes) ? bytes.length : bytes.size);

/** A fresh stream of the whole file. */
export function streamBytes(bytes: FileBytes): Readable {
  return Buffer.isBuffer(bytes) ? Readable.from([bytes]) : createReadStream(bytes.path);
}

/** The whole file in memory: for small files only (the caller checks the size). */
export async function readAllBytes(bytes: FileBytes): Promise<Buffer> {
  return Buffer.isBuffer(bytes) ? bytes : readFile(bytes.path);
}

/** Bytes [start, end) of the file, e.g. one chunk of a resumable upload. */
export async function readRange(bytes: FileBytes, start: number, end: number): Promise<Buffer> {
  if (Buffer.isBuffer(bytes)) return bytes.subarray(start, end);
  const handle = await open(bytes.path, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** sha256 (hex) of the file, streamed for a disk file. */
export async function sha256Bytes(bytes: FileBytes): Promise<string> {
  const hash = createHash('sha256');
  if (Buffer.isBuffer(bytes)) return hash.update(bytes).digest('hex');
  for await (const chunk of createReadStream(bytes.path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
