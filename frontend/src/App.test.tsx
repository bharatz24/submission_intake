// @vitest-environment jsdom
// RequireAuth contract: unauthenticated users go to /login (remembering where they were going), a session that is
// still being restored shows a loader, and an authenticated user sees the protected layout.
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  state: { user: null as unknown, initializing: false, restoreError: null as unknown, retryRestore: () => {} },
}));

vi.mock('./auth/AuthContext', () => ({ useAuth: () => auth.state }));
vi.mock('./auth/LoginPage', () => ({
  LoginPage: function LoginStub() {
    const location = useLocation();
    return <div>login page from {(location.state as { from?: string } | null)?.from ?? 'nowhere'}</div>;
  },
}));
vi.mock('./components/Layout', () => ({
  Layout: () => (
    <div>
      protected layout
      <Outlet />
    </div>
  ),
}));
vi.mock('./components/notifications/NotificationProvider', () => ({
  NotificationProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('./features/submissions/pages/SubmissionInbox', () => ({ SubmissionInbox: () => <div>inbox</div> }));
vi.mock('./features/submissions/pages/SubmissionWorkspace', () => ({
  SubmissionWorkspace: () => <div>workspace</div>,
}));
vi.mock('./features/audit/AuditTrail', () => ({ AuditTrail: () => <div>audit</div> }));
vi.mock('./features/settings/pages/MonitoringPage', () => ({ MonitoringPage: () => <div>monitoring</div> }));
vi.mock('./features/settings/pages/SettingsPage', () => ({ SettingsPage: () => <div>settings</div> }));
vi.mock('./features/settings/pages/UsersSettings', () => ({ UsersSettings: () => <div>users</div> }));
vi.mock('./components/RouteErrorPage', () => ({ RouteErrorPage: () => <div>route error</div> }));
vi.mock('./features/submissions/pages/DocumentsPage', () => ({ DocumentsPage: () => <div>documents</div> }));
vi.mock('./components/common', () => ({
  Loading: ({ label }: { label?: string }) => <div>{label ?? 'Loading'}</div>,
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  ErrorState: ({ title }: { title?: string }) => <div>{title ?? 'error'}</div>,
}));

const { routes } = await import('./App');

// Pages are lazy route modules, so assertions on them wait (findBy…).
const renderAt = (path: string) =>
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />);

describe('RequireAuth', () => {
  beforeEach(() => {
    auth.state = { user: null, initializing: false, restoreError: null, retryRestore: () => {} };
  });

  it('redirects an unauthenticated user to /login and remembers the requested page', async () => {
    renderAt('/submissions/abc?tab=fields');
    expect(await screen.findByText('login page from /submissions/abc?tab=fields')).toBeInTheDocument();
    expect(screen.queryByText('protected layout')).not.toBeInTheDocument();
  });

  it('shows a loader, not the login page, while the session is being restored', async () => {
    auth.state.initializing = true;
    renderAt('/audit');
    expect(await screen.findByText('Restoring session…')).toBeInTheDocument();
    expect(screen.queryByText(/login page/)).not.toBeInTheDocument();
  });

  it('offers a retry instead of signing out when the session could not be checked', async () => {
    auth.state.restoreError = new Error('network down');
    renderAt('/audit');
    expect(await screen.findByText('Cannot reach the server')).toBeInTheDocument();
    expect(screen.queryByText(/login page/)).not.toBeInTheDocument();
  });

  it('renders the protected route for a signed-in user', async () => {
    auth.state.user = { id: 'u1', email: 'a@b.test', name: 'A', role: 'ADMIN' };
    renderAt('/audit');
    expect(await screen.findByText('audit')).toBeInTheDocument();
    expect(screen.getByText('protected layout')).toBeInTheDocument();
  });

  it('keeps Monitoring and the Audit Trail for roles with their permission', async () => {
    auth.state.user = { id: 'u2', email: 'uw@b.test', name: 'U', role: 'UNDERWRITER' };
    for (const path of ['/audit', '/monitoring']) {
      const { unmount } = renderAt(path);
      expect(await screen.findByText('Not available for your role')).toBeInTheDocument();
      expect(screen.queryByText(path.slice(1))).not.toBeInTheDocument();
      unmount();
    }
  });

  it('gates Users at the route (FE-14) but keeps Settings open to every role', async () => {
    auth.state.user = { id: 'u3', email: 'v@b.test', name: 'V', role: 'VIEWER' };
    const users = renderAt('/settings/users');
    expect(await screen.findByText('Not available for your role')).toBeInTheDocument();
    expect(screen.queryByText('users')).not.toBeInTheDocument();
    users.unmount();

    renderAt('/settings');
    expect(await screen.findByText('settings')).toBeInTheDocument();
  });

  it('shows each page under the layout and an in-layout not-found page', async () => {
    auth.state.user = { id: 'u1', email: 'a@b.test', name: 'A', role: 'ADMIN' };
    for (const [path, text] of [
      ['/', 'inbox'],
      ['/submissions/abc', 'workspace'],
      ['/monitoring', 'monitoring'],
      ['/settings', 'settings'],
      ['/settings/users', 'users'],
      ['/documents', 'documents'],
      ['/no-such-page', 'Page not found'],
    ] as [string, string][]) {
      const { unmount } = renderAt(path);
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.getByText('protected layout')).toBeInTheDocument();
      unmount();
    }
  });
});
