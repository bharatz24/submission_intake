import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { WorkerPool, WorkerTaskError } from '../workerPool.js';
import { type ParsedWorkbook, RateImportError, type RateWorkbook, readRateWorkbook } from './importer.js';
import type { WorkbookReply, WorkbookTask } from './workbookWorker.js';

/**
 * Rate-workbook parsing off the event loop (PERF-02 / SEC-05). ExcelJS inflates and walks the whole workbook
 * synchronously in places; on the main thread a large or hostile upload froze every request (SSE included). Here it
 * runs in one worker thread with a heap limit and a deadline, like document extraction (extractionPool.ts): a
 * workbook that runs out of memory or time fails its import (422) and only its worker is replaced.
 * EXTRACTION_WORKERS=0 (tests, which run TypeScript sources) parses in the calling thread.
 */
const PARSE_TIMEOUT_MS = 120_000;

let pool: WorkerPool<WorkbookTask, WorkbookReply> | null = null;
const workerUrl = () => new URL(`./workbookWorker${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url);

function parserPool(): WorkerPool<WorkbookTask, WorkbookReply> {
  return (pool ??= new WorkerPool<WorkbookTask, WorkbookReply>({
    url: workerUrl(),
    size: 1,
    timeoutMs: PARSE_TIMEOUT_MS,
    resourceLimits: { maxOldGenerationSizeMb: config.EXTRACTION_WORKER_MAX_MB },
    name: 'Rate workbook parser',
  }));
}

/** Same contract as readRateWorkbook: the parsed tables, or a RateImportError naming the problems. */
export async function parseRateWorkbook(prefix: RateWorkbook, fileName: string, data: Buffer): Promise<ParsedWorkbook> {
  if (config.EXTRACTION_WORKERS === 0) return readRateWorkbook(prefix, fileName, data);
  let reply: WorkbookReply;
  try {
    reply = await parserPool().run({ prefix, fileName, data });
  } catch (err) {
    if (!(err instanceof WorkerTaskError)) throw err;
    logger.warn({ err, reason: err.reason }, 'rate workbook parse failed in its worker');
    throw new RateImportError([
      err.reason === 'out-of-memory'
        ? `${fileName} needs too much memory to read`
        : err.reason === 'timeout'
          ? `${fileName} took too long to read`
          : `${fileName} could not be read`,
    ]);
  }
  if ('problems' in reply) throw new RateImportError(reply.problems);
  return reply.parsed;
}

/** Graceful shutdown: terminate the parser worker. */
export async function stopWorkbookParser(): Promise<void> {
  const current = pool;
  pool = null;
  await current?.stop();
}
