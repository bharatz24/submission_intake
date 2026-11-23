// @vitest-environment jsdom
// Retry from failed step: the submission's "Processing failed at …" banner, the auto-retry note while a temporary
// failure waits, and the Errors tab's per-row retry and Retry all.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import { apiError } from '../../../test/msw/handlers';
import type { AutomationSettings, SubmissionDetail, SubmissionSummary } from '../../../types';

const ID = '11111111-2222-4333-8444-555555555555';
const AUTO: AutomationSettings = {
  classification: 'AUTO',
  fieldExtraction: 'AUTO',
  npiVerification: 'AUTO',
  synthesis: 'AUTO',
  analysis: 'AUTO',
  autoQuote: 'AUTO',
};
const automation: AutomationSettings = AUTO;
let role = 'UNDERWRITER';

const summary = (over: Partial<SubmissionSummary> = {}): SubmissionSummary => ({
  id: ID,
  subject: 'New application',
  fromAddress: 'broker@example.test',
  receivedAt: '2026-11-05T10:00:00Z',
  status: 'READY_FOR_REVIEW',
  classification: 'SUBMISSION',
  classificationConfidence: 0.9,
  classificationReasons: ['Has an application'],
  applicantName: 'Dr. Jane Roe',
  applicantType: 'INDIVIDUAL',
  applicantFirstName: 'Jane',
  applicantLastName: 'Roe',
  applicantEntityName: null,
  documentCount: 0,
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
const detail = (over: Partial<SubmissionDetail> = {}): SubmissionDetail => ({
  ...summary(over),
  email: { gmailMessageId: null } as unknown as SubmissionDetail['email'],
  documents: [],
  attachmentGaps: [],
  extractedFields: [],
  manualFields: [],
  coverage: {} as SubmissionDetail['coverage'],
  npiVerifications: [],
  latestSynthesis: null,
  latestAnalysis: null,
  latestAssessment: null,
  duplicates: [],
  ...over,
});
let current: SubmissionDetail = detail();

const inboxPage = (items: SubmissionSummary[], counts: Record<string, number> = { submissions: 1 }) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  classifying: 0,
  counts,
  unread: { submissions: 0, ignored: 0, duplicates: 0, errors: 0 },
});
let inbox = inboxPage([summary({ status: 'NEW', heldForClassification: true, classification: 'REVIEW_REQUIRED' })]);
let retryFails = false;
/** What the server answers after a re-run is queued (the job not yet taken by a worker); null leaves it as it was. */
let afterReprocess: SubmissionDetail | null = null;
/** The endpoints the workspace and the inbox call, answered over the MSW network. */
const routes = () =>
  mockApi({
    'GET /settings/automation': () => automation,
    'GET /settings/limits': () => apiError(503, 'UNAVAILABLE', 'not needed'),
    'GET /submissions/:id': () => current,
    'POST /submissions/:id/read': () => ({ unread: 0 }),
    'POST /submissions/:id/reprocess': () => {
      if (afterReprocess) current = afterReprocess;
      return { ok: true };
    },
    'POST /submissions/:id/retry': () =>
      retryFails ? apiError(409, 'ALREADY_QUEUED', 'ALREADY_QUEUED: a run is already queued') : { ok: true },
    'POST /submissions/errors/retry-all': () => ({ queued: 1 }),
    'POST /submissions/:id/npi/verify': () => [],
    'GET /users': () => [],
    'GET /submissions/:id/reports': () => ({ items: [] }),
    'GET /submissions/:id/quotes': () => [],
    'GET /submissions': () => inbox,
    'GET /gmail/status': () => ({ configured: false, connected: false }),
    'GET /ingest-queue/failed': () => ({ items: [] }),
    'GET /skipped-emails': () => ({ items: [], total: 0, page: 1, pageSize: 1 }),
    'GET /ims2-queue/sync': () => null,
  });
