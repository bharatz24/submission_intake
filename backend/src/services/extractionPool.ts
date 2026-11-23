import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ExtractionTask } from './extractionWorker.js';
import { currentJobSignal } from './jobContext.js';
import { extractionLimits, type ExtractionResult, extractText, stopOcr } from './textExtraction.js';
import { WorkerPool, WorkerTaskError } from './workerPool.js';

/**
 * Document text extraction off the main thread. PDF, DOCX, XLSX, zip parsing and OCR run in a pool of worker threads,
 * each with a heap limit (EXTRACTION_WORKER_MAX_MB) and a hard deadline (EXTRACTION_WORKER_TIMEOUT_MS): a hostile or
 * pathological file can stall or kill only its worker, never the API's event loop or the process. The worker is then
 * replaced and the document gets an ERROR result.
 *
 * EXTRACTION_WORKERS=0 parses in the calling thread (unit tests, which run TypeScript sources without a loader).
 */

let pool: WorkerPool<ExtractionTask, ExtractionResult> | null = null;

/** The worker entry next to this module: .js when built, .ts under tsx (workers inherit tsx's loader). */
const workerUrl = () => new URL(`./extractionWorker${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url);

function extractionPool(): WorkerPool<ExtractionTask, ExtractionResult> {
  return (pool ??= new WorkerPool<ExtractionTask, ExtractionResult>({
    url: workerUrl(),
    size: config.EXTRACTION_WORKERS,
    timeoutMs: config.EXTRACTION_WORKER_TIMEOUT_MS,
    resourceLimits: { maxOldGenerationSizeMb: config.EXTRACTION_WORKER_MAX_MB },
    name: 'Text extraction',
  }));
}

/**
 * Text of one stored document; never throws. `signal` defaults to the lease signal of the job this runs in
 * (jobContext.ts): a job taken over by another worker terminates its parse or OCR instead of finishing it for nothing.
 */
export async function extractDocumentText(
  data: Buffer,
  file: { documentId: string; filename: string; mimeType: string },
  signal: AbortSignal | undefined = currentJobSignal(),
): Promise<ExtractionResult> {
  const { documentId, filename, mimeType } = file;
  const limits = extractionLimits();
  if (config.EXTRACTION_WORKERS === 0) return extractText(data, filename, mimeType, limits, documentId);
  try {
    return await extractionPool().run({ data, filename, mimeType, limits, documentId }, signal);
  } catch (err) {
    const reason = err instanceof WorkerTaskError ? err.reason : 'crashed';
    // The document id, never its filename (which often names the applicant).
    logger.warn({ err, documentId, reason }, 'extraction worker failed');
    return {
      status: 'ERROR',
      text: '',
      ocrUsed: false,
      pageCount: null,
      error: err instanceof Error ? err.message : String(err),
      // A timeout may be load, and a shutdown or an aborted job says nothing about the file: a later run reads it
      // again. Running out of memory or crashing would happen again on the same file.
      ...(reason === 'timeout' || reason === 'stopped' || reason === 'aborted' ? { transient: true } : {}),
    };
  }
}

/** Graceful shutdown: terminate the extraction workers (and the in-thread OCR worker, if one was started). */
export async function stopExtraction(): Promise<void> {
  const current = pool;
  pool = null;
  await Promise.all([current?.stop(), stopOcr()]);
}
