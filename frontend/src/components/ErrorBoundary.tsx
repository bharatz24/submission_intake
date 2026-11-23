// Catches render errors so one broken view shows a recoverable message instead of a blank page.
// A failed dynamic import (a lazy chunk that no longer exists after a redeploy) gets a "Reload" prompt, since only
// fetching the new index.html can fix it.
import { Alert, AlertTitle, Box, Button, Stack } from '@mui/material';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { logger } from '../lib/logger';

const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed|Unable to preload CSS/i;

/** True for the errors browsers/Vite raise when a code-split chunk cannot be loaded. */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === 'ChunkLoadError' || (typeof message === 'string' && CHUNK_ERROR.test(message));
}

interface Props {
  children: ReactNode;
  /** Changing this value clears a caught error (e.g. the route path, so navigating away recovers). */
  resetKey?: unknown;
  /** `page` fills the viewport (top level); `section` sits inside the app layout. */
  variant?: 'page' | 'section';
  /** Reloads the page; replaceable in tests. */
  onReload?: () => void;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // A new resetKey (navigation) clears the error so the next view gets a fresh chance to render.
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null };
    return null;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    logger.error('Unhandled UI error', error, { source: 'error-boundary', componentStack: info.componentStack });
  }

  private reload = () => (this.props.onReload ?? (() => window.location.reload()))();

  private retry = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkLoadError(error);
    const page = this.props.variant === 'page';
    return (
      <Box
        sx={{
          p: 3,
          ...(page ? { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' } : {}),
        }}
      >
        <Alert severity={chunk ? 'info' : 'error'} sx={{ maxWidth: 560 }}>
          <AlertTitle>{chunk ? 'A new version is available' : 'Something went wrong'}</AlertTitle>
          {chunk
            ? 'The application was updated since this page was opened. Reload to get the latest version.'
            : 'This part of the page could not be displayed. You can try again, or reload the page if the problem persists.'}
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button variant="contained" size="small" onClick={this.reload}>
              Reload
            </Button>
            {!chunk && (
              <Button size="small" onClick={this.retry}>
                Try again
              </Button>
            )}
          </Stack>
        </Alert>
      </Box>
    );
  }
}
