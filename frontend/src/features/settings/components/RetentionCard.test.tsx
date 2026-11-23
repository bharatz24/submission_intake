// @vitest-environment jsdom
// Settings → Data retention: periods are empty (keep forever) or at least 30 days, and saving a period asks first.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';

let role = 'ADMIN';
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', role, name: 'Admin', email: 'admin@example.test' } }),
}));

const { RetentionCard } = await import('./RetentionCard');

const KEEP_ALL = {
  llmTranscriptsDays: null,
  llmCallsDays: null,
  chatDays: null,
  deletedSubmissionsDays: null,
  skippedEmailsDays: null,
};
const settings = (values: Record<string, number | null> = KEEP_ALL) => ({
  values,
  bounds: { min: 30, max: 3650 },
  updatedAt: null,
  updatedBy: null,
});

let api: ReturnType<typeof serve>;
const serve = () =>
  mockApi({
    'GET /settings/retention': () => settings(),
    'PUT /settings/retention': ({ body }) => settings({ ...KEEP_ALL, ...(body as Record<string, number | null>) }),
  });

const renderCard = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RetentionCard />
    </QueryClientProvider>,
  );

beforeEach(() => {
  role = 'ADMIN';
  api = serve();
});

describe('RetentionCard', () => {
  it('shows every period as "Keep forever" by default', async () => {
    renderCard();
    const chat = await screen.findByLabelText(/chat messages/i);
    expect(chat).toHaveValue('');
    expect(screen.getAllByText(/keep forever/i).length).toBeGreaterThanOrEqual(4);
  });

  it('rejects a period under 30 days with an inline error', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByLabelText(/chat messages/i), '10');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText('Minimum 30 days')).toBeInTheDocument();
    expect(screen.getByLabelText(/chat messages/i)).toHaveAttribute('aria-invalid', 'true');
    expect(api['PUT /settings/retention']).not.toHaveBeenCalled();
  });

  it('asks before saving a period, then saves it', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByLabelText(/chat messages/i), '90');
    await user.click(screen.getByRole('button', { name: /save/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Data older than 90 days will be permanently removed/)).toBeInTheDocument();
    expect(api['PUT /settings/retention']).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: /remove data/i }));
    await waitFor(() => expect(api['PUT /settings/retention']).toHaveBeenCalled());
    expect(api['PUT /settings/retention']).toHaveBeenCalledWith(
      expect.objectContaining({ body: { ...KEEP_ALL, chatDays: 90 } }),
    );
  });

  it('saves "keep forever" everywhere without asking', async () => {
    api['GET /settings/retention'].mockImplementation(() => settings({ ...KEEP_ALL, chatDays: 60 }));
    const user = userEvent.setup();
    renderCard();
    const chat = await screen.findByLabelText(/chat messages/i);
    await waitFor(() => expect(chat).toHaveValue('60'));
    await user.clear(chat);
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(api['PUT /settings/retention']).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api['PUT /settings/retention']).toHaveBeenCalledWith(expect.objectContaining({ body: KEEP_ALL }));
  });

  it('is read-only without settings:manage', async () => {
    role = 'VIEWER';
    renderCard();
    expect(await screen.findByLabelText(/chat messages/i)).toBeDisabled();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });
});
