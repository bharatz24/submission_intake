// @vitest-environment jsdom
// The global audit trail lists events and filters them by action through the URL (debounced).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../test/msw/api';
import type { AuditEvent } from '../../types';

const { AuditTrail } = await import('./AuditTrail');

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: 'a1',
  submissionId: '11111111-2222-4333-8444-555555555555',
  actorType: 'USER',
  actor: { id: 'u1', name: 'Uma Writer' },
  action: 'REPORT_GENERATED',
  entityType: 'report',
  entityId: 'r1',
  details: {},
  createdAt: '2026-11-17T10:00:00Z',
  ...over,
});

function renderPage() {
  const api = mockApi({
    'GET /audit': ({ query }) => {
      const all = [event(), event({ id: 'a2', action: 'USER_DISABLED', actor: { id: 'u9', name: 'Ada Admin' } })];
      const action = query.get('action');
      const items = action ? all.filter((e) => e.action === action) : all;
      return { items, total: items.length, page: 1, pageSize: 25 };
    },
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AuditTrail />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return api;
}

describe('AuditTrail', () => {
  it('renders the events with who did what', async () => {
    renderPage();
    expect(await screen.findByText('Uma Writer')).toBeInTheDocument();
    expect(screen.getByText('Ada Admin')).toBeInTheDocument();
    expect(screen.getByText(/REPORT_GENERATED|Report generated/i)).toBeInTheDocument();
  });

  it('filters by action', async () => {
    const api = renderPage();
    await screen.findByText('Ada Admin');
    await userEvent.type(screen.getByLabelText('Action'), 'USER_DISABLED');
    await vi.waitFor(() =>
      expect(api['GET /audit'].mock.calls.some(([c]) => c.query.get('action') === 'USER_DISABLED')).toBe(true),
    );
    await vi.waitFor(() => expect(screen.queryByText('Uma Writer')).toBeNull());
    expect(screen.getByText('Ada Admin')).toBeInTheDocument();
  });
});
