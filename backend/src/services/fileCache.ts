import { config } from '../config.js';

/**
 * Bounded in-memory LRU of document bytes, keyed by document ID. Fed on upload and on first read, so the
 * extraction that follows an ingest and quick re-opens of a document skip a Drive download.
 * Holds at most GDRIVE_CACHE_MB in total; entries expire after GDRIVE_CACHE_TTL_MINUTES. Never written to disk.
 */
interface Entry {
  data: Buffer;
  expiresAt: number;
}

const entries = new Map<string, Entry>(); // insertion order = least recently used first
let totalBytes = 0;

const maxBytes = () => config.GDRIVE_CACHE_MB * 1024 * 1024;
const ttlMs = () => config.GDRIVE_CACHE_TTL_MINUTES * 60_000;

export function get(documentId: string): Buffer | null {
  const e = entries.get(documentId);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    remove(documentId);
    return null;
  }
  entries.delete(documentId);
  entries.set(documentId, e);
  return e.data;
}

export function put(documentId: string, data: Buffer): void {
  remove(documentId);
  // A file larger than the whole cache would only evict everything else.
  if (data.length > maxBytes()) return;
  entries.set(documentId, { data, expiresAt: Date.now() + ttlMs() });
  totalBytes += data.length;
  for (const [id] of entries) {
    if (totalBytes <= maxBytes()) break;
    remove(id);
  }
}

export function remove(documentId: string): void {
  const e = entries.get(documentId);
  if (!e) return;
  entries.delete(documentId);
  totalBytes -= e.data.length;
}

export function clear(): void {
  entries.clear();
  totalBytes = 0;
}

export function stats() {
  return { entries: entries.size, bytes: totalBytes };
}
