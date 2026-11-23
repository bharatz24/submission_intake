// Route-level errorElement: a page whose code could not be loaded (a redeploy removed its chunk, the network dropped)
// or that failed in the router shows a recoverable message inside the app layout instead of a blank screen.
import { Alert, AlertTitle, Box, Button, Stack } from '@mui/material';
import { isRouteErrorResponse, useRouteError } from 'react-router';

import { logger } from '../lib/logger';
import { EmptyState } from './common';
import { isChunkLoadError } from './ErrorBoundary';

export function RouteErrorPage({ onReload = () => window.location.reload() }: { onReload?: () => void }) {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <EmptyState title="Page not found" description="The page you requested does not exist." />;
  }
  const chunk = isChunkLoadError(error);
  if (!chunk) logger.error('Route error', error, { source: 'route' });
  return (
    <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
      <Alert severity={chunk ? 'info' : 'error'} sx={{ maxWidth: 560 }}>
        <AlertTitle>{chunk ? 'A new version is available' : 'This page could not be opened'}</AlertTitle>
        {chunk
          ? 'The application was updated since this page was opened. Reload to get the latest version.'
          : 'Something went wrong while opening this page. Reload to try again; if it keeps happening, tell an administrator.'}
        <Stack direction="row" sx={{ mt: 1.5 }}>
          <Button variant="contained" size="small" onClick={onReload}>
            Reload
          </Button>
        </Stack>
      </Alert>
    </Box>
  );
}
