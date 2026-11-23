// Netlify build step: apply pending migrations before the new functions go live (forward-only; docs/deploy.md).
// Runs as the migrator role from MIGRATOR_DATABASE_URL (a Builds-scoped variable), never the app role.
// The migrator needs no application secret, but backend/src/config.ts requires a few at load: inert placeholders are
// set for those, here only, so no real secret has to be given to the build.
import { randomBytes } from 'node:crypto';

const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) {
  console.error(
    'MIGRATOR_DATABASE_URL is not set (Netlify → Site configuration → Environment variables, scope Builds)',
  );
  process.exit(1);
}
const inert = randomBytes(32).toString('base64');
Object.assign(process.env, {
  DATABASE_URL: url,
  NODE_ENV: 'development', // production-only checks are about the API's secrets and URLs, unused here
  MIGRATION_CHECKSUM_CHECK: 'fail', // an edited applied migration stops the deploy
  JWT_SECRET: process.env.JWT_SECRET || `build-${inert}`,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || `base64:${inert}`,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || 'unused-by-migrations',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || 'unused-by-migrations',
  GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN || 'unused-by-migrations',
});

const { migrate } = await import('../backend/dist/db/migrate.js');
const { closePools } = await import('../backend/dist/db/pool.js');
try {
  const ran = await migrate();
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database up to date');
} finally {
  await closePools();
}
