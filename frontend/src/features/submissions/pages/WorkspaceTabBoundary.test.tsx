// @vitest-environment jsdom
// FE-12: a tab that throws while rendering shows a recoverable message in its place; the submission header and the
// tab bar stay usable, and another tab renders normally.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import { apiError } from '../../../test/msw/handlers';
import type { SubmissionDetail } from '../../../types';

const ID = '11111111-2222-4333-8444-555555555555';

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', role: 'UNDERWRITER', name: 'Uma', email: 'uma@example.test' } }),
}));
vi.mock('../../../components/notifications/NotificationProvider', () => ({
  useNotifications: () => ({ markRead: vi.fn() }),
}));
// The tab under test throws; the others are stand-ins.
vi.mock('../workspace/OverviewTab', () => ({
  OverviewTab: () => {
    throw new Error('Cannot read properties of undefined (reading "limits")');
  },
}));
vi.mock('../workspace/DocumentsTab', () => ({ DocumentsTab: () => <p>documents tab content</p> }));
vi.mock('../components/ClaudeChat', () => ({ ClaudeChat: () => null }));
vi.mock('../components/EmailDraftDialog', () => ({ EmailDraftDialog: () => null }));
vi.mock('../components/EmailComposeDialog', () => ({ EmailComposeDialog: () => null }));
vi.mock('../components/OverrideDialog', () => ({ OverrideDialog: () => null }));

const { SubmissionWorkspace } = await import('./SubmissionWorkspace');

const detail = {
  id: ID,
  subject: 'New application',
  fromAddress: 'broker@example.test',
  receivedAt: '2026-11-05T10:00:00Z',
  status: 'READY_FOR_REVIEW',
  classification: 'SUBMISSION',
  classificationConfidence: 0.9,
  classificationReasons: [],
  applicantName: 'Dr. Jane Roe',
  applicantType: 'INDIVIDUAL',
  documentCount: 0,
  npiStatus: null,
  npiVerifiedCount: 0,
  npiFailedCount: 0,
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
  email: { gmailMessageId: null },
  documents: [],
  attachmentGaps: [],
  extractedFields: [],
  manualFields: [],
  coverage: {},
  npiVerifications: [],
  latestSynthesis: null,
  latestAnalysis: null,
  latestAssessment: null,
  duplicates: [],
} as unknown as SubmissionDetail;

beforeAll(() => {
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
  // React logs the caught render error; the boundary under test handles it.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

describe('SubmissionWorkspace tab error boundary', () => {
  it('contains a throwing tab and keeps the rest of the workspace working', async () => {
    mockApi({
      'GET /submissions/:id': () => detail,
      'POST /submissions/:id/read': () => ({ unread: 0 }),
      'GET /settings/automation': () => apiError(503, 'UNAVAILABLE', 'not needed'),
      'GET /settings/limits': () => apiError(503, 'UNAVAILABLE', 'not needed'),
      'GET /users': () => [],
      'GET /submissions/:id/reports': () => ({ items: [] }),
      'GET /submissions/:id/quotes': () => [],
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[`/submissions/${ID}`]}>
          <Routes>
            <Route path="/submissions/:id" element={<SubmissionWorkspace />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // The broken Overview tab is replaced by the boundary's message...
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    // ...while the header and the tab bar are still there.
    expect(screen.getByRole('heading', { name: 'Dr. Jane Roe' })).toBeInTheDocument();
    const documents = screen.getByRole('tab', { name: /Documents & Evidence/ });

    // Another tab renders normally: switching tab clears the error.
    await userEvent.click(documents);
    expect(await screen.findByText('documents tab content')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });
});
