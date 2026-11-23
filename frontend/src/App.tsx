// The app's route table, for createBrowserRouter (main.tsx). Every page is loaded on first visit (its own chunk), so
// the first screen only downloads the shell and the page it opens. Pages sit under a pathless route with
// an errorElement, so a page that fails to load shows an error inside the layout, with the sidebar still there.
import type { ComponentType, ReactNode } from 'react';
import { Navigate, Outlet, type RouteObject, useLocation } from 'react-router';

import { useAuth } from './auth/AuthContext';
import { hasPermission, type Permission } from './auth/permissions';
import { EmptyState, ErrorState, Loading } from './components/common';
import { Layout } from './components/Layout';
import { NotificationProvider } from './components/notifications/NotificationProvider';
import { RouteErrorPage } from './components/RouteErrorPage';
import { paths, routePatterns } from './paths';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, initializing, restoreError, retryRestore } = useAuth();
  const location = useLocation();
  if (initializing) return <Loading label="Restoring session…" minHeight={400} shape="page" />;
  // The session could not be checked (server down, network): offer a retry instead of signing out.
  if (!user && restoreError)
    return <ErrorState error={restoreError} onRetry={retryRestore} title="Cannot reach the server" />;
  if (!user) return <Navigate to={paths.login} replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** Screens that need a permission: anyone without it sees a notice instead of a page of 403 errors. */
function RequirePermission({ permission }: { permission: Permission }) {
  const { user } = useAuth();
  if (!hasPermission(user, permission))
    return <EmptyState title="Not available for your role" description="Ask an administrator if you need this page." />;
  return <Outlet />;
}

/** A route's `lazy`: loads the page's module and picks its (named) page component. */
function page<M>(load: () => Promise<M>, pick: (m: M) => ComponentType) {
  return async () => ({ Component: pick(await load()) });
}

export const routes: RouteObject[] = [
  {
    // Shown while the first page's code loads.
    hydrateFallbackElement: <Loading minHeight={400} shape="page" />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        path: paths.login,
        lazy: page(
          () => import('./auth/LoginPage'),
          (m) => m.LoginPage,
        ),
      },
      {
        path: paths.inbox,
        element: (
          <RequireAuth>
            <NotificationProvider>
              <Layout />
            </NotificationProvider>
          </RequireAuth>
        ),
        children: [
          {
            errorElement: <RouteErrorPage />,
            children: [
              {
                index: true,
                lazy: page(
                  () => import('./features/submissions/pages/SubmissionInbox'),
                  (m) => m.SubmissionInbox,
                ),
              },
              {
                path: routePatterns.submission,
                lazy: page(
                  () => import('./features/submissions/pages/SubmissionWorkspace'),
                  (m) => m.SubmissionWorkspace,
                ),
              },
              {
                element: <RequirePermission permission="monitoring:view" />,
                children: [
                  {
                    path: routePatterns.monitoring,
                    lazy: page(
                      () => import('./features/settings/pages/MonitoringPage'),
                      (m) => m.MonitoringPage,
                    ),
                  },
                ],
              },
              {
                element: <RequirePermission permission="audit:view" />,
                children: [
                  {
                    path: routePatterns.audit,
                    lazy: page(
                      () => import('./features/audit/AuditTrail'),
                      (m) => m.AuditTrail,
                    ),
                  },
                ],
              },
              {
                // Every role may open Settings: it shows the configuration read-only and each card gates its own
                // controls (settings:manage, gmail:manage, rate:manage, skill:edit), so no single route permission fits.
                path: routePatterns.settings,
                lazy: page(
                  () => import('./features/settings/pages/SettingsPage'),
                  (m) => m.SettingsPage,
                ),
              },
              {
                element: <RequirePermission permission="user:manage" />,
                children: [
                  {
                    path: routePatterns.users,
                    lazy: page(
                      () => import('./features/settings/pages/UsersSettings'),
                      (m) => m.UsersSettings,
                    ),
                  },
                ],
              },
              {
                path: routePatterns.documents,
                lazy: page(
                  () => import('./features/submissions/pages/DocumentsPage'),
                  (m) => m.DocumentsPage,
                ),
              },
              {
                path: '*',
                element: <EmptyState title="Page not found" description="The page you requested does not exist." />,
              },
            ],
          },
        ],
      },
    ],
  },
];
