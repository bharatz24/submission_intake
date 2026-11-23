// @vitest-environment jsdom
// FE-13: a failed mutation that shows no error of its own gets an error toast; one that renders its own error
// (meta.silentError) or handles it (onError) does not get a second message.
import { QueryClient, QueryClientProvider, useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FeedbackProvider } from '../components/feedback/FeedbackProvider';
import { api } from '../services/api';
import { mockApi } from '../test/msw/api';
import { apiError } from '../test/msw/handlers';
import { createMutationCache } from './mutationErrors';

function Action(props: Omit<UseMutationOptions<unknown, Error, void>, 'mutationFn'>) {
  const m = useMutation({ mutationFn: () => api.reprocess('s1'), ...props });
  return (
    <>
      <button type="button" onClick={() => m.mutate()}>
        Run
      </button>
      {m.isError && <p>inline: {m.error.message}</p>}
    </>
  );
}

function renderAction(props: Omit<UseMutationOptions<unknown, Error, void>, 'mutationFn'> = {}) {
  const client = new QueryClient({ mutationCache: createMutationCache() });
  render(
    <QueryClientProvider client={client}>
      <FeedbackProvider>
        <Action {...props} />
      </FeedbackProvider>
    </QueryClientProvider>,
  );
}

describe('default mutation error toast', () => {
  it('shows a toast for a failed mutation with no error handling of its own', async () => {
    mockApi({ 'POST /submissions/:id/reprocess': () => apiError(500, 'INTERNAL', 'Database unavailable') });
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
  });

  it('stays quiet for a mutation marked meta.silentError, which shows its own error', async () => {
    mockApi({ 'POST /submissions/:id/reprocess': () => apiError(409, 'CONFLICT', 'Already running') });
    renderAction({ meta: { silentError: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('inline: Already running')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leaves a mutation with its own onError to report the error itself', async () => {
    mockApi({ 'POST /submissions/:id/reprocess': () => apiError(409, 'CONFLICT', 'Already running') });
    const onError = vi.fn();
    renderAction({ onError });
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not toast a 401: the session handler signs the user out instead', async () => {
    mockApi({ 'POST /submissions/:id/reprocess': () => apiError(401, 'UNAUTHORIZED', 'Session expired') });
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('inline: Session expired')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
