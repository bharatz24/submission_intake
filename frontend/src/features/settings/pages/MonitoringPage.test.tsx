// @vitest-environment jsdom
// Monitoring → Token usage: estimated Claude spend (spec §7) for 24 h / 7 d / 30 d, by task and model, and the
// submissions that cost the most, each linking to its workspace.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../test/axe';
import { mockApi } from '../../../test/msw/api';
import { MonitoringPage } from './MonitoringPage';

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', role: 'ADMIN', name: 'Admin', email: 'admin@example.test' } }),
}));

const stats = {
  range: 'today',
  byStatus: {},
  byClassification: {},
  reports: { SYNTHESIS: 0, ANALYSIS: 0 },
  failedReports: 0,
  emails: 0,
  duplicates: 0,
  queueDepth: 0,
  ingestQueue: { waiting: 0, alerted: 0, oldest: null },
  lastPollAt: null,
  recentErrors: [],
};
const counts = { failed: 0, inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };
const usage = {
  range: 'today',
  summary: {
    calls: 4,
    inputTokens: 4000,
    outputTokens: 400,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheSavingsUsd: 0,
    costUsd: 12.34,
    byTask: [
      { task: 'synthesis', calls: 2, ...counts, costUsd: 10 },
      { task: 'chat', calls: 1, ...counts, costUsd: 2.34 },
      { task: 'classification', calls: 1, ...counts, costUsd: null },
    ],
    byModel: [
      { task: 'synthesis', model: 'claude-opus-5-5', calls: 2, ...counts, cacheSavingsUsd: 0, costUsd: 10 },
      { task: 'chat', model: 'claude-opus-5-5', calls: 1, ...counts, cacheSavingsUsd: 0, costUsd: 2.34 },
      { task: 'classification', model: 'mock-model', calls: 1, ...counts, cacheSavingsUsd: null, costUsd: null },
    ],
  },
  spend: { '24h': 12.34, '7d': 1234.5, '30d': 2000 },
  topSubmissions: [
    { submissionId: 'sub-1', applicantName: 'Jane Smith', calls: 3, costUsd: 11 },
    { submissionId: 'sub-2', applicantName: null, calls: 1, costUsd: 1.34 },
  ],
  requests: { total: 0, page: 1, pageSize: 25, items: [] },
};

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/monitoring']}>
        <MonitoringPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('MonitoringPage spend', () => {
  it('shows spend per period in US dollars, by task, and the top submissions by cost', async () => {
    mockApi({ 'GET /monitoring/stats': () => stats, 'GET /monitoring/llm-usage': () => usage });
    renderPage();

    const spend = await screen.findByRole('region', { name: 'Estimated Claude spend' }, { timeout: 5000 });
    const tile = (name: string) => within(spend).getByRole('group', { name });
    expect(tile('Spend (24 h)')).toHaveTextContent('$12.34');
    expect(tile('Spend (7 d)')).toHaveTextContent('$1,234.50');
    expect(tile('Spend (30 d)')).toHaveTextContent('$2,000.00');

    const byTask = within(spend).getByRole('table', { name: 'Spend by task' });
    const synthesisRow = within(byTask).getByRole('row', { name: /Synthesis/ });
    expect(synthesisRow).toHaveTextContent('$10.00');
    // A task whose calls have no known price shows a dash, not $0.00.
    expect(within(byTask).getByRole('row', { name: /Classification/ })).toHaveTextContent('—');

    const top = within(spend).getByRole('table', { name: 'Top submissions by cost' });
    expect(within(top).getByRole('link', { name: 'Jane Smith' })).toHaveAttribute('href', '/submissions/sub-1');
    expect(within(top).getByRole('link', { name: 'Unnamed applicant' })).toHaveAttribute('href', '/submissions/sub-2');
    expect(within(top).getByRole('row', { name: /Jane Smith/ })).toHaveTextContent('$11.00');
    expect(await axeViolations(spend)).toEqual([]);
  });

  it('says when nothing has a known price yet', async () => {
    mockApi({
      'GET /monitoring/stats': () => stats,
      'GET /monitoring/llm-usage': () => ({
        ...usage,
        summary: { ...usage.summary, costUsd: null, byTask: [], byModel: [] },
        spend: { '24h': null, '7d': null, '30d': null },
        topSubmissions: [],
      }),
    });
    renderPage();
    const spend = await screen.findByRole('region', { name: 'Estimated Claude spend' }, { timeout: 5000 });
    // No known price is not $0.00: each period tile shows a dash.
    for (const name of ['Spend (24 h)', 'Spend (7 d)', 'Spend (30 d)'])
      expect(within(spend).getByRole('group', { name })).toHaveTextContent('—');
    expect(within(spend).queryByText('$0.00')).not.toBeInTheDocument();
    expect(within(spend).getByText('No priced Claude requests in this period.')).toBeInTheDocument();
  });
});
