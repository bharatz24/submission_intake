import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke E2E (TEST-03). Two ways to run:
 *  - E2E_BASE_URL set (e.g. http://127.0.0.1:8080, the docker-compose.prod.yml stack): tests run against it as is.
 *  - otherwise the built apps are started here: the API (`node dist/server.js`, backend/ built with `npm run build`)
 *    on E2E_API_PORT against E2E_DATABASE_URL, and the SPA (`vite preview`, frontend/ built) proxying /api to it.
 * The first user registered becomes the admin (global-setup.ts), so point E2E_DATABASE_URL at a throwaway database.
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 3102);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const EXTERNAL = process.env.E2E_BASE_URL;
const BASE_URL = EXTERNAL ?? `http://127.0.0.1:${WEB_PORT}`;
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://ims:ims_dev_password@localhost:5435/ims_e2e_test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: EXTERNAL
    ? undefined
    : [
        {
          name: 'api',
          command: 'node dist/server.js',
          cwd: '../backend',
          url: `http://127.0.0.1:${API_PORT}/api/ready`,
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
          stdout: 'pipe',
          env: {
            NODE_ENV: 'development', // plain-HTTP cookies; MIGRATE_ON_BOOT migrates the throwaway database
            PORT: String(API_PORT),
            DATABASE_URL,
            // Never the developer's backend/.env (real Google credentials): fake values, nothing external is called.
            DOTENV_CONFIG_PATH: '.env.e2e-does-not-exist',
            JWT_SECRET: 'e2e-only-secret-e2e-only-secret-e2e-1',
            ENCRYPTION_KEY: 'e2e-only-encryption-key-e2e-only-encryption-key',
            GOOGLE_CLIENT_ID: 'e2e',
            GOOGLE_CLIENT_SECRET: 'e2e',
            GOOGLE_REFRESH_TOKEN: 'e2e',
            FRONTEND_ORIGIN: BASE_URL,
            AUTO_REPORTS: 'false',
            LOG_LEVEL: 'warn',
          },
        },
        {
          name: 'web',
          command: `npx vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
          cwd: '../frontend',
          url: BASE_URL,
          timeout: 60_000,
          reuseExistingServer: !process.env.CI,
          env: { BACKEND_PORT: String(API_PORT) }, // vite preview reuses server.proxy: /api → the API above
        },
      ],
});
