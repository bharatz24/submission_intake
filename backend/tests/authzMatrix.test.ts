/**
 * Role × route authorization matrix and hostile query parameters (TEST-06), against the real app and its own database
 * (TEST_DATABASE_URL host, database ims_test_authz).
 *
 * Every mutating route the app mounts must appear in ROUTES with the permission it requires: a new route without an
 * entry fails "covers every mutating route". Only 403 vs not-403 is asserted, so a route's own status codes (200,
 * 202, 400, 404 for the random ids used here) can change without touching this file.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Permission } from '../src/permissions.js';
import { makeUser, startTestApp, stopTestApp, testDatabaseUrl } from './helpers/apiTestDb.js';

const DB_NAME = 'ims_test_authz';
process.env.DATABASE_URL = testDatabaseUrl(DB_NAME);

// Nothing here may reach Google, Claude or the NPI registry: a call fails the request loudly instead.
vi.mock('googleapis', () => ({
  google: new Proxy(
    {},
    {
      get: (_t, prop) => {
        throw new Error(`googleapis (google.${String(prop)}) must not be used by the authorization matrix`);
      },
    },
  ),
}));

type Method = 'post' | 'put' | 'patch' | 'delete';
type Role = 'ADMIN' | 'UNDERWRITER' | 'VIEWER';
interface RouteCase {
  method: Method;
  /** The path as declared in its router (relative to /api), e.g. /submissions/:id/fields. */
  path: string;
  /** The permission requirePermission() checks, or null when any signed-in user may call it. */
  permission: Permission | null;
  /** Starts real external work (Gmail, Claude, IMS 2, file imports) when allowed: only the denial is exercised. */
  sideEffects?: boolean;
}

