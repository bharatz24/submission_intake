import { http, HttpResponse, type JsonBodyType } from 'msw';
import { type Mock, vi } from 'vitest';

import { apiError, url } from './handlers';
import { server } from './server';

/** What a route handler sees: path params, query string and the parsed JSON (or text / FormData) body. */
export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  request: Request;
}
export type RouteHandler = (ctx: RouteContext) => unknown;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Answer API endpoints over the (MSW) network for one test: `mockApi({ 'GET /submissions/:id': () => detail })`.
 * A handler returns the JSON body, a `Response` (e.g. `apiError(...)`) or nothing (204). Each handler is a `vi.fn`,
 * so a test asserts on the requests the app really sent: `expect(api['POST /submissions/:id/reprocess']).toHaveBeenCalled()`.
 * A handler that throws answers 400 with the error's message, as the API would refuse the request.
 *
 * Handlers are reset after every test (test/setup.ts): call this in `beforeEach` or in the test itself.
 */
export function mockApi<R extends Record<string, RouteHandler>>(routes: R): { [K in keyof R]: Mock<RouteHandler> } {
  const mocks = {} as { [K in keyof R]: Mock<RouteHandler> };
  for (const key of Object.keys(routes) as (keyof R & string)[]) {
    const [method, path] = key.split(' ') as [string, string];
    const mock = vi.fn(routes[key]!);
    mocks[key] = mock;
    server.use(
      http[method.toLowerCase() as Method](url(path), async ({ request, params }) => {
        let result: unknown;
        try {
          result = await mock({
            params: params as Record<string, string>,
            query: new URL(request.url).searchParams,
            body: await readBody(request),
            request,
          });
        } catch (err) {
          // A handler that throws (e.g. a vi.fn programmed with mockRejectedValue) is the server refusing the request.
          return apiError(400, 'BAD_REQUEST', err instanceof Error ? err.message : String(err));
        }
        if (result instanceof Response) return result;
        if (result === undefined) return new HttpResponse(null, { status: 204 });
        return HttpResponse.json(result as JsonBodyType);
      }),
    );
  }
  return mocks;
}

async function readBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('multipart/form-data'))
    return parseMultipart(new Uint8Array(await request.clone().arrayBuffer()), type);
  const text = await request.clone().text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The body of the `n`th call of a mocked route. */
export const bodyOf = (mock: Mock<RouteHandler>, n = 0): unknown =>
  (mock.mock.calls[n]?.[0] as RouteContext | undefined)?.body;
/** The query string of the `n`th call of a mocked route. */
export const queryOf = (mock: Mock<RouteHandler>, n = 0): URLSearchParams | undefined =>
  (mock.mock.calls[n]?.[0] as RouteContext | undefined)?.query;

/**
 * A small multipart/form-data parser for test uploads. The fetch implementation's own formData() cannot run under
 * jsdom (it builds files with jsdom's File class), and test files are a few bytes, so parsing them here is enough.
 */
function parseMultipart(bytes: Uint8Array, contentType: string): FormData {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const form = new FormData();
  if (!boundary) return form;
  const text = new TextDecoder('latin1').decode(bytes);
  for (const part of text.split(`--${boundary[1] ?? boundary[2]}`)) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = part.slice(0, split);
    const value = part.slice(split + 4).replace(/\r\n$/, '');
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename === undefined) {
      form.append(name, value);
      continue;
    }
    const fileType = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? '';
    const raw = Uint8Array.from(value, (c) => c.charCodeAt(0));
    form.append(name, new File([raw], filename, { type: fileType }));
  }
  return form;
}
