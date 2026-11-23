// Background worker (15-minute limit): drains the job table and runs the periodic tasks (runtime/workerTasks.ts).
// Only callable with WORKER_TOKEN: the functions and the API trigger it (runtime/workerTrigger.ts).
import type { Handler } from '@netlify/functions';

import { config } from '../../backend/dist/config.js';
import { logger } from '../../backend/dist/logger.js';
import { connectBlobs } from '../../backend/dist/runtime/lambdaEvent.js';
import { ensureAllSettingsFresh, initNetlifyRuntime } from '../../backend/dist/runtime/netlifyInit.js';
import { runWorkerTask } from '../../backend/dist/runtime/workerTasks.js';
import { isWorkerTask } from '../../backend/dist/runtime/workerTrigger.js';
import { safeEqual } from '../../backend/dist/services/crypto.js';

export const handler: Handler = async (event) => {
  // A background function's answer never reaches the caller (it got 202): refusals are logged, not answered.
  const given = event.headers['x-worker-token'] ?? '';
  if (!config.WORKER_TOKEN || !safeEqual(given, config.WORKER_TOKEN)) {
    logger.warn('worker trigger refused: bad or missing x-worker-token');
    return { statusCode: 401 };
  }
  let body: { task?: unknown; actor?: { id: string; name: string } };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    body = JSON.parse(raw || '{}');
  } catch {
    logger.warn('worker trigger refused: body is not JSON');
    return { statusCode: 400 };
  }
  if (!isWorkerTask(body.task)) {
    logger.warn({ task: String(body.task) }, 'worker trigger refused: unknown task');
    return { statusCode: 400 };
  }
  connectBlobs(event); // the retention task reads the chunk store
  try {
    await initNetlifyRuntime();
    await ensureAllSettingsFresh();
    await runWorkerTask(body.task, body.actor ? { actor: body.actor } : {});
  } catch (err) {
    logger.error({ err, task: body.task }, 'worker task failed');
    return { statusCode: 500 };
  }
  return { statusCode: 200 };
};
