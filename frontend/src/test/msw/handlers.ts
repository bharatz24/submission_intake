import { http, HttpResponse } from 'msw';

/** The API base in tests (vite.config.ts test.env VITE_API_BASE). */
export const API = 'http://localhost/api';

/** `url('/submissions/:id')` → the absolute pattern MSW matches against. */
export const url = (path: string) => `${API}${path}`;

/**
 * Endpoints most screens touch in the background (status dots, error reports). Each test declares the endpoints
 * it is about with `server.use(...)`.
 */
export const handlers = [http.post(url('/client-errors'), () => new HttpResponse(null, { status: 204 }))];

/** The API's error envelope, for handlers that fail. */
export const apiError = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message, requestId: 'test-request' } }, { status });
