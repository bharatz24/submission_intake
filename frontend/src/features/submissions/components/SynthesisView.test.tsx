// @vitest-environment jsdom
// A Synthesis on the report page: the grounding summary, the inline "Not found in source" marker on the unverified
// fact, and "Mark reviewed" on a report generated automatically.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import type { Report } from '../../../types';

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Uma Writer', role: 'UNDERWRITER' } }),
}));

const { SynthesisView } = await import('./SynthesisView');
// The markdown renderer is lazy (FE-05): load it once up front so no test waits on its first import.
await (await import('../../../components/common')).preloadMarkdown();

const report = (over: Partial<Report> = {}): Report => ({
  id: 'r1',
  kind: 'SYNTHESIS',
  version: 1,
  status: 'COMPLETED',
  contextVersion: 1,
  basedOnReportId: null,
  skillName: 'synthesis',
  skillVersion: '1.0.0',
  model: 'mock-model',
  createdBy: null,
  createdAt: '2026-11-17T10:00:00Z',
  completedAt: '2026-11-17T10:01:00Z',
  error: null,
  needsReview: true,
  reviewedAt: null,
  reviewedBy: null,
  usage: null,
  markdown: '# Synthesis',
  content: {
    submissionOverview: 'OB/GYN submission.',
    applicantProfile: {
      name: 'Jane Smith',
      npi: null,
      specialty: 'OB/GYN',
      state: 'TX',
      practiceName: null,
      yearsInPractice: null,
      other: [],
    },
    emailAndAttachmentInventory: [],
    extractedFacts: [
      { text: 'Paid $999,999', source: 'loss_runs.pdf', confidence: 'HIGH' },
      { text: 'Effective date 01/01/2027', source: 'email body', confidence: 'HIGH' },
    ],
    npiVerificationSummary: 'none',
    conflicts: [],
    missingInformation: [],
    dataConfidence: { overall: 'MEDIUM', notes: '' },
    consolidatedContextForLlm: 'brief',
  } as unknown as Report['content'],
  grounding: {
    checked: 2,
    verified: 1,
    unverified: 1,
    items: [
      {
        path: 'extractedFacts[0]',
        text: 'Paid $999,999',
        verdict: 'unverified',
        missing: ['source: loss_runs.pdf'],
      },
    ],
  },
  ...over,
});

const renderView = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <MemoryRouter>
        <SynthesisView
          submissionId="s-1"
          applicant={{
            applicantName: 'Jane Smith',
            applicantType: null,
            applicantFirstName: null,
            applicantLastName: null,
            applicantEntityName: null,
          }}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const server = (current: () => Report) =>
  mockApi({
    'GET /settings/automation': () => ({ synthesis: 'AUTO', analysis: 'AUTO' }),
    'GET /submissions/:id/reports': () => ({ items: [current()] }),
    'GET /reports/:id': () => current(),
    'POST /submissions/:id/reports/:reportId/review': () =>
      report({ needsReview: false, reviewedBy: 'Uma Writer', reviewedAt: '2026-11-17T11:00:00Z' }),
  });

describe('SynthesisView grounding and review', () => {
  it('summarises and marks the evidence that was not found', async () => {
    server(() => report());
    renderView();
    expect(
      await screen.findByText('1 of 2 evidence items not found in the submission', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    const unverified = rows.find((r) => within(r).queryByText('Paid $999,999'));
    const verified = rows.find((r) => within(r).queryByText('Effective date 01/01/2027'));
    expect(within(unverified as HTMLElement).getByText('Not found in source', { exact: false })).toBeInTheDocument();
    expect(within(verified as HTMLElement).queryByText('Not found in source', { exact: false })).toBeNull();
  });

  it('marks an automatic report reviewed', async () => {
    let current = report();
    const api = server(() => current);
    renderView();
    expect(
      await screen.findByText('Needs review — generated automatically', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    current = report({ needsReview: false, reviewedBy: 'Uma Writer', reviewedAt: '2026-11-17T11:00:00Z' });
    await userEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(await screen.findByText(/Reviewed by Uma Writer/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(api['POST /submissions/:id/reports/:reportId/review']).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: 's-1', reportId: 'r1' } }),
    );
    expect(screen.queryByText('Needs review — generated automatically')).not.toBeInTheDocument();
  });

  it('shows no grounding warning when nothing concrete was checked', async () => {
    server(() => report({ needsReview: false, grounding: { checked: 0, verified: 0, unverified: 0, items: [] } }));
    renderView();
    expect(await screen.findByText('OB/GYN submission.', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/evidence items not found/)).not.toBeInTheDocument();
    expect(screen.queryByText('Not found in source', { exact: false })).not.toBeInTheDocument();
  });
});
