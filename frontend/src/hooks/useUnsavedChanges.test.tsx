// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { FeedbackProvider } from '../components/feedback/FeedbackProvider';
import { UnsavedChangesGuard, useDiscardGuard } from './useUnsavedChanges';

function Form({ onClose = () => undefined }: { onClose?: () => void }) {
  const [text, setText] = useState('');
  const discard = useDiscardGuard(text !== '');
  return (
    <div>
      <UnsavedChangesGuard when={text !== ''} />
      <label>
        Notes <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button type="button" onClick={() => discard(onClose)}>
        Cancel
      </button>
      <Link to="/elsewhere">Leave</Link>
    </div>
  );
}

function renderAt(element: React.ReactNode) {
  const router = createMemoryRouter([
    { path: '/', element },
    { path: '/elsewhere', element: <p>Somewhere else</p> },
  ]);
  render(
    <FeedbackProvider>
      <RouterProvider router={router} />
    </FeedbackProvider>,
  );
  return router;
}

describe('unsaved changes', () => {
  it('lets a clean form navigate away without asking', async () => {
    renderAt(<Form />);
    await userEvent.click(screen.getByRole('link', { name: 'Leave' }));
    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
  });

  it('asks before leaving a dirty form, and stays when the user keeps editing', async () => {
    const router = renderAt(<Form />);
    await userEvent.type(screen.getByLabelText('Notes'), 'Declined: prior claims');
    await userEvent.click(screen.getByRole('link', { name: 'Leave' }));
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel|keep/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/');
    expect(screen.getByLabelText('Notes')).toHaveValue('Declined: prior claims');
  });

  it('leaves after the user confirms the discard', async () => {
    const router = renderAt(<Form />);
    await userEvent.type(screen.getByLabelText('Notes'), 'x');
    await userEvent.click(screen.getByRole('link', { name: 'Leave' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/elsewhere');
  });

  it('asks before a dialog Cancel throws typed text away', async () => {
    const onClose = vi.fn();
    renderAt(<Form onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1); // clean: closes at once

    await userEvent.type(screen.getByLabelText('Notes'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('warns on tab close only while dirty', async () => {
    renderAt(<Form />);
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await userEvent.type(screen.getByLabelText('Notes'), 'x');
    expect(unload()).toBe(true);
  });
});
