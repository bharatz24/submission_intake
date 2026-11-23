// @vitest-environment jsdom
// Outbound email from a submission: the form refuses to send without a subject or a valid recipient, and Send shows
// a pending state (no double send) until the server answers.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import { apiError } from '../../../test/msw/handlers';
import type { SubmissionDetail } from '../../../types';

const { EmailComposeDialog } = await import('./EmailComposeDialog');

const submission = {
  id: 's1',
  subject: 'Quote request',
  documents: [],
  email: {
    id: 'e1',
    gmailMessageId: 'g1',
    threadId: 't1',
    fromAddress: 'Pat Broker <pat@brokerage.test>',
    toAddress: 'intake@example.test',
    subject: 'Quote request',
    snippet: '',
    bodyText: 'Please quote.',
    receivedAt: '2026-11-05T10:00:00Z',
  },
} as unknown as SubmissionDetail;

function renderCompose(send: () => unknown) {
  const api = mockApi({
    'GET /gmail/status': () => ({ configured: true, connected: true, email: 'intake@example.test', source: 'OAUTH' }),
    'GET /settings/limits': () => apiError(503, 'UNAVAILABLE', 'not needed'),
    'POST /submissions/:id/outbound-emails': send,
  });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <EmailComposeDialog s={submission} mode="REPLY" onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { api, onClose };
}

describe('EmailComposeDialog', () => {
  it('starts a reply to the sender and will not send without a subject', async () => {
    const { api } = renderCompose(() => ({ id: 'o1' }));
    expect(await screen.findByRole('dialog', { name: /Reply/ })).toBeInTheDocument();
    expect(screen.getByText('Pat Broker <pat@brokerage.test>')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send' });
    await vi.waitFor(() => expect(send).toBeEnabled()); // once Gmail is known to be connected

    await userEvent.clear(screen.getByLabelText('Subject'));
    expect(screen.getByText('A subject is required')).toBeInTheDocument();
    expect(screen.getByText(/Add a subject\./)).toBeInTheDocument();
    expect(send).toBeDisabled();
    expect(api['POST /submissions/:id/outbound-emails']).not.toHaveBeenCalled();
  });

  it('flags an invalid recipient', async () => {
    renderCompose(() => ({ id: 'o1' }));
    const to = await screen.findByLabelText('To');
    await userEvent.type(to, 'not-an-address,');
    expect(await screen.findByText(/Fix the invalid address\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('shows Sending… while the email goes out, then closes', async () => {
    let answer: (v: unknown) => void = () => undefined;
    const { api, onClose } = renderCompose(() => new Promise((resolve) => (answer = resolve)));
    const send = await screen.findByRole('button', { name: 'Send' });
    await vi.waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);

    const pending = await screen.findByRole('button', { name: 'Sending…' });
    expect(pending).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(api['POST /submissions/:id/outbound-emails']).toHaveBeenCalledTimes(1);
    const body = api['POST /submissions/:id/outbound-emails'].mock.calls[0]![0].body as Record<string, unknown>;
    expect(body).toMatchObject({
      mode: 'REPLY',
      to: ['Pat Broker <pat@brokerage.test>'],
      subject: 'Re: Quote request',
    });
    expect(body.idempotencyKey).toEqual(expect.any(String));

    answer({ id: 'o1' });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows the server refusal in the dialog and lets the user try again', async () => {
    renderCompose(() => apiError(502, 'GMAIL_SEND_FAILED', 'Gmail did not accept the message.'));
    const send = await screen.findByRole('button', { name: 'Send' });
    await vi.waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    expect(await screen.findByText(/Gmail did not accept the message/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });
});