const ROUTES: RouteCase[] = [
  { method: 'post', path: '/submissions/:id/assessments', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/chat', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/email-drafts', permission: 'submission:write' },
  { method: 'put', path: '/submissions/:id/email-drafts/:draftId', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/outbound-emails', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/fields', permission: 'submission:write' },
  { method: 'patch', path: '/submissions/:id/fields/:fieldId', permission: 'submission:write' },
  { method: 'delete', path: '/submissions/:id/fields/:fieldId', permission: 'submission:write' },
  { method: 'post', path: '/gmail/poll', permission: 'gmail:manage', sideEffects: true },
  { method: 'put', path: '/gmail/poll-interval', permission: 'gmail:manage' },
  { method: 'post', path: '/gmail/import', permission: 'gmail:manage', sideEffects: true },
  { method: 'post', path: '/gmail/disconnect', permission: 'gmail:manage', sideEffects: true },
  { method: 'post', path: '/submissions/:id/ims2-queue/send', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/ims2-queue/status/refresh', permission: 'submission:write' },
  { method: 'post', path: '/ims2-queue/sync', permission: 'submission:write', sideEffects: true },
  { method: 'post', path: '/submissions/:id/read', permission: null },
  { method: 'delete', path: '/submissions/:id/read', permission: null },
  { method: 'post', path: '/submissions/:view/read-all', permission: null },
  { method: 'post', path: '/submissions/:view/delete', permission: 'submission:delete' },
  { method: 'delete', path: '/submissions/:id', permission: 'submission:delete' },
  { method: 'post', path: '/ingest-queue/:id/retry', permission: 'submission:write' },
  { method: 'post', path: '/ingest-queue/retry-now', permission: 'gmail:manage', sideEffects: true },
  { method: 'post', path: '/skipped-emails/:id/process', permission: 'submission:write', sideEffects: true },
  { method: 'post', path: '/skipped-emails/delete', permission: 'submission:delete' },
  { method: 'delete', path: '/skipped-emails/:id', permission: 'submission:delete' },
  { method: 'post', path: '/monitoring/errors/clear', permission: 'monitoring:manage' },
  { method: 'post', path: '/submissions/:id/npi/verify', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/npi/manual', permission: 'submission:write' },
  { method: 'delete', path: '/submissions/:id/npi/:verificationId', permission: 'submission:write' },
  { method: 'put', path: '/submissions/:id/npi/:verificationId/override', permission: 'submission:write' },
  { method: 'delete', path: '/submissions/:id/npi/:verificationId/override', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/reprocess', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/retry', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/process', permission: 'submission:write' },
  { method: 'post', path: '/submissions/imported/process-all', permission: 'submission:write', sideEffects: true },
  { method: 'post', path: '/submissions/errors/retry-all', permission: 'submission:write', sideEffects: true },
  { method: 'post', path: '/submissions/:id/extract-text', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/external-results', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/quotes/preview', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/quotes', permission: 'submission:write' },
  { method: 'put', path: '/submissions/:id/primary-rating', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/quotes/:quoteId/review', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/speciality-options', permission: 'submission:write' },
  { method: 'post', path: '/rates/import/:workbook', permission: 'rate:manage', sideEffects: true },
  { method: 'post', path: '/geo/import', permission: 'rate:manage', sideEffects: true },
  { method: 'post', path: '/submissions/:id/synthesis', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/analysis', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/external-report', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/reports/:reportId/review', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/comparisons', permission: 'submission:write' },
  { method: 'put', path: '/settings/anthropic', permission: 'settings:manage', sideEffects: true },
  { method: 'post', path: '/settings/anthropic/test', permission: 'settings:manage', sideEffects: true },
  { method: 'put', path: '/settings/automation', permission: 'settings:manage' },
  { method: 'put', path: '/settings/limits', permission: 'settings:manage' },
  { method: 'put', path: '/settings/retention', permission: 'settings:manage' },
  { method: 'post', path: '/settings/connections/:service/test', permission: 'settings:manage', sideEffects: true },
  { method: 'put', path: '/skills/:name/files', permission: 'skill:edit' },
  { method: 'post', path: '/skills/:name/files/reset', permission: 'skill:edit', sideEffects: true },
  { method: 'post', path: '/submissions/upload', permission: 'submission:write' },
  { method: 'patch', path: '/submissions/:id', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/documents', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/classification', permission: 'submission:write' },
  { method: 'post', path: '/submissions/:id/duplicate', permission: 'submission:write' },
  { method: 'patch', path: '/users/:id', permission: 'user:manage' },
  { method: 'post', path: '/users/:id/password', permission: 'user:manage' },
];

/** Mutating routes outside the signed-in matrix: sign-in itself, browser error reports, Google's Pub/Sub push. */
const PUBLIC_ROUTES = new Set([
  'post /register',
  'post /login',
  'post /logout',
  'post /password', // a user's own password change (auth router)
  'post /client-errors',
  'post /gmail/push',
]);

const ROLE_PERMISSIONS: Record<Role, readonly Permission[] | 'all'> = {
  ADMIN: 'all',
  UNDERWRITER: ['submission:write'],
  VIEWER: [],
};
const allowed = (role: Role, permission: Permission | null) => {
  const granted = ROLE_PERMISSIONS[role];
  return permission === null || granted === 'all' || granted.includes(permission);
};

const PARAM_VALUES: Record<string, () => string> = {
  view: () => 'submissions',
  workbook: () => 'rates',
  service: () => 'drive',
  name: () => 'classification',
};
const concretePath = (path: string) =>
  `/api${path.replace(/:(\w+)/g, (_m, name: string) => (PARAM_VALUES[name] ?? randomUUID)())}`;

/** Every route the app mounts, walking nested routers (Express 5 router internals). */
function mountedRoutes(app: Express): { method: string; path: string }[] {
  type Layer = {
    route?: { path: string; methods: Record<string, boolean> };
    handle?: { stack?: Layer[] };
  };
  const found: { method: string; path: string }[] = [];
  const walk = (stack: Layer[] | undefined) => {
    for (const layer of stack ?? []) {
      if (layer.route)
        for (const [method, on] of Object.entries(layer.route.methods))
          if (on) found.push({ method, path: layer.route.path });
          else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk((app as unknown as { router: { stack: Layer[] } }).router.stack);
  return found;
}

let app: Express;
let pool: pg.Pool;
const auth = {} as Record<Role, { Authorization: string }>;

beforeAll(async () => {
  ({ app, pool } = await startTestApp(DB_NAME));
  for (const role of ['ADMIN', 'UNDERWRITER', 'VIEWER'] as const)
    auth[role] = (await makeUser(pool, `${role.toLowerCase()}@authz.example`, role)).auth;
});

afterAll(async () => {
  await stopTestApp();
});

describe('authorization matrix', () => {
  it('covers every mutating route the app mounts', () => {
    const declared = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    const missing = mountedRoutes(app)
      .filter((r) => ['post', 'put', 'patch', 'delete'].includes(r.method))
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !declared.has(key) && !PUBLIC_ROUTES.has(key));
    expect(missing, 'add these routes (and the permission they require) to ROUTES').toEqual([]);
  });

  const cases = ROUTES.flatMap((r) =>
    (['VIEWER', 'UNDERWRITER', 'ADMIN'] as const)
      .map((role) => ({ ...r, role, expectAllowed: allowed(role, r.permission) }))
      .filter((c) => !(c.expectAllowed && c.sideEffects)),
  );

  it.each(cases)('$role $method $path → $expectAllowed', async ({ method, path, role, expectAllowed }) => {
    const res = await request(app)[method](concretePath(path)).set(auth[role]).send({});
    if (expectAllowed) {
      expect(res.status, JSON.stringify(res.body)).not.toBe(403);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    } else {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }
  });

  it('refuses every mutating route without a session', async () => {
    for (const r of ROUTES) {
      const res = await request(app)[r.method](concretePath(r.path)).send({});
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
  });
});

describe('hostile query parameters', () => {
  const HOSTILE: [string, Record<string, string | string[]>][] = [
    ['/api/submissions', { view: "submissions'; DROP TABLE submissions;--" }],
    ['/api/submissions', { status: 'READY_FOR_REVIEW OR 1=1' }],
    ['/api/submissions', { classification: '../../etc/passwd' }],
    ['/api/submissions', { q: 'x'.repeat(5000) }],
    ['/api/submissions', { q: ['a', 'b'] }],
    ['/api/submissions', { page: '0' }],
    ['/api/submissions', { page: '-1' }],
    ['/api/submissions', { pageSize: '100000' }],
    ['/api/submissions', { pageSize: '1e3' }],
    ['/api/skipped-emails', { pageSize: '-5' }],
    ['/api/skipped-emails', { q: ['x', 'y'] }],
    ['/api/audit', { submissionId: "1' OR '1'='1" }],
    ['/api/audit', { pageSize: '999999' }],
    ['/api/audit', { action: 'a'.repeat(1000) }],
    ['/api/monitoring/stats', { range: 'forever' }],
  ];

  it.each(HOSTILE)('%s %j → 400, not 500', async (path, query) => {
    const res = await request(app).get(path).query(query).set(auth.ADMIN);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it.each([
    ['/api/submissions', { q: "O'Brien\\%_" }],
    ['/api/submissions', { q: '%' }],
    ['/api/skipped-emails', { q: "'); DELETE FROM users;--" }],
    // An unknown time zone is ignored (the server's own day is used), never interpolated into SQL.
    ['/api/monitoring/stats', { tz: "Europe/London'; SELECT pg_sleep(10);--" }],
  ])('%s %j is handled as data (200, no 500)', async (path, query) => {
    const res = await request(app).get(path).query(query).set(auth.ADMIN);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
