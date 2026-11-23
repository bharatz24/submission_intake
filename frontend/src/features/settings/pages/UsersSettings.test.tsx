// @vitest-environment jsdom
// User management (admins): change a role, and disable an account after confirming, with the server's refusal
// shown inside the confirm dialog.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import { apiError } from '../../../test/msw/handlers';

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin-1', name: 'Ada Admin', email: 'ada@example.test', role: 'ADMIN' } }),
}));

const { UsersSettings } = await import('./UsersSettings');

const account = (over: Record<string, unknown> = {}) => ({
  id: 'u2',
  name: 'Uma Writer',
  email: 'uma@example.test',
  role: 'UNDERWRITER',
  createdAt: '2026-01-02T10:00:00Z',
  disabledAt: null as string | null,
  passwordChangedAt: null,
  isDefaultAdmin: false,
  ...over,
});

let accounts: ReturnType<typeof account>[];
let api: ReturnType<typeof serve>;
const serve = (patch: (body: Record<string, unknown>) => unknown) =>
  mockApi({
    'GET /users': () => accounts,
    'PATCH /users/:id': ({ body }) => patch(body as Record<string, unknown>),
  });

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <UsersSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UsersSettings', () => {
  beforeEach(() => {
    accounts = [
      account({ id: 'admin-1', name: 'Ada Admin', email: 'ada@example.test', role: 'ADMIN' }),
      account(),
      account({ id: 'root', name: 'Default Admin', email: 'root@example.test', role: 'ADMIN', isDefaultAdmin: true }),
    ];
    api = serve((body) => {
      const updated = { ...accounts[1]!, ...body };
      if ('disabled' in body) updated.disabledAt = body.disabled ? '2026-11-18T10:00:00Z' : null;
      return updated;
    });
  });

  it('lists the other accounts, not the signed-in admin, and locks the default admin', async () => {
    renderPage();
    expect(await screen.findByText('Uma Writer')).toBeInTheDocument();
    expect(screen.queryByText('ada@example.test')).toBeNull();
    const locked = screen.getByText('Default Admin').closest('tr') as HTMLElement;
    expect(within(locked).getByText('Cannot be modified')).toBeInTheDocument();
  });

  it('changes a role', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('combobox', { name: 'Role of Uma Writer' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Viewer' }));
    await vi.waitFor(() => expect(api['PATCH /users/:id']).toHaveBeenCalledTimes(1));
    const call = api['PATCH /users/:id'].mock.calls[0]![0];
    expect(call.params.id).toBe('u2');
    expect(call.body).toEqual({ role: 'VIEWER' });
  });

  it('disables an account only after confirming', async () => {
    renderPage();
    const row = (await screen.findByText('Uma Writer')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable account?' });
    expect(api['PATCH /users/:id']).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await vi.waitFor(() => expect(api['PATCH /users/:id']).toHaveBeenCalledTimes(1));
    expect(api['PATCH /users/:id'].mock.calls[0]![0].body).toEqual({ disabled: true });
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Disable account?' })).toBeNull());
  });

  it('keeps the confirm dialog open with the reason when disabling is refused', async () => {
    api = serve(() => apiError(409, 'LAST_ADMIN', 'At least one administrator must stay active.'));
    renderPage();
    const row = (await screen.findByText('Uma Writer')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable account?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    expect(await within(dialog).findByText('At least one administrator must stay active.')).toBeInTheDocument();
  });
});
