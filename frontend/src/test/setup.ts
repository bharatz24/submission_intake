/// <reference types="node" />
// Vitest setup: jest-dom matchers, DOM cleanup between tests, and the MSW network (src/test/msw).
import '@testing-library/jest-dom/vitest';

import { File as NodeFile } from 'node:buffer';

import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { server } from './msw/server';

// FE-07: findBy*/waitFor give up after 1 s by default, which a loaded machine (the full parallel run, a CI runner)
// overruns while MUI renders its first frame. A failing assertion still fails; it just waits a little longer.
configure({ asyncUtilTimeout: 5_000 });

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  // A request no handler answers fails the test (MSW 3 calls requests and socket messages "frames").
  server.listen({ onUnhandledFrame: 'error' });
  if (typeof window !== 'undefined') await bridgeJsdomUploads();
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  server.close();
});

/**
 * In jsdom tests, FormData and File are jsdom's while fetch is Node's, which cannot send them: an upload would never
 * leave the app. Copy a jsdom FormData body into Node's FormData (files included) before the request goes out, so
 * uploads cross the mocked network like any other request. Installed after MSW, so MSW sees the converted request.
 */
async function bridgeJsdomUploads(): Promise<void> {
  const NodeFormData = (await new Response(new URLSearchParams('x=1')).formData()).constructor as new () => FormData;
  const intercepted = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    if (body instanceof FormData && body.constructor !== NodeFormData) {
      const copy = new NodeFormData();
      for (const [key, value] of body.entries()) {
        if (typeof value === 'string') copy.append(key, value);
        else
          copy.append(
            key,
            new NodeFile([new Uint8Array(await readBytes(value))], value.name, { type: value.type }) as unknown as Blob,
            value.name,
          );
      }
      // Serialised up front: a streamed multipart body trips the interceptor's content-length check.
      const encoded = new Request('http://localhost/', { method: 'POST', body: copy });
      const headers = new Headers(init?.headers);
      headers.set('Content-Type', encoded.headers.get('Content-Type')!);
      return intercepted(input, { ...init, headers, body: new Uint8Array(await encoded.arrayBuffer()) });
    }
    return intercepted(input, init);
  };
}

function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}
