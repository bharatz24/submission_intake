/** The seeded admin (global-setup.ts). Override for a stack whose admin already exists. */
export const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.com',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e-correct-horse-battery-staple',
} as const;
