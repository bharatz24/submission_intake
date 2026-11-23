import { connectLambda } from '@netlify/blobs';

/** The parts of a Netlify Lambda-style event these helpers read and write. */
interface LambdaLikeEvent {
  headers?: Record<string, string | undefined>;
  requestContext?: { identity?: { sourceIp?: string } };
  blobs?: unknown;
}

/** Stands in for a missing client address, so per-IP rate limits group those requests instead of failing. */
export const UNKNOWN_CLIENT_IP = '0.0.0.0';

/**
 * serverless-http takes the request's socket address from `requestContext.identity.sourceIp`, which Netlify events do
 * not carry; Netlify's edge states the connecting client in `x-nf-client-connection-ip` (overwritten there, so a client
 * cannot choose it; `client-ip` under `netlify dev`). Copy it in, so `req.ip` is the real client with TRUST_PROXY=false
 * (rate limits, audit). X-Forwarded-For is dropped: it is not trusted here, and a client can prefix it.
 */
export function setClientAddress<E extends LambdaLikeEvent>(event: E): E {
  const h = event.headers ?? {};
  const ip = h['x-nf-client-connection-ip'] || h['client-ip'] || UNKNOWN_CLIENT_IP;
  event.requestContext = { ...event.requestContext, identity: { ...event.requestContext?.identity, sourceIp: ip } };
  if (event.headers) delete event.headers['x-forwarded-for'];
  return event;
}

/**
 * Lambda-style functions must hand each event to Netlify Blobs before a store is used. Netlify adds the context as
 * `event.blobs`; without it (a local run) Blobs stay unconfigured and only chunked uploads fail, not every request.
 * Lives in the backend so the functions use its copy of @netlify/blobs, the one the chunk store reads.
 */
export function connectBlobs(event: object): void {
  const blobs = (event as LambdaLikeEvent).blobs;
  if (typeof blobs === 'string' && blobs) connectLambda(event as Parameters<typeof connectLambda>[0]);
}
