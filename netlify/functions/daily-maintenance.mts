// Daily 03:15 UTC: Gmail reconciliation and retention; on Sundays also the Drive orphan sweep.
import type { Config } from '@netlify/functions';

import { triggerWorker } from '../../backend/dist/runtime/workerTrigger.js';

export default async (): Promise<Response> => {
  await triggerWorker('gmail-reconcile');
  await triggerWorker('retention');
  if (new Date().getUTCDay() === 0) await triggerWorker('drive-orphans');
  return new Response(null, { status: 204 });
};

export const config: Config = { schedule: '15 3 * * *' };
