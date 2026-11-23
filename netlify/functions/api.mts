// The Express API as one Netlify function: /api/* is rewritten here (netlify.toml), same origin as the SPA.
import type { Handler, HandlerResponse } from '@netlify/functions';
import serverless from 'serverless-http';

import { createApp } from '../../backend/dist/app.js';
import { connectBlobs, setClientAddress } from '../../backend/dist/runtime/lambdaEvent.js';
import { ensureAllSettingsFresh, initNetlifyRuntime } from '../../backend/dist/runtime/netlifyInit.js';

const app = createApp();
// Responses are base64-encoded for Lambda, so binary downloads arrive intact; requests are decoded by serverless-http.
const handle = serverless(app, { binary: true });

export const handler: Handler = async (event, context) => {
  connectBlobs(event); // Netlify Blobs (chunked uploads) in a Lambda-style function
  await initNetlifyRuntime();
  await ensureAllSettingsFresh();
  // The client's address from Netlify's edge, as the socket address Express sees (TRUST_PROXY stays false).
  return (await handle(setClientAddress(event), context)) as HandlerResponse;
};
