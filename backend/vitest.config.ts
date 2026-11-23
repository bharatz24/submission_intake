import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      // Tests never load the developer's backend/.env (real Google credentials): dotenv/config reads this path,
      // which does not exist. Drive itself is faked per suite (tests/helpers/fakeDrive.ts or a mocked googleapis).
      DOTENV_CONFIG_PATH: '.env.test-does-not-exist',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REFRESH_TOKEN: 'test-refresh-token',
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      ENCRYPTION_KEY: 'test-encryption-key-test-encryption-key',
      AUTO_REPORTS: 'false', // API tests start reports explicitly and assert on their versions
      LOG_LEVEL: 'silent',
      // Vitest runs TypeScript sources, which a worker thread cannot load: documents are parsed in-thread.
      // tests/workerPool.test.ts covers the worker pool itself.
      EXTRACTION_WORKERS: '0',
      // An edited applied migration fails the test run instead of only being logged.
      MIGRATION_CHECKSUM_CHECK: 'fail',
      // One client IP makes every request in a suite; the production limits would turn later tests into 429s.
      API_RATE_LIMIT_PER_MIN: '100000',
      LOGIN_RATE_LIMIT_PER_15MIN: '100000',
      LOGIN_ACCOUNT_RATE_LIMIT_PER_15MIN: '100000',
      LOGIN_ACCOUNT_TOTAL_RATE_LIMIT_PER_15MIN: '100000',
    },
    // TEST-05: refuses a TEST_DATABASE_URL that does not name a `_test` database, and fails fast when it is down.
    globalSetup: ['./tests/helpers/globalSetup.ts'],
    testTimeout: 30000,
    hookTimeout: 180000,
    fileParallelism: false,
    // `npm run test:coverage` (QA-009): a summary in the terminal, the full report in coverage/index.html.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/evals/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
      // TEST-02 floor, a little under the measured baseline (2026-11-18: 75.7 / 65.7 / 76.9 / 77.8 %, taken while some
      // DB suites were failing, so the real figure is higher). Raise it as coverage grows; never lower it to pass.
      thresholds: { statements: 73, branches: 63, functions: 74, lines: 75 },
    },
  },
});
