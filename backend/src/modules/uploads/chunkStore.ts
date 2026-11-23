import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';

import { getStore } from '@netlify/blobs';

import { UPLOAD_STALE_MS } from '../../constants.js';

/** One upload sent in chunks (RUNTIME=netlify, where a request body is capped at 6 MB). */
export interface UploadMeta {
  userId: string;
  filename: string;
  mimeType: string;
  size: number;
  chunkCount: number;
  createdAt: string;
}

/** A chunk is missing, or the chunks do not add up to the declared size: nothing may be assembled. */
export class ChunkMissingError extends Error {}

/** Where chunked uploads wait until the request that uses them assembles them into a temporary file. */
export interface ChunkStore {
  create(meta: UploadMeta): Promise<string>;
  meta(id: string): Promise<UploadMeta | null>;
  put(id: string, index: number, bytes: Uint8Array): Promise<void>;
  /** Writes chunks 0..chunkCount-1 to `destPath` in order; ChunkMissingError when one is absent or sizes mismatch. */
  assemble(id: string, destPath: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Uploads created before `cutoff` (abandoned ones; the retention task removes them). */
  staleIds(cutoff: Date): Promise<string[]>;
}

const metaKey = (id: string) => `${id}/meta`;
const chunkKey = (id: string, index: number) => `${id}/${index}`;

/** Append chunks in order to a file, checking every one is present and the total matches the declared size. */
async function writeChunks(
  meta: UploadMeta,
  destPath: string,
  read: (index: number) => Promise<Uint8Array | null>,
): Promise<void> {
  const file = await open(destPath, 'w');
  let written = 0;
  try {
    for (let i = 0; i < meta.chunkCount; i++) {
      const bytes = await read(i);
      if (!bytes) throw new ChunkMissingError(`Chunk ${i} of ${meta.chunkCount} was not received`);
      await file.write(bytes);
      written += bytes.byteLength;
    }
  } finally {
    await file.close();
  }
  if (written !== meta.size)
    throw new ChunkMissingError(`Received ${written} bytes but the upload declared ${meta.size}`);
}

/** Netlify Blobs store `uploads`, strongly consistent: chunks are written and read by different function instances. */
export function createBlobChunkStore(): ChunkStore {
  const store = () => getStore({ name: 'uploads', consistency: 'strong' });
  const metaOf = async (id: string) =>
    ((await store().get(metaKey(id), { type: 'json' })) as UploadMeta | null) ?? null;
  return {
    async create(meta) {
      const id = randomUUID();
      await store().setJSON(metaKey(id), meta);
      return id;
    },
    meta: metaOf,
    async put(id, index, bytes) {
      // A copy as a plain ArrayBuffer (the bytes may be a view into a larger pooled buffer).
      await store().set(chunkKey(id, index), new Uint8Array(bytes).buffer);
    },
    async assemble(id, destPath) {
      const meta = await metaOf(id);
      if (!meta) throw new ChunkMissingError('Upload not found');
      await writeChunks(meta, destPath, async (i) => {
        const data = (await store().get(chunkKey(id, i), { type: 'arrayBuffer' })) as ArrayBuffer | null;
        return data ? new Uint8Array(data) : null;
      });
    },
    async remove(id) {
      const { blobs } = await store().list({ prefix: `${id}/` });
      await Promise.all(blobs.map((b) => store().delete(b.key)));
    },
    async staleIds(cutoff) {
      const out: string[] = [];
      for await (const page of store().list({ paginate: true })) {
        for (const b of page.blobs) {
          if (!b.key.endsWith('/meta')) continue;
          const id = b.key.slice(0, -'/meta'.length);
          const meta = await metaOf(id);
          if (!meta || new Date(meta.createdAt) < cutoff) out.push(id);
        }
      }
      return out;
    },
  };
}

/** In-process store (tests; and a server runtime, which never mounts the chunked upload routes). */
export function createMemoryChunkStore(): ChunkStore {
  const metas = new Map<string, UploadMeta>();
  const chunks = new Map<string, Uint8Array>();
  return {
    async create(meta) {
      const id = randomUUID();
      metas.set(id, meta);
      return id;
    },
    async meta(id) {
      return metas.get(id) ?? null;
    },
    async put(id, index, bytes) {
      chunks.set(chunkKey(id, index), new Uint8Array(bytes));
    },
    async assemble(id, destPath) {
      const meta = metas.get(id);
      if (!meta) throw new ChunkMissingError('Upload not found');
      await writeChunks(meta, destPath, async (i) => chunks.get(chunkKey(id, i)) ?? null);
    },
    async remove(id) {
      metas.delete(id);
      for (const key of [...chunks.keys()]) if (key.startsWith(`${id}/`)) chunks.delete(key);
    },
    async staleIds(cutoff) {
      return [...metas].filter(([, m]) => new Date(m.createdAt) < cutoff).map(([id]) => id);
    },
  };
}

/** Delete chunked uploads older than UPLOAD_STALE_MS (abandoned: no request used them). Returns how many. */
export async function purgeStaleUploads(store: ChunkStore, now: Date = new Date()): Promise<number> {
  const ids = await store.staleIds(new Date(now.getTime() - UPLOAD_STALE_MS));
  for (const id of ids) await store.remove(id);
  return ids.length;
}
