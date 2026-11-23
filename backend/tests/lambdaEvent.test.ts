/** Netlify Lambda events (runtime/lambdaEvent.ts): the client IP Express sees, and the Blobs context. */
import { describe, expect, it, vi } from 'vitest';

const connectLambda = vi.hoisted(() => vi.fn());
vi.mock('@netlify/blobs', () => ({ connectLambda }));

const { connectBlobs, setClientAddress, UNKNOWN_CLIENT_IP } = await import('../src/runtime/lambdaEvent.js');

describe('setClientAddress', () => {
  it("uses Netlify's x-nf-client-connection-ip, never a client-sent X-Forwarded-For", () => {
    const e = setClientAddress({
      headers: { 'x-nf-client-connection-ip': '198.51.100.4', 'x-forwarded-for': '10.0.0.1, 198.51.100.4' },
    });
    expect(e.requestContext?.identity?.sourceIp).toBe('198.51.100.4');
    expect(e.headers?.['x-forwarded-for']).toBeUndefined(); // not trusted, so not passed on
  });

  it('falls back to client-ip (netlify dev), then a placeholder instead of undefined', () => {
    expect(setClientAddress({ headers: { 'client-ip': '127.0.0.1' } }).requestContext?.identity?.sourceIp).toBe(
      '127.0.0.1',
    );
    expect(setClientAddress({ headers: {} }).requestContext?.identity?.sourceIp).toBe(UNKNOWN_CLIENT_IP);
  });
});

describe('connectBlobs', () => {
  it('connects only when Netlify supplied the Blobs context', () => {
    connectBlobs({ headers: {} });
    expect(connectLambda).not.toHaveBeenCalled();
    connectBlobs({ blobs: 'eyJ1cmwiOiJ4In0=', headers: {} });
    expect(connectLambda).toHaveBeenCalledTimes(1);
  });
});
