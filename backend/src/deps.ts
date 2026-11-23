import type pg from 'pg';

import { isNetlifyRuntime } from './config.js';
import { pool } from './db/pool.js';
import { type Integrations, integrations } from './integrations/index.js';
import { type ChunkStore, createBlobChunkStore, createMemoryChunkStore } from './modules/uploads/chunkStore.js';

/**
 * What the HTTP app depends on, injected through createApp(deps) (node-api skill) so a test can swap any of them:
 * the database pool, the clock, the clients of external systems (Drive, Gmail, IMS 2, NPI registry), and where chunked
 * uploads wait. Modules under src/modules receive these instead of importing the pool or an integration directly.
 */
export interface AppDeps extends Integrations {
  db: pg.Pool;
  clock: { now(): Date };
  /** Chunked uploads (RUNTIME=netlify: Netlify Blobs; unused by a server, whose uploads are multipart). */
  chunks: ChunkStore;
}

/** The real pool and clock, and the process's integration clients (integrations/index.ts). */
export function defaultDeps(): AppDeps {
  return {
    db: pool,
    clock: { now: () => new Date() },
    chunks: isNetlifyRuntime() ? createBlobChunkStore() : createMemoryChunkStore(),
    ...integrations(),
  };
}
