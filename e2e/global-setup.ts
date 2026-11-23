import { request, type FullConfig } from '@playwright/test';

import { ADMIN } from './tests/credentials';

/**
 * Seeds the admin the smoke tests sign in with: the first registered user becomes the ADMIN. On a database that
 * already has users, registration is refused (409/403) and the existing E2E_ADMIN_* credentials are used as they are.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  const api = await request.newContext({ baseURL });
  const res = await api.post('/api/auth/register', {
    headers: { 'X-Client': 'cli' },
    data: {
      email: ADMIN.email,
      password: ADMIN.password,
      name: 'E2E Admin',
      ...(process.env.SETUP_TOKEN ? { setupToken: process.env.SETUP_TOKEN } : {}),
    },
  });
  if (!res.ok() && ![403, 409].includes(res.status()))
    throw new Error(`Seeding the E2E admin failed: ${res.status()} ${await res.text()}`);
  await api.dispose();
}