let api: ReturnType<typeof routes>;
const withId = expect.objectContaining({ params: { id: ID } });
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', role, name: 'Uma', email: 'uma@example.test' } }),
}));
vi.mock('../../../components/notifications/NotificationProvider', () => ({
  useNotifications: () => ({ markRead: vi.fn() }),
}));
// Cards these tests do not look at.
vi.mock('../components/ClaudeChat', () => ({ ClaudeChat: () => null }));
vi.mock('../components/EmailDraftDialog', () => ({ EmailDraftDialog: () => null }));
vi.mock('../components/EmailCard', () => ({ EmailCard: () => null }));
vi.mock('../components/SentEmailsCard', () => ({ SentEmailsCard: () => null }));
vi.mock('../components/AttachmentsCard', () => ({ AttachmentsCard: () => null }));
vi.mock('../components/EmailComposeDialog', () => ({ EmailComposeDialog: () => null }));
vi.mock('../components/CompareView', () => ({ CompareView: () => null }));
vi.mock('../components/AssessmentView', () => ({ AssessmentView: () => null }));
vi.mock('../components/VersionTimeline', () => ({ VersionTimeline: () => null }));
vi.mock('../components/RequiredInfoCard', () => ({ RequiredInfoCard: () => null }));
vi.mock('../components/NpiEntryBar', () => ({ NpiEntryBar: () => null }));
vi.mock('../components/NpiMatchReview', () => ({ NpiMatchReview: () => null }));
vi.mock('../components/NpiDetailsDialog', () => ({ NpiDetailsDialog: () => null }));
vi.mock('../components/DocumentViewerDialog', () => ({ DocumentViewerDialog: () => null }));
vi.mock('../../audit/AuditTrail', () => ({ SubmissionAuditList: () => null }));

const { SubmissionWorkspace } = await import('./SubmissionWorkspace');
const { SubmissionInbox } = await import('./SubmissionInbox');
const { FeedbackProvider } = await import('../../../components/feedback/FeedbackProvider');

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
});

