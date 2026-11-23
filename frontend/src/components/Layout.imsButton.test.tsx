// @vitest-environment jsdom
// Top bar: the IMS button opens the URL saved in Settings → IMS 2 intake in a new tab, and is hidden while none is saved.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { mockApi } from '../test/msw/api';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', role: 'UNDERWRITER', name: 'Uma Writer', email: 'uma@example.test' } }),
}));
vi.mock('./notifications/NotificationBell', () => ({ NotificationBell: () => <span>bell</span> }));

const { Layout } = await import('./Layout');

function renderLayout(imsUrl: string | null) {
  const routes = mockApi({
    'GET /system/status': () => ({ services: [] }),
    'GET /submissions/unread-count': () => ({ unread: 0 }),
    'GET /settings/ims2-queue': () => ({
      baseUrl: null,
      tokenSet: false,
      tokenHint: null,
      tokenError: null,
      configured: false,
      imsUrl,
    }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Layout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return routes;
}

describe('IMS button', () => {
  it('opens the saved IMS URL in a new tab, left of the notification bell', async () => {
    renderLayout('https://ims.example.com/policies');
    const link = await screen.findByRole('link', { name: /open ims/i });
    expect(link).toHaveAttribute('href', 'https://ims.example.com/policies');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // Left of the bell: it comes first in the toolbar.
    const bell = screen.getByText('bell');
    expect(link.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is hidden while no IMS URL is saved', async () => {
    const routes = renderLayout(null);
    await waitFor(() => expect(routes['GET /settings/ims2-queue']).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /open ims/i })).not.toBeInTheDocument();
  });

  it('never links a URL that is not http(s)', async () => {
    const routes = renderLayout('javascript:alert(1)');
    await waitFor(() => expect(routes['GET /settings/ims2-queue']).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /open ims/i })).not.toBeInTheDocument();
  });
});
