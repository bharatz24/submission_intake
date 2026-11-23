// @vitest-environment jsdom
// Draft email: opening the dialog or changing the dropdown never calls the API; Generate calls it once for the
// selected audience (Broker, Insured or Quote). Drafts are editable and copyable, never sent. Generating is a job:
// the dialog polls until the run is no longer PENDING.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import type { EmailAudience, EmailDrafts, EmailDraftState } from '../../../types';

// What the server does, programmed per test; the dialog reaches it over the network (MSW), through the real API client.
const api = { draftEmail: vi.fn(), latestEmailDraft: vi.fn(), saveEmailDraft: vi.fn(), quotes: vi.fn() };
const serveDrafts = () =>
  mockApi({
    'GET /submissions/:id/email-drafts': ({ params, query }) => api.latestEmailDraft(params.id, query.get('audience')),
    'POST /submissions/:id/email-drafts': ({ params, body }) =>
      api.draftEmail(params.id, (body as { audience: string }).audience),
    'PUT /submissions/:id/email-drafts/:draftId': ({ params, body }) =>
      api.saveEmailDraft(params.id, params.draftId, body),
    'GET /submissions/:id/quotes': ({ params }) => api.quotes(params.id),
  });

const { EmailDraftDialog } = await import('./EmailDraftDialog');
// The markdown renderer is lazy (FE-05): load it once up front so no test waits on its first import.
await (await import('../../../components/common')).preloadMarkdown();

const drafts = (audience: EmailAudience = 'broker', over: Partial<EmailDrafts> = {}): EmailDrafts => ({
  id: `d-${audience}`,
  audience,
  createdAt: '2026-11-04T10:00:00Z',
  createdBy: { id: 'u-1', name: 'Uma Writer' },
  purpose: 'REQUEST_INFORMATION',
  draft: {
    to: 'broker@acme.test',
    subject: `RE: Quote request (${audience})`,
    body: 'Hi Mark,\n\n• Loss runs for the past 10 years',
    keyPoints: ['Loss runs for the past 10 years'],
  },
  analysisReportId: 'a-3',
  analysisVersion: 3,
  synthesisVersion: 2,
  newerAnalysisVersion: null,
  stale: false,
  model: 'claude-haiku-5-5',
  ...over,
});