beforeEach(() => {
  role = 'UNDERWRITER';
  current = detail();
  retryFails = false;
  afterReprocess = null;
  inbox = inboxPage([summary({ status: 'NEW', heldForClassification: true, classification: 'REVIEW_REQUIRED' })]);
  api = routes();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const openTab = (tab?: string) =>
  render(
    <QueryClientProvider client={client()}>
      <FeedbackProvider>
        <MemoryRouter initialEntries={[`/submissions/${ID}${tab ? `?tab=${tab}` : ''}`]}>
          <Routes>
            <Route path="/submissions/:id" element={<SubmissionWorkspace />} />
          </Routes>
        </MemoryRouter>
      </FeedbackProvider>
    </QueryClientProvider>,
  );
const failed = (over: Partial<SubmissionDetail> = {}) =>
  detail({
    status: 'ERROR',
    processingError: 'Claude returned an invalid response',
    pipeline: {
      completedSteps: ['classification', 'documents'],
      failedStep: 'fields',
      error: 'Claude returned an invalid response',
      autoRetrying: false,
    },
    ...over,
  });
const banner = async () =>
  (await screen.findByText('Processing failed at Field extraction')).closest('[role="alert"]') as HTMLElement;

describe('Processing failed banner', () => {
  it('shows the failed step, its error and the steps already done', async () => {
    current = failed();
    openTab();
    const b = await banner();
    expect(b).toHaveTextContent('Claude returned an invalid response');
    expect(b).toHaveTextContent('Already done: Classification, Reading documents');
  });

  it('omits the done line when no step finished', async () => {
    current = failed({
      pipeline: { completedSteps: [], failedStep: 'classification', error: 'boom', autoRetrying: false },
    });
    openTab();
    const b = (await screen.findByText('Processing failed at Classification')).closest('[role="alert"]') as HTMLElement;
    expect(b).toHaveTextContent('boom');
    expect(b).not.toHaveTextContent('Already done');
  });

  it('Retry from failed step calls the retry endpoint, not reprocess', async () => {
    current = failed();
    openTab();
    await userEvent.click(within(await banner()).getByRole('button', { name: 'Retry from failed step' }));
    await vi.waitFor(() => expect(api['POST /submissions/:id/retry']).toHaveBeenCalledWith(withId));
    expect(api['POST /submissions/:id/reprocess']).not.toHaveBeenCalled();
  });

  it('shows a retry error as a toast', async () => {
    retryFails = true;
    current = failed();
    openTab();
    await userEvent.click(within(await banner()).getByRole('button', { name: 'Retry from failed step' }));
    // A toast, not text inside the banner.
    const toast = await screen.findByText(/ALREADY_QUEUED/);
    expect(within(await banner()).queryByText(/ALREADY_QUEUED/)).toBeNull();
    expect(toast.closest('[role="alert"]')).not.toBeNull();
  });

  it('Re-run everything calls reprocess', async () => {
    current = failed();
    openTab();
    await userEvent.click(within(await banner()).getByRole('button', { name: 'Re-run everything' }));
    await vi.waitFor(() => expect(api['POST /submissions/:id/reprocess']).toHaveBeenCalledWith(withId));
    expect(api['POST /submissions/:id/retry']).not.toHaveBeenCalled();
  });

  it('shows the banner without buttons to a viewer', async () => {
    role = 'VIEWER';
    current = failed();
    openTab();
    const b = await banner();
    expect(b).toHaveTextContent('Claude returned an invalid response');
    expect(within(b).queryByRole('button')).toBeNull();
  });

  it('says a temporary failure is retrying automatically, without the failed banner', async () => {
    current = detail({
      status: 'PROCESSING',
      pipeline: {
        completedSteps: ['classification'],
        failedStep: 'documents',
        error: 'overloaded',
        autoRetrying: true,
      },
    });
    openTab();
    expect(
      await screen.findByText('A temporary problem with Reading documents — retrying automatically.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Processing failed at/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry from failed step' })).toBeNull();
  });

  it('Re-run everything shows the progress at once, before a worker takes the job, without a reload', async () => {
    current = failed();
    // Queued: progress cleared and documents reset, but the status is still ERROR until a worker starts the run.
    afterReprocess = failed({
      processingQueued: true,
      pipeline: { completedSteps: [], failedStep: null, error: null, autoRetrying: false },
    });
    openTab();
    await userEvent.click(within(await banner()).getByRole('button', { name: 'Re-run everything' }));
    expect(await screen.findByRole('progressbar', { name: 'Processing progress' })).toBeInTheDocument();
    expect(screen.queryByText(/Processing failed at/)).toBeNull();
  });
});

describe('Re-run extraction + NPI (Overview)', () => {
  it.each(['READY_FOR_REVIEW', 'IN_REVIEW'] as const)(
    'shows the progress from the click on a %s submission, and stops a second click',
    async (status) => {
      current = detail({ status });
      afterReprocess = detail({ status, processingQueued: true });
      openTab();
      expect(screen.queryByRole('progressbar', { name: 'Processing progress' })).toBeNull();
      await userEvent.click(await screen.findByRole('button', { name: 'Re-run extraction + NPI' }));
      expect(await screen.findByRole('progressbar', { name: 'Processing progress' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Re-run extraction + NPI' })).toBeDisabled();
    },
  );
});

describe('Errors tab', () => {
  const openErrors = () => {
    inbox = inboxPage(
      [
        summary({
          status: 'ERROR',
          processingError: 'Claude returned an invalid response',
          pipeline: {
            completedSteps: ['classification', 'documents'],
            failedStep: 'fields',
            error: 'Claude returned an invalid response',
            autoRetrying: false,
          },
        }),
      ],
      { submissions: 0, ignored: 0, duplicates: 0, errors: 1 },
    );
    render(
      <QueryClientProvider client={client()}>
        <FeedbackProvider>
          <MemoryRouter initialEntries={['/?view=errors']}>
            <SubmissionInbox />
          </MemoryRouter>
        </FeedbackProvider>
      </QueryClientProvider>,
    );
  };

  it('shows the failed step and retries the row from it', async () => {
    openErrors();
    expect(await screen.findByText('Failed at Field extraction')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry from failed step' }));
    await vi.waitFor(() => expect(api['POST /submissions/:id/retry']).toHaveBeenCalledWith(withId));
    expect(api['POST /submissions/:id/reprocess']).not.toHaveBeenCalled();
  });

  it('labels Retry all as continuing from the failed step', async () => {
    openErrors();
    await userEvent.click(await screen.findByRole('button', { name: 'Retry all from failed step (1)' }));
    await vi.waitFor(() => expect(api['POST /submissions/errors/retry-all']).toHaveBeenCalled());
  });
});
