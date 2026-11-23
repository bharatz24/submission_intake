/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * The CSP meta tag in index.html: removed on the dev server (React Refresh injects an inline script, HMR uses a
 * websocket); in a build, an absolute VITE_API_BASE adds its origin to connect-src.
 */
function cspPlugin(apiBase: string | undefined): Plugin {
  const CSP = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"\s*\/?>/;
  return {
    name: 'csp-meta',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (ctx.server) return html.replace(CSP, '');
        const origin = apiBase && /^https?:\/\//.test(apiBase) ? new URL(apiBase).origin : null;
        return origin
          ? html.replace(CSP, (tag, policy: string) =>
              tag.replace(policy, policy.replace("connect-src 'self'", `connect-src 'self' ${origin}`)),
            )
          : html;
      },
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // Follow the backend's own PORT so a custom value in backend/.env can't leave the proxy pointing at nothing.
  // Only the dev server needs it. loadEnv() copies a NODE_ENV it finds into VITE_USER_NODE_ENV, which Vite then
  // applies to this build, so a NODE_ENV=development in backend/.env would otherwise turn `vite build` into a
  // development build (jsxDEV, absolute source paths). Restore the variable after reading the backend file.
  const userNodeEnv = process.env.VITE_USER_NODE_ENV;
  const backendEnv = command === 'serve' ? loadEnv(mode, '../backend', 'PORT') : {};
  if (userNodeEnv === undefined) delete process.env.VITE_USER_NODE_ENV;
  else process.env.VITE_USER_NODE_ENV = userNodeEnv;
  const backendPort = process.env.BACKEND_PORT ?? backendEnv.PORT ?? 3002;

  return {
    plugins: [react(), cspPlugin(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_BASE ?? process.env.VITE_API_BASE)],
    server: {
      port: Number(process.env.FRONTEND_PORT ?? 5174),
      strictPort: true,
      proxy: {
        '/api': { target: `http://localhost:${backendPort}`, changeOrigin: true },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router'],
            mui: ['@mui/material', '@emotion/react', '@emotion/styled'],
            markdown: ['react-markdown', 'remark-gfm'],
          },
        },
      },
    },
    test: {
      // Plain .ts tests run in node; component tests opt in with a `@vitest-environment jsdom` docblock.
      environment: 'node',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
      // An absolute API base, so Node's fetch accepts the URLs and MSW (src/test/msw) can answer them.
      env: { VITE_API_BASE: 'http://localhost/api' },
      // FE-07: each test file gets a fresh worker with its own jsdom + MUI import. With the default pool (forks: one
      // process per file, ~5 s startup on Windows) at full parallelism, forks missed Vitest's fixed 60 s start
      // handshake on a busy machine and slow MSW-backed tests overran the 5 s test timeout. Threads start far faster
      // and isolate per file all the same; the run is capped at half the cores, with timeouts sized for a loaded
      // machine (a CI runner included). src/test/setup.ts raises Testing Library's findBy/waitFor wait to match.
      pool: 'threads',
      maxWorkers: '50%',
      testTimeout: 20_000,
      hookTimeout: 30_000,
      teardownTimeout: 15_000,
      // `npm run test:coverage` (QA-009): a summary in the terminal, the full report in coverage/index.html.
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts', 'src/main.tsx'],
        reporter: ['text-summary', 'html', 'lcov'],
        // TEST-02 floor, a little under the measured baseline (2026-11-18: 66.1 / 54.8 / 55.0 / 67.1 %). Raise it as
        // coverage grows; never lower it to make a change pass.
        thresholds: { statements: 64, branches: 52, functions: 53, lines: 65 },
      },
    },
  };
});