/** What GET/POST /email-drafts answer: a finished draft (no run), or a run still going or failed. */
const done = (d: EmailDrafts | null): EmailDraftState => ({ draft: d, run: null });
const running: EmailDraftState = {
  draft: null,
  run: { id: 'd-run', status: 'PENDING', error: null, createdAt: '2026-11-04T10:00:00Z' },
};
const failed = (error: string): EmailDraftState => ({
  draft: null,
  run: { id: 'd-run', status: 'FAILED', error, createdAt: '2026-11-04T10:00:00Z' },
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const renderDialog = (qc = client()) =>
  render(
    <QueryClientProvider client={qc}>
      <EmailDraftDialog submissionId="s-1" open onClose={() => {}} />
    </QueryClientProvider>,
  );

const pick = async (name: string) => {
  if (name === 'Quote') await waitFor(() => expect(screen.getByRole('tab', { name })).toBeEnabled());
  await userEvent.click(screen.getByRole('tab', { name }));
};

describe('EmailDraftDialog', () => {
  beforeEach(() => {
    api.latestEmailDraft.mockResolvedValue(done(null));
    api.quotes.mockResolvedValue([{ id: 'q-1', status: 'QUOTED', isPrimary: true }]);
    serveDrafts();
  });
  afterEach(() => vi.resetAllMocks());

  it('calls no API on open or when the dropdown changes', async () => {
    renderDialog();
    // Disabled until the saved draft has loaded over the network.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    await pick('Insured');
    await pick('Quote');
    expect(api.draftEmail).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it.each([
    ['Broker', 'broker'],
    ['Insured', 'insured'],
    ['Quote', 'quote'],
  ] as const)('Generate drafts the %s email', async (name, audience) => {
    api.draftEmail.mockResolvedValue(done(drafts(audience)));
    renderDialog();
    if (name !== 'Broker') await pick(name);
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    expect(await screen.findByDisplayValue(`RE: Quote request (${audience})`)).toBeInTheDocument();
    expect(api.draftEmail).toHaveBeenCalledTimes(1);
    expect(api.draftEmail).toHaveBeenCalledWith('s-1', audience);
    expect(screen.queryByText(/Key points/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
  });

  it('lets the draft be edited, and Generate replaces the edits', async () => {
    api.draftEmail
      .mockResolvedValueOnce(done(drafts('broker')))
      .mockResolvedValueOnce(
        done(drafts('broker', { id: 'd-2', draft: { to: null, subject: 'RE: new', body: 'Hi', keyPoints: [] } })),
      );
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    const subject = await screen.findByDisplayValue('RE: Quote request (broker)');
    await userEvent.clear(subject);
    await userEvent.type(subject, 'Edited subject');
    expect(screen.getByDisplayValue('Edited subject')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(await screen.findByDisplayValue('RE: new')).toBeInTheDocument();
    expect(api.draftEmail).toHaveBeenCalledTimes(2);
  });

  it('disables the Quote tab until a quote exists', async () => {
    api.quotes.mockResolvedValue([]);
    renderDialog();
    // Disabled until the saved draft has loaded over the network.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    expect(screen.getByRole('tab', { name: 'Quote' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Broker' })).toBeEnabled();
    expect(screen.getByRole('tab', { name: 'Insured' })).toBeEnabled();
  });

  it('disables the Quote tab while the quote is INCOMPLETE', async () => {
    api.quotes.mockResolvedValue([{ id: 'q-1', status: 'INCOMPLETE', isPrimary: true }]);
    renderDialog();
    // Disabled until the saved draft has loaded over the network.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    await waitFor(() => expect(api.quotes).toHaveBeenCalled());
    expect(screen.getByRole('tab', { name: 'Quote' })).toBeDisabled();
  });

  it('saves manual edits to the draft after typing stops', async () => {
    api.draftEmail.mockResolvedValue(done(drafts('broker')));
    api.saveEmailDraft.mockImplementation(async (_id: string, draftId: string, e: { subject: string; body: string }) =>
      drafts('broker', { id: draftId, draft: { to: 'broker@acme.test', keyPoints: [], ...e } }),
    );
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    const subject = await screen.findByDisplayValue('RE: Quote request (broker)');
    await userEvent.clear(subject);
    await userEvent.type(subject, 'Edited subject');
    await waitFor(() => expect(api.saveEmailDraft).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.saveEmailDraft).toHaveBeenCalledWith('s-1', 'd-broker', {
      subject: 'Edited subject',
      body: 'Hi Mark,\n\n• Loss runs for the past 10 years',
    });
    expect(await screen.findByText('Changes saved')).toBeInTheDocument();
    expect(api.draftEmail).toHaveBeenCalledTimes(1);
  });

  it('shows one button: Generate without a draft, Regenerate with one', async () => {
    api.draftEmail.mockResolvedValue(done(drafts('broker')));
    api.latestEmailDraft.mockImplementation(async (_id: string, a: EmailAudience) =>
      done(a === 'broker' && api.draftEmail.mock.calls.length ? drafts('broker') : null),
    );
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
    await pick('Quote');
    // Disabled until the saved draft has loaded over the network.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('RE: Quote request (broker)')).not.toBeInTheDocument();
    await pick('Broker');
    expect(await screen.findByRole('button', { name: 'Regenerate' })).toBeEnabled();
    expect(screen.getByDisplayValue('RE: Quote request (broker)')).toBeInTheDocument();
    expect(api.draftEmail).toHaveBeenCalledTimes(1);
  });

  it('shows the already generated draft after the dialog is closed and reopened', async () => {
    api.draftEmail.mockResolvedValue(done(drafts('quote')));
    const qc = client();
    const first = renderDialog(qc);
    await pick('Quote');
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    expect(await screen.findByDisplayValue('RE: Quote request (quote)')).toBeInTheDocument();
    first.unmount();

    // Reopen with a fresh component (cache dropped too): the server's saved draft comes back, no new generation.
    api.latestEmailDraft.mockResolvedValue(done(drafts('quote')));
    renderDialog(client());
    await pick('Quote');
    expect(await screen.findByDisplayValue('RE: Quote request (quote)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
    expect(api.draftEmail).toHaveBeenCalledTimes(1);
  });

  it('points out a newer analysis, and evidence that changed after the analysis', async () => {
    api.draftEmail.mockResolvedValueOnce(done(drafts('broker', { newerAnalysisVersion: 4 })));
    const { unmount } = renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    expect(
      await screen.findByText(/Analysis v4 is newer than the one this draft was written from/),
    ).toBeInTheDocument();
    unmount();

    api.draftEmail.mockResolvedValueOnce(done(drafts('broker', { stale: true })));
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    expect(await screen.findByText(/submission changed after this analysis ran/)).toBeInTheDocument();
  });

  it('shows the server error when the draft cannot be generated', async () => {
    api.draftEmail.mockRejectedValueOnce(new Error('Run the analysis first'));
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    expect(await screen.findByText(/Run the analysis first/)).toBeInTheDocument();
  });

  it('waits for a running draft, polling until the job has written it', async () => {
    api.draftEmail.mockResolvedValue(running);
    api.latestEmailDraft
      .mockResolvedValueOnce(done(null))
      .mockResolvedValueOnce(running)
      .mockResolvedValue(done(drafts('broker')));
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    expect(await screen.findByText(/Claude is drafting the broker email/)).toBeInTheDocument();
    expect(await screen.findByDisplayValue('RE: Quote request (broker)', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(api.draftEmail).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('shows why the last generation failed', async () => {
    api.latestEmailDraft.mockResolvedValue(failed('Claude is overloaded; try again in a few minutes'));
    renderDialog();
    expect(await screen.findByText(/Could not draft the email: Claude is overloaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });
});
