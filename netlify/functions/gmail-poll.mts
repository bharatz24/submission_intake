// Every minute: poll Gmail (honours Settings → Monitoring "off"). Remove once Pub/Sub push is configured.
import type { Config } from '@netlify/functions';

import { triggerWorker } from '../../backend/dist/runtime/workerTrigger.js';

export default async (): Promise<Response> => {
  await triggerWorker('gmail-poll');
  return new Response(null, { status: 204 });
};

export const config: Config = { schedule: '* * * * *' };
