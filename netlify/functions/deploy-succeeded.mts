// Netlify event function, run after each successful deploy: load rate tables / ZIP data on a fresh database (what
// server.ts does at startup), then pick up work the previous deploy left unfinished.
import type { Handler } from '@netlify/functions';

import { triggerWorker } from '../../backend/dist/runtime/workerTrigger.js';

export const handler: Handler = async () => {
  await triggerWorker('bootstrap');
  await triggerWorker('recover');
  return { statusCode: 200 };
};
