// @vitest-environment jsdom
// Settings → Automation on a submission: the "Held for classification" banner and Held chip, and the "Manual" hints
// on empty tabs (shown only for a Manual step, never while held).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { bodyOf, mockApi } from '../../../test/msw/api';
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
const ALL_MANUAL: AutomationSettings = {
  classification: 'MANUAL',
  fieldExtraction: 'MANUAL',
  npiVerification: 'MANUAL',
  synthesis: 'MANUAL',
  analysis: 'MANUAL',
  autoQuote: 'MANUAL',
};
let automation: AutomationSettings = AUTO;
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

let reportsFor: (kind: string | null) => unknown[] = () => [];
let automationDown = false;
/** The endpoints the workspace, inbox and quotes card call, answered over the MSW network. */
const routes = () =>
  mockApi({
    'GET /settings/automation': () => (automationDown ? apiError(503, 'UNAVAILABLE', 'offline') : automation),
    'GET /settings/limits': () => apiError(503, 'UNAVAILABLE', 'not needed'),
    'GET /submissions/:id': () => current,
    'POST /submissions/:id/read': () => ({ unread: 0 }),
    'POST /submissions/:id/reprocess': () => ({ ok: true }),
    'POST /submissions/:id/process': () => ({ ok: true }),
    'POST /submissions/:id/npi/verify': () => [],
    'GET /users': () => [],
    'GET /submissions/:id/reports': ({ query }) => ({ items: reportsFor(query.get('kind')) }),
    'GET /submissions/:id/quotes': () => [],
    'GET /submissions': () => ({
      items: [summary({ status: 'NEW', heldForClassification: true, classification: 'REVIEW_REQUIRED' })],
      total: 1,
      page: 1,
      pageSize: 25,
      classifying: 0,
      counts: { submissions: 1 },
      unread: { submissions: 0 },
    }),
    'GET /gmail/status': () => ({ configured: false, connected: false }),
    'GET /ingest-queue/failed': () => ({ items: [] }),
    'GET /skipped-emails': () => ({ items: [], total: 0, page: 1, pageSize: 1 }),
    'GET /ims2-queue/sync': () => null,
  });
