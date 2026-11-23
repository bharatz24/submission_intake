/** Worker-thread entry that parses one uploaded rate workbook (started by workbookParser.ts). */
import { parentPort } from 'node:worker_threads';

import { serveTasks } from '../workerPool.js';
import { type ParsedWorkbook, RateImportError, type RateWorkbook, readRateWorkbook } from './importer.js';

export interface WorkbookTask {
  prefix: RateWorkbook;
  fileName: string;
  /** The upload's bytes (a Buffer arrives as a plain Uint8Array). */
  data: Uint8Array;
}
/** The parsed tables, or the import problems (a RateImportError does not survive the thread boundary as a class). */
export type WorkbookReply = { parsed: ParsedWorkbook } | { problems: string[] };

if (parentPort) {
  serveTasks<WorkbookTask, WorkbookReply>(parentPort, async (task) => {
    try {
      const data = Buffer.from(task.data.buffer, task.data.byteOffset, task.data.byteLength);
      return { parsed: await readRateWorkbook(task.prefix, task.fileName, data) };
    } catch (err) {
      if (err instanceof RateImportError) return { problems: err.problems };
      throw err;
    }
  });
}
