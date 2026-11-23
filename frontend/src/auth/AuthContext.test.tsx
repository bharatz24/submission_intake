// @vitest-environment jsdom
// A sign-out in one tab must sign every other tab out too, so none keeps showing cached submission data.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../test/msw/api';
import { apiError } from '../test/msw/handlers';
import type { User } from '../types';

vi.mock('../lib/notifications', () => ({ clearNotificationStorage: vi.fn() }));

const { AuthProvider, useAuth } = await import('./AuthContext');
const { clearNotificationStorage } = await import('../lib/notifications');
const { api: client } = await import('../services/api');

const USER = { id: 'u1', email: 'uw@example.com', name: 'Una Writer', role: 'UNDERWRITER' } as User;

function Probe() {
  const { user, initializing, logout } = useAuth();
  if (initializing) return <p>loading</p>;
  return (
    <>
      <p>{user ? `signed in as ${user.email}` : 'signed out'}</p>
      <button type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </>
  );
}

function renderTab(queryClient = new QueryClient()) {
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

/** Resolves with the next message another tab would receive on the auth channel. */
function nextAuthMessage(): Promise<unknown> {
  const other = new BroadcastChannel('auth');
  return new Promise((resolve) => {
    other.onmessage = (e) => {
      resolve(e.data);
      other.close();
    };
  });
}

describe('AuthProvider across tabs', () => {
  let api: ReturnType<typeof serveAuth>;
  // The session restore and the sign-out go over the network (MSW), through the real API client.
  const serveAuth = () => mockApi({ 'GET /auth/me': () => USER, 'POST /auth/logout': () => undefined });
  beforeEach(() => {
    api = serveAuth();
  });
  afterEach(() => vi.clearAllMocks());

  it('tells the other tabs when this one signs out', async () => {
    renderTab();
    await screen.findByText('signed in as uw@example.com');
    const received = nextAuthMessage();
    await act(async () => screen.getByRole('button', { name: 'Sign out' }).click());
    expect(await received).toEqual({ type: 'logout' });
    expect(screen.getByText('signed out')).toBeInTheDocument();
  });

  it('signs out and drops cached data when another tab signs out', async () => {
    const queryClient = renderTab();
    queryClient.setQueryData(['submissions'], [{ id: 's1' }]);
    await screen.findByText('signed in as uw@example.com');

    const otherTab = new BroadcastChannel('auth');
    otherTab.postMessage({ type: 'logout' });
    otherTab.close();

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(queryClient.getQueryData(['submissions'])).toBeUndefined();
    expect(api['POST /auth/logout']).not.toHaveBeenCalled(); // the other tab already signed out on the server
  });
});

describe('AuthProvider when the session expires', () => {
  afterEach(() => vi.clearAllMocks());

  // SEC-09: notification subjects and sender names must not outlive the session on a shared workstation.
  it('signs out and clears the stored notifications on a 401 from any request', async () => {
    mockApi({
      'GET /auth/me': () => USER,
      'GET /submissions/unread-count': () => apiError(401, 'UNAUTHORIZED', 'Session expired'),
    });
    renderTab();
    await screen.findByText('signed in as uw@example.com');
    expect(clearNotificationStorage).not.toHaveBeenCalled();

    await act(async () => {
      await client.unreadCount().catch(() => undefined);
    });

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(clearNotificationStorage).toHaveBeenCalled();
  });

  it('clears stored notifications when the page loads with an expired session', async () => {
    mockApi({ 'GET /auth/me': () => apiError(401, 'UNAUTHORIZED', 'Session expired') });
    renderTab();
    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(clearNotificationStorage).toHaveBeenCalled();
  });
});
