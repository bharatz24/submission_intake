// @vitest-environment jsdom
// The inbox table: rows render, each subject is a real link (keyboard and middle-click, FE-01), rows can be
// selected, and bulk delete asks first and sends the selected ids.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import { apiError } from '../../../test/msw/handlers';
import type { SubmissionSummary } from '../../../types';

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', name: 'Ada', email: 'ada@example.test' } }),
}));

const { SubmissionInbox } = await import('./SubmissionInbox');

const summary = (over: Partial<SubmissionSummary> = {}): SubmissionSummary => ({
  id: 'id-1',
  subject: 'New application',
  fromAddress: 'broker@example.test',
  receivedAt: '2026-11-05T10:00:00Z',
  status: 'READY_FOR_REVIEW',
  classification: 'SUBMISSION',
  classificationConfidence: 0.9,
  classificationReasons: [],
  applicantName: 'Dr. Jane Roe',
  applicantType: 'INDIVIDUAL',
  applicantFirstName: 'Jane',
  applicantLastName: 'Roe',
  applicantEntityName: null,
  documentCount: 2,
  npiStatus: null,
  npiVerifiedCount: 0,
  npiFailedCount: 0,
  latestSynthesisVersion: null,
  latestAnalysisVersion: null,
  assignedTo: null,
  contextVersion: 1,
  updatedAt: '2026-11-05T10:00:00Z',
  isRead: true,
  duplicateOf: null,
  duplicateBasis: null,
  processingError: null,
  heldForClassification: false,
  heldForImport: false,
  pipeline: { completedSteps: [], failedStep: null, error: null, autoRetrying: false },
  ...over,
});

const ROWS = [
  summary(),
  summary({ id: 'id-2', subject: 'Renewal for Dr. Smith', applicantName: 'Dr. Smith', isRead: false }),
];

let api: ReturnType<typeof serve>;
const serve = (remove: () => unknown = () => ({ deleted: 2 })) =>
  mockApi({
    'GET /submissions': () => ({
      items: ROWS,
      total: ROWS.length,
      page: 1,
      pageSize: 25,
      classifying: 0,
      counts: { submissions: 2, ignored: 0, duplicates: 0, errors: 0 },
      unread: { submissions: 1, ignored: 0, duplicates: 0, errors: 0 },
    }),
    'GET /gmail/status': () => ({ configured: false, connected: false }),
    'GET /ingest-queue/failed': () => ({ items: [] }),
    'GET /skipped-emails': () => ({ items: [], total: 0, page: 1, pageSize: 1 }),
    'GET /ims2-queue/sync': () => null,
    'POST /submissions/:view/delete': remove,
  });

beforeAll(() => {
  // Desktop width: the table, not the phone cards.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

beforeEach(() => {
  api = serve();
});

function renderInbox() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<SubmissionInbox />} />
          <Route path="/submissions/:id" element={<p>workspace page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Inbox table', () => {
  it('renders a row per email with its subject, sender and applicant', async () => {
    renderInbox();
    const link = await screen.findByRole('link', { name: 'New application' });
    const row = link.closest('tr') as HTMLElement;
    expect(within(row).getByText('broker@example.test')).toBeInTheDocument();
    expect(within(row).getByText('Dr. Jane Roe')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Renewal for Dr. Smith' })).toBeInTheDocument();
  });

  it('makes each subject a real link to the submission (middle-click, new tab)', async () => {
    renderInbox();
    expect(await screen.findByRole('link', { name: 'New application' })).toHaveAttribute('href', '/submissions/id-1');
  });

  it('opens a submission from the keyboard: Tab to the row link, then Enter', async () => {
    renderInbox();
    const link = await screen.findByRole('link', { name: 'New application' });
    // Tab until focus reaches the first row's link (past the toolbar and the row's checkbox).
    for (let i = 0; i < 40 && document.activeElement !== link; i++) await userEvent.tab();
    expect(link).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('workspace page')).toBeInTheDocument();
  });

  it('selects rows and deletes them after confirming', async () => {
    renderInbox();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select New application' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Renewal for Dr. Smith' }));
    await userEvent.click(screen.getByRole('button', { name: /Delete selected \(2\)/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete selected submissions?' });
    expect(within(dialog).getByText(/2 submissions will be removed from the inbox for everyone/)).toBeInTheDocument();
    expect(api['POST /submissions/:view/delete']).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete 2' }));

    await vi.waitFor(() => expect(api['POST /submissions/:view/delete']).toHaveBeenCalledTimes(1));
    const call = api['POST /submissions/:view/delete'].mock.calls[0]![0];
    expect(call.params.view).toBe('submissions');
    expect(call.body).toEqual({ ids: ['id-1', 'id-2'] });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the delete dialog open with the reason when the server refuses', async () => {
    api = serve(() => apiError(409, 'BUSY', 'One of these emails is still being processed.'));
    renderInbox();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select New application' }));
    await userEvent.click(screen.getByRole('button', { name: /Delete selected \(1\)/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete selected submissions?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete 1' }));
    expect(await within(dialog).findByText('One of these emails is still being processed.')).toBeInTheDocument();
  });
});
