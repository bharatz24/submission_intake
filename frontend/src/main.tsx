// Inter is bundled with the app (no request to Google Fonts on every load): the weights the theme uses.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';

import { CssBaseline, ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { routes } from './App';
import { AuthProvider } from './auth/AuthContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FeedbackProvider } from './components/feedback/FeedbackProvider';
import { QUERY_DEFAULTS } from './constants';
import { createMutationCache } from './lib/mutationErrors';
import { ApiError } from './services/api';
import { theme } from './theme';

const queryClient = new QueryClient({
  // A failed mutation that shows no error of its own gets an error toast (lib/mutationErrors.ts, FeedbackProvider).
  mutationCache: createMutationCache(),
  defaultOptions: {
    queries: {
      staleTime: QUERY_DEFAULTS.staleTime,
      refetchOnWindowFocus: false,
      // Do not retry client errors (401/403/404/422…); retry transient failures once.
      retry: (count, err) =>
        !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < QUERY_DEFAULTS.retryCount,
    },
  },
});

// A data router: lazy pages with route error pages (App.tsx), and forms can block navigation while they hold unsaved
// changes (hooks/useUnsavedChanges.tsx).
const router = createBrowserRouter(routes);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('index.html has no #root element');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <ErrorBoundary variant="page">
          <FeedbackProvider>
            <AuthProvider>
              <RouterProvider router={router} />
            </AuthProvider>
          </FeedbackProvider>
        </ErrorBoundary>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