let api: ReturnType<typeof routes>;
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
const { QuotesCard } = await import('../components/QuotesCard');

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
  automation = AUTO;
  automationDown = false;
  reportsFor = () => [];
  role = 'UNDERWRITER';
  current = detail();
  api = routes();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const openTab = (tab?: string) =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[`/submissions/${ID}${tab ? `?tab=${tab}` : ''}`]}>
        <Routes>
          <Route path="/submissions/:id" element={<SubmissionWorkspace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
/** Waits for the submission and the automation modes, so a hint that should be missing is not just still loading. */
const settle = async () => {
  await screen.findByRole('heading', { name: 'Dr. Jane Roe' });
  await vi.waitFor(() => expect(api['GET /settings/automation']).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
};

describe('Submission workspace accessibility', () => {
  it('has no violations axe can detect on the overview', async () => {
    const { axeViolations } = await import('../../../test/axe');
    const { container } = openTab();
    await screen.findByRole('heading', { name: 'Dr. Jane Roe' });
    expect(await axeViolations(container)).toEqual([]);
  }, 20_000); // axe over a full page is slow when the suite runs in parallel
});

describe('Held for classification', () => {
  it('shows the banner with Change classification for a writer, which opens the override dialog', async () => {
    current = detail({ status: 'NEW', classification: null, heldForClassification: true });
    openTab();
    const banner = (await screen.findByText('Held for classification')).closest('[role="alert"]') as HTMLElement;
    expect(banner).toHaveTextContent(
      'Classification is set to Manual in Settings → Automation, so this email waits for an underwriter.',
    );
    // The held email is not "being classified".
    expect(screen.queryByText(/Classifying this email/)).toBeNull();
    await userEvent.click(within(banner).getByRole('button', { name: 'Change classification' }));
    expect(await screen.findByRole('dialog', { name: 'Change classification' })).toBeInTheDocument();
  });

  it('shows the text without the button to a viewer', async () => {
    role = 'VIEWER';
    current = detail({ status: 'NEW', classification: null, heldForClassification: true });
    openTab();
    const banner = (await screen.findByText('Held for classification')).closest('[role="alert"]') as HTMLElement;
    expect(within(banner).queryByRole('button')).toBeNull();
  });

  it('shows the banner, not the Manual hints, on a held submission', async () => {
    automation = ALL_MANUAL;
    current = detail({ status: 'NEW', classification: null, heldForClassification: true });
    openTab('npi');
    await settle();
    expect(screen.getByText('Held for classification')).toBeInTheDocument();
    expect(screen.queryByText(/NPI verification is Manual/)).toBeNull();
    expect(screen.getByText(/No verification has run yet/)).toBeInTheDocument();
  });

  it('marks a held row in the inbox with a Held chip', async () => {
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={['/']}>
          <SubmissionInbox />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Held')).toBeInTheDocument();
    await userEvent.hover(screen.getByText('Held'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Waiting for an underwriter to confirm the classification',
    );
  });

  it('shows the inbox as cards on a phone, with the Held chip and a tap opening the email (QA-004)', async () => {
    const wide = window.matchMedia;
    // Phone width: MUI's breakpoints.down('sm') asks for a max-width query.
    window.matchMedia = ((query: string) => ({ ...wide(query), matches: query.includes('max-width') })) as typeof wide;
    try {
      render(
        <QueryClientProvider client={client()}>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<SubmissionInbox />} />
              <Route path="/submissions/:id" element={<p>Workspace opened</p>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      const list = await screen.findByRole('list', { name: 'Emails' });
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(within(list).getByText('Held')).toBeInTheDocument();
      await userEvent.click(within(list).getAllByRole('link', { name: /^Open / })[0] as HTMLElement);
      expect(await screen.findByText('Workspace opened')).toBeInTheDocument();
    } finally {
      window.matchMedia = wide;
    }
  });
});

describe('Imported, not processed yet', () => {
  it('shows the banner with Process for a writer, which runs the pipeline, and no Manual hints', async () => {
    automation = ALL_MANUAL;
    current = detail({ status: 'READY_FOR_REVIEW', classification: 'SUBMISSION', heldForImport: true });
    openTab('npi');
    await settle();
    const banner = (await screen.findByText('Imported, not processed yet')).closest('[role="alert"]') as HTMLElement;
    expect(banner).toHaveTextContent('it has only been classified');
    expect(screen.queryByText(/set to Manual/)).toBeNull();
    await userEvent.click(within(banner).getByRole('button', { name: 'Process' }));
    await vi.waitFor(() => expect(api['POST /submissions/:id/process']).toHaveBeenCalledTimes(1));
  });

  it('shows the text without the button to a viewer', async () => {
    role = 'VIEWER';
    current = detail({ status: 'READY_FOR_REVIEW', classification: 'SUBMISSION', heldForImport: true });
    openTab();
    const banner = (await screen.findByText('Imported, not processed yet')).closest('[role="alert"]') as HTMLElement;
    expect(within(banner).queryByRole('button')).toBeNull();
  });
});

describe('Manual hints', () => {
  it('offers Run extraction + NPI on the empty Fields card when extraction is Manual', async () => {
    automation = ALL_MANUAL;
    openTab('documents');
    expect(
      await screen.findByText("Field extraction is Manual in Settings → Automation. Run it when you're ready."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run extraction + NPI' }));
    await vi.waitFor(() =>
      expect(api['POST /submissions/:id/reprocess']).toHaveBeenCalledWith(
        expect.objectContaining({ params: { id: ID } }),
      ),
    );
  });

  it('shows no extraction hint when extraction is Auto', async () => {
    openTab('documents');
    await settle();
    expect(screen.getByText('No fields yet')).toBeInTheDocument();
    expect(screen.queryByText(/Field extraction is Manual/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run extraction + NPI' })).toBeNull();
  });

  it('shows the extraction hint without its button to a viewer', async () => {
    role = 'VIEWER';
    automation = ALL_MANUAL;
    openTab('documents');
    expect(await screen.findByText(/Field extraction is Manual/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run extraction + NPI' })).toBeNull();
  });

  it('offers Verify NPIs on the empty NPI tab when NPI verification is Manual, and not when Auto', async () => {
    automation = ALL_MANUAL;
    const { unmount } = openTab('npi');
    expect(
      await screen.findByText("NPI verification is Manual in Settings → Automation. Run it when you're ready."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Verify NPIs' }));
    await vi.waitFor(() =>
      expect(api['POST /submissions/:id/npi/verify']).toHaveBeenCalledWith(
        expect.objectContaining({ params: { id: ID } }),
      ),
    );
    expect(bodyOf(api['POST /submissions/:id/npi/verify'])).toEqual({});
    unmount();

    automation = AUTO;
    openTab('npi');
    await settle();
    expect(screen.queryByText(/NPI verification is Manual/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verify NPIs' })).toBeNull();
  });

  it('says Synthesis is Manual on its empty tab, and not when Auto', async () => {
    automation = ALL_MANUAL;
    const { unmount } = openTab('synthesis');
    expect(
      await screen.findByText(
        "Synthesis is Manual in Settings → Automation. Generate the first version when you're ready.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate new version' })).toBeInTheDocument();
    unmount();

    automation = AUTO;
    openTab('synthesis');
    expect(await screen.findByText('Generate the first version to get started.')).toBeInTheDocument();
    expect(screen.queryByText(/Synthesis is Manual/)).toBeNull();
  });

  it('keeps "needs a Synthesis first" on Analysis, and says Analysis is Manual once a synthesis exists', async () => {
    automation = ALL_MANUAL;
    const { unmount } = openTab('analysis');
    expect(
      await screen.findByText(/Analysis needs a completed Synthesis Report first/, { selector: 'p' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Analysis is Manual/)).toBeNull();
    unmount();

    reportsFor = (kind) =>
      kind === 'SYNTHESIS' ? [{ id: 'r-1', version: 1, status: 'COMPLETED', contextVersion: 1 }] : [];
    openTab('analysis');
    expect(
      await screen.findByText(
        "Analysis is Manual in Settings → Automation. Generate the first version when you're ready.",
      ),
    ).toBeInTheDocument();
  });

  it('says automatic quoting is Manual on an empty Quotes card, and not when Auto', async () => {
    const renderCard = () =>
      render(
        <QueryClientProvider client={client()}>
          <QuotesCard submissionId={ID} />
        </QueryClientProvider>,
      );
    automation = ALL_MANUAL;
    const { unmount } = renderCard();
    expect(
      await screen.findByText(
        'Automatic quoting is Manual in Settings → Automation. Create quote prices this submission.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create quote' })).toBeInTheDocument();
    unmount();

    automation = AUTO;
    renderCard();
    expect(await screen.findByText(/Create quote prices the submission from its extracted fields/)).toBeInTheDocument();
    expect(screen.queryByText(/Automatic quoting is Manual/)).toBeNull();
  });

  it('shows no hint while the automation modes cannot be loaded', async () => {
    automationDown = true;
    openTab('npi');
    await settle();
    expect(screen.queryByText(/NPI verification is Manual/)).toBeNull();
    expect(screen.getByText(/No verification has run yet/)).toBeInTheDocument();
  });
});
