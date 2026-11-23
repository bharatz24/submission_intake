/**
 * Vitest global setup (TEST-05): runs once before any suite. The DB-backed suites DROP and recreate databases on the
 * TEST_DATABASE_URL server, so this refuses a URL whose database name doesn't contain `_test` (a production or
 * development database can never be the target) and fails fast, with one clear message, when that server is down
 * instead of every suite timing out on its own.
 *
 *   TEST_DATABASE_URL  default postgres://ims:ims_dev_password@localhost:5435/ims_test (docker-compose.yml's db)
 *   TEST_DB_REQUIRED   `false` turns "unreachable" into a warning, to run only the DB-free suites without Postgres:
 *                      TEST_DB_REQUIRED=false npx vitest run tests/unit.test.ts
 */
import pg from 'pg';

/** Same default the suites use (tests/helpers/apiTestDb.ts); dev convenience only, and it matches the guard. */
export const DEFAULT_TEST_DATABASE_URL = 'postgres://ims:ims_dev_password@localhost:5435/ims_test';
const TEST_DB_NAME = /_test/;
const CONNECT_TIMEOUT_MS = 5000;

/** The database name in a postgres:// URL, or null when it has none. */
export function databaseName(url: string): string | null {
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    return name || null;
  } catch {
    return null;
  }
}

/** Throws unless `url` names a database that is clearly a test database. */
export function assertTestDatabaseUrl(url: string): void {
  const name = databaseName(url);
  if (!name || !TEST_DB_NAME.test(name))
    throw new Error(
      `TEST_DATABASE_URL must name a test database (its name must contain "_test"); got "${name ?? '(none)'}". ` +
        'The backend suites drop and recreate databases on that server.',
    );
}

/**
 * Stops the run with `message`. Printed and exited rather than thrown: an error thrown from a Vitest global setup is
 * reported through Vite's stack-trace rewriting, which can replace the message with an unrelated TypeError.
 */
function abort(message: string): never {
  console.error(`\n[tests] ${message}\n`);
  process.exit(1);
}

export async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  try {
    assertTestDatabaseUrl(url);
  } catch (err) {
    abort((err as Error).message);
  }

  // The suites connect to the server's `postgres` database to create their own; check exactly that.
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/?]+(\?|$)/, '/postgres$1'),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await admin.connect();
    await admin.query('SELECT 1');
  } catch (err) {
    const { host } = new URL(url);
    const e = err as Error & { code?: string };
    const message =
      `Test database server ${host} is unreachable (${e.code ?? (e.message || e.name)}). ` +
      'Start it with `docker compose up -d db` (repo root) or point TEST_DATABASE_URL at a reachable server. ' +
      'Set TEST_DB_REQUIRED=false to run only the DB-free suites.';
    if (process.env.TEST_DB_REQUIRED === 'false') {
      console.warn(`[tests] ${message}`);
      return;
    }
    abort(message);
  } finally {
    await admin.end().catch(() => undefined);
  }
}
