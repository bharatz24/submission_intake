import { expect, test } from '@playwright/test';

import { ADMIN } from './credentials';

// Smoke path through the real SPA, API and database (TEST-03): what must work after every deploy.
test.describe('smoke', () => {
  test('the login page renders', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('an admin signs in, sees the inbox, opens a submission and signs out', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    const inboxLoaded = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/submissions' && r.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('heading', { name: 'Submission Inbox' })).toBeVisible();
    expect((await inboxLoaded).ok()).toBe(true);

    // A fresh database has no submissions; open one only when the stack under test has some.
    const firstRow = page.locator('tbody tr').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click();
      await expect(page).toHaveURL(/\/submissions\//);
      await page.goBack();
      await expect(page.getByRole('heading', { name: 'Submission Inbox' })).toBeVisible();
    }

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});
