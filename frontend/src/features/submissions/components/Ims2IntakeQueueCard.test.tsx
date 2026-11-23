// @vitest-environment jsdom
// FE-06: the "Open in IMS 2" link comes from IMS 2's API; only an http(s) address may become an href.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import type { Ims2QueueInfo, Ims2QueueRow } from '../../../types';

let role: 'UNDERWRITER' | 'VIEWER' = 'UNDERWRITER';
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Uma Writer', role } }),
}));

const { Ims2IntakeQueueCard } = await import('./Ims2IntakeQueueCard');

const linkedRow = (imsUrl: string | null): Ims2QueueRow => ({
  intakeId: 'intake-1',
  version: 1,
  state: 'LINKED',
  lastHttpStatus: 200,
  lastError: null,
  lastErrorField: null,
  imsSubmissionId: 42,
  imsSubmissionNumber: 'S-42',
  imsInsuredId: 'ins-1',
  imsUrl,
  remoteStatus: null,
  remoteStatusChangedAt: null,
  remoteCheckedAt: null,
  rejectedReason: null,
  sent: null,
  form: null,
  sentBy: { id: 'u1', name: 'Uma Writer' },
  sentAt: '2026-11-17T10:00:00Z',
});

const calls: string[] = [];

function renderLinked(imsUrl: string | null) {
  calls.length = 0;
  const row = linkedRow(imsUrl);
  const info: Ims2QueueInfo = {
    configured: true,
    latestDecision: null,
    canSend: false,
    row,
    legacyHandoff: null,
    defaults: null,
  };
  mockApi({
    'GET /submissions/:id/ims2-queue': () => info,
    'GET /submissions/:id/ims2-queue/status': () => {
      calls.push('GET status');
      return row;
    },
    'POST /submissions/:id/ims2-queue/status/refresh': () => {
      calls.push('POST refresh');
      return row;
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Ims2IntakeQueueCard submissionId="s1" />
    </QueryClientProvider>,
  );
}

describe('Ims2IntakeQueueCard (linked)', () => {
  it('asks IMS 2 for the status when the user may write (SEC-07)', async () => {
    role = 'UNDERWRITER';
    renderLinked('https://ims2.example.test/submissions/42');
    await vi.waitFor(() => expect(calls).toEqual(['POST refresh']));
  });

  it('only reads the stored status for a viewer, never the refresh', async () => {
    role = 'VIEWER';
    renderLinked('https://ims2.example.test/submissions/42');
    await vi.waitFor(() => expect(calls).toEqual(['GET status']));
    role = 'UNDERWRITER';
  });

  it('links to an https IMS 2 address', async () => {
    renderLinked('https://ims2.example.test/submissions/42');
    const link = await screen.findByRole('link', { name: /Open in IMS 2/ });
    expect(link).toHaveAttribute('href', 'https://ims2.example.test/submissions/42');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders no link for a javascript: address', async () => {
    renderLinked('javascript:alert(document.cookie)');
    expect(await screen.findByText('S-42')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open in IMS 2/ })).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });
});
