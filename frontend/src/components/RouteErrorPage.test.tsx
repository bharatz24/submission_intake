// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { RouteErrorPage } from './RouteErrorPage';

function renderFailingPage(error: Error, onReload = vi.fn()) {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <div>
          sidebar
          <Outlet />
        </div>
      ),
      children: [
        {
          errorElement: <RouteErrorPage onReload={onReload} />,
          children: [
            {
              index: true,
              lazy: async () => {
                throw error;
              },
            },
          ],
        },
      ],
    },
  ]);
  render(<RouterProvider router={router} />);
  return onReload;
}

describe('RouteErrorPage', () => {
  it('offers a reload, inside the layout, when a page chunk is gone after a redeploy', async () => {
    const onReload = renderFailingPage(
      new TypeError('Failed to fetch dynamically imported module: /assets/Inbox-abc.js'),
    );
    expect(await screen.findByText('A new version is available')).toBeInTheDocument();
    expect(screen.getByText('sidebar')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalled();
  });

  it('says the page could not be opened for any other failure', async () => {
    renderFailingPage(new Error('boom'));
    expect(await screen.findByText('This page could not be opened')).toBeInTheDocument();
  });
});
