/** Worker-thread entry for text extraction (started by extractionPool.ts; one file at a time). */
import { parentPort } from 'node:worker_threads';

import { type ExtractionLimits, type ExtractionResult, extractText } from './textExtraction.js';
import { serveTasks } from './workerPool.js';

export interface ExtractionTask {
  /** The file's bytes (a Buffer arrives as a plain Uint8Array). */
  data: Uint8Array;
  filename: string;
  mimeType: string;
  limits: ExtractionLimits;
  documentId?: string;
}

if (parentPort) {
  serveTasks<ExtractionTask, ExtractionResult>(parentPort, (task) =>
    extractText(
      Buffer.from(task.data.buffer, task.data.byteOffset, task.data.byteLength),
      task.filename,
      task.mimeType,
      task.limits,
      task.documentId,
    ),
  );
}
