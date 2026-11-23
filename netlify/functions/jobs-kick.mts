// Every minute: requeue orphaned work and drain due retries and lapsed jobs. Only triggers the worker (30 s limit here).
import type { Config } from '@netlify/functions';

import { triggerWorker } from '../../backend/dist/runtime/workerTrigger.js';

export default async (): Promise<Response> => {
  await triggerWorker('recover');
  return new Response(null, { status: 204 });
};

export const config: Config = { schedule: '* * * * *' };
