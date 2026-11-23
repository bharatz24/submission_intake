// @vitest-environment jsdom
// The quotes table: each row has icon-only Edit and Make primary buttons (shown on hover), none under the table.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import type { Quote } from '../../../types';

let role = 'UNDERWRITER';
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Uma Writer', role } }),
}));
vi.mock('../../../lib/automation', () => ({ useManualStep: () => false }));
vi.mock('./QuoteDialog', () => ({
  QuoteDialog: ({ from }: { from?: Quote }) => <div>Editing quote v{from?.version}</div>,
}));

const { QuotesCard } = await import('./QuotesCard');

const quote = (version: number, isPrimary: boolean): Quote => ({
  id: `q${version}`,
  version,
  label: null,
  status: 'QUOTED',
  rateGroup: 'rg',
  contextVersion: 1,
  isPrimary,
  inputs: {} as Quote['inputs'],
  factors: {},
  pricing: null,
  premium: 1000 * version,
  total: 1100 * version,
  flags: [],
  missing: [],
  createdBy: { id: 'u1', name: 'Uma Writer' },
  createdAt: '2026-11-17T10:00:00Z',
});

const renderCard = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <QuotesCard submissionId="s1" />
    </QueryClientProvider>,
  );

describe('QuotesCard', () => {
  it('puts icon-only Edit and Make primary buttons on each row, named by a tooltip on hover', async () => {
    role = 'UNDERWRITER';
    const api = mockApi({
      'GET /submissions/:id/quotes': () => [quote(2, false), quote(1, true)],
      'PUT /submissions/:id/primary-rating': () => [
        { ...quote(2, false), isPrimary: true },
        { ...quote(1, true), isPrimary: false },
      ],
    });
    const user = userEvent.setup();
    renderCard();

    // Icons only: the text appears as a tooltip when the button is hovered.
    const makePrimary = await screen.findByRole('button', { name: 'Make quote v2 primary' });
    expect(makePrimary).not.toHaveTextContent(/\w/);
    await user.hover(makePrimary);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Make primary');

    // The primary quote has no Make primary button; every row can be edited.
    expect(screen.queryByRole('button', { name: 'Make quote v1 primary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit quote v1' })).toBeInTheDocument();

    await user.click(makePrimary);
    await waitFor(() => expect(api['PUT /submissions/:id/primary-rating']).toHaveBeenCalledTimes(1));
    expect(api['PUT /submissions/:id/primary-rating']).toHaveBeenCalledWith(
      expect.objectContaining({ body: { ratingId: 'q2' } }),
    );

    await user.click(screen.getByRole('button', { name: 'Edit quote v2' }));
    expect(await screen.findByText('Editing quote v2')).toBeInTheDocument();

    // No text buttons under the table any more.
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make primary' })).not.toBeInTheDocument();
  });

  it('shows the table, with its row buttons, for a single quote', async () => {
    role = 'UNDERWRITER';
    mockApi({ 'GET /submissions/:id/quotes': () => [quote(1, true)] });
    renderCard();
    expect(await screen.findByRole('button', { name: 'Edit quote v1' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Version' })).toBeInTheDocument();
  });

  it('shows no row buttons to someone who can only view', async () => {
    role = 'VIEWER';
    mockApi({ 'GET /submissions/:id/quotes': () => [quote(2, false), quote(1, true)] });
    renderCard();
    expect(await screen.findByRole('columnheader', { name: 'Version' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /quote v\d/ })).not.toBeInTheDocument();
  });
});
