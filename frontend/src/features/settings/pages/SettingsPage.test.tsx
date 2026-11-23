// @vitest-environment jsdom
// Settings layout: a rail of sections, one shown at a time, a status dot where it matters, the section kept in the
// URL, and unsaved edits kept when switching sections.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';

const LIMIT_DEFAULTS = {
  synthesisMaxTokens: 32000,
  analysisMaxTokens: 32000,
  comparisonMaxTokens: 32000,
  classificationMaxTokens: 16000,
  extractionMaxTokens: 64000,
  chatMaxTokens: 16000,
  emailDraftMaxTokens: 16000,
  autoQuoteMaxTokens: 16000,
  uploadMaxFileMb: 25,
  uploadMaxFiles: 20,
  rateWorkbookMaxMb: 20,
  claudeResponseTimeoutMinutes: 15,
  npiTimeoutSeconds: 15,
  driveTimeoutSeconds: 120,
  gmailTimeoutSeconds: 60,
  connectionTestTimeoutSeconds: 25,
  ocrMaxPages: 10,
  reportPerDocChars: 80000,
  extractionPerDocChars: 60000,
  classificationBodyChars: 8000,
};
const limitsResponse = () => ({
  // Saved: one value changed from its default, so it can be reset.
  values: { ...LIMIT_DEFAULTS, uploadMaxFileMb: 30 },
  defaults: LIMIT_DEFAULTS,
  bounds: {
    ...Object.fromEntries(
      Object.entries(LIMIT_DEFAULTS).map(([k, v]) => [k, { min: Math.max(1, Math.round(v / 4)), max: v * 4 }]),
    ),
    synthesisMaxTokens: { min: 20000, max: 64000 },
    analysisMaxTokens: { min: 20000, max: 64000 },
    comparisonMaxTokens: { min: 20000, max: 64000 },
  },
  updatedAt: '2026-11-05T15:30:00Z',
  updatedBy: 'Dana Admin',
});
let role = 'ADMIN';
/** Imported emails not processed yet, as GET /gmail/import-settings reports them. */
let awaitingImported = 0;

const api = {
  gmailStatus: vi.fn(async () => ({
    source: 'OAUTH',
    error: null,
    configured: true,
    connected: true,
    email: 'inbox@example.test',
    mode: 'POLLING',
    lastPollAt: null,
    lastHistoryId: null,
    watchExpiresAt: null,
  })),
  gmailImportSettings: vi.fn(async () => ({
    autoImportSince: null,
    minDays: 1,
    maxDays: 90,
    pollIntervalSeconds: 60,
    minPollIntervalSeconds: 30,
    maxPollIntervalSeconds: 3600,
    awaitingProcess: awaitingImported,
  })),
  gmailImport: vi.fn(async (body: Record<string, unknown>) =>
    'today' in body
      ? { today: true, since: '2026-11-18T05:00:00.000Z', found: 4, enqueued: 3 }
      : { days: body.days, found: 4, enqueued: 3 },
  ),
  processAllImported: vi.fn(async () => ({ queued: 2 })),
  anthropicSettings: vi.fn(async () => ({
    keySet: false,
    keyHint: null,
    keyError: null,
    model: 'claude-opus-5-5',
    defaultModel: 'claude-opus-5-5',
    suggestedModels: [],
  })),
  saveAnthropicSettings: vi.fn(async (body: { model: string; apiKey?: string | null }) => ({
    keySet: false,
    keyHint: null,
    keyError: null,
    model: body.model,
    defaultModel: 'claude-opus-5-5',
    suggestedModels: [],
  })),
  automationSettings: vi.fn(async () => ({
    classification: 'AUTO',
    fieldExtraction: 'AUTO',
    npiVerification: 'AUTO',
    synthesis: 'AUTO',
    analysis: 'MANUAL',
    autoQuote: 'MANUAL',
  })),
  rateGroups: vi.fn(async () => ({
    groups: [{ name: 'rates-2026', isActive: true, importedAt: '2026-11-01T00:00:00Z' }],
    geo: { zips: 10, zipCounties: 12 },
    workbooks: [
      { workbook: 'Hours_Worked_Factor_Lookup', label: 'Hours worked factors', pricing: true, rows: { hours: 5 } },
      { workbook: 'Policy_Fees_Lookup', label: 'Policy fees', pricing: true, rows: { policy_fees: 2 } },
      { workbook: 'Rating_Deductible_Lookup', label: 'Rating deductibles', pricing: false, rows: { deductibles: 3 } },
    ],
  })),
  importRateWorkbook: vi.fn(async ({ workbook, file }: { workbook: string; file: File }) => ({
    rateGroup: 'rates-2026-11-04-hours-worked-factor',
    basedOn: 'rates-2026',
    workbook,
    file: file.name,
    rowCounts: { hours: 5 },
  })),
  systemStatus: vi.fn(async () => ({
    checkedAt: '2026-11-04T00:00:00Z',
    services: [
      { key: 'database', ok: true, detail: 'ok' },
      { key: 'npi', ok: false, detail: 'timeout' },
    ],
  })),
  connections: vi.fn(async () => []),
  skills: vi.fn(async () => [{ name: 'synthesis', version: 3, files: ['SKILL.md'], overridden: [] }]),
  limitsSettings: vi.fn(async () => limitsResponse()),
  saveLimitsSettings: vi.fn(async (_patch: Record<string, number | null>) => limitsResponse()),
};
const downloadRateWorkbook = vi.fn((_workbook: string) => undefined);
/** The settings endpoints over the network (MSW); each delegates to the programmable function above. */
const serveSettings = () =>
  mockApi({
    'GET /gmail/status': () => api.gmailStatus(),
    'GET /gmail/import-settings': () => api.gmailImportSettings(),
    'POST /gmail/import': ({ body }) => api.gmailImport(body as Record<string, unknown>),
    'POST /submissions/imported/process-all': () => api.processAllImported(),
    'GET /settings/anthropic': () => api.anthropicSettings(),
    'PUT /settings/anthropic': ({ body }) =>
      api.saveAnthropicSettings(body as { model: string; apiKey?: string | null }),
    'GET /settings/automation': () => api.automationSettings(),
    'GET /rates/groups': () => api.rateGroups(),
    'POST /rates/import/:workbook': ({ params, body }) =>
      api.importRateWorkbook({ workbook: params.workbook!, file: (body as FormData).get('file') as File }),
    'GET /rates/export/:workbook': ({ params }) => {
      downloadRateWorkbook(params.workbook!);
      return new HttpResponse('xlsx', {
        headers: { 'Content-Disposition': `attachment; filename="${params.workbook}.xlsx"` },
      });
    },
    'GET /system/status': () => api.systemStatus(),
    'GET /ims2-queue/sync': () => ({
      configured: false,
      counts: {},
      lastSync: null,
      lastStatusChangedAt: null,
      running: false,
    }),
    'GET /settings/connections': () => api.connections(),
    'GET /skills': () => api.skills(),
    'GET /settings/limits': () => api.limitsSettings(),
    'PUT /settings/limits': ({ body }) => api.saveLimitsSettings(body as Record<string, number | null>),
  });
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', role, name: 'Admin', email: 'admin@example.test' } }),
}));
vi.mock('../../../components/notifications/NotificationProvider', () => ({
  useNotifications: () => ({
    prefs: { toasts: true, desktop: false },
    setPrefs: vi.fn(),
    desktopPermission: 'default',
    requestDesktopPermission: vi.fn(),
  }),
}));

const { SettingsPage } = await import('./SettingsPage');
const { FeedbackProvider } = await import('../../../components/feedback/FeedbackProvider');

// Wide screen, so the rail is shown rather than the small-screen tabs. Exports create a blob URL to download.
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:http://app.test/export');
  URL.revokeObjectURL = vi.fn();
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

let search = '';
function LocationProbe() {
  search = useLocation().search;
  return null;
}

const renderAt = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FeedbackProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route
              path="/settings"
              element={
                <>
                  <SettingsPage />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </FeedbackProvider>
    </QueryClientProvider>,
  );

/** axe, and the page's first render (cold imports), are slow when the whole suite runs in parallel. */
const SLOW_TEST_MS = 20_000;

const nav = () => screen.getByRole('navigation', { name: 'Settings sections' });
const visibleHeading = () =>
  screen
    .getAllByRole('heading', { level: 2 })
    .filter((h) => !h.closest('[hidden]'))
    .map((h) => h.textContent);

beforeEach(() => {
  role = 'ADMIN';
  awaitingImported = 0;
  vi.clearAllMocks();
  serveSettings();
});

describe('Settings page', () => {
  it(
    'shows the Gmail section by default and one section at a time',
    async () => {
      renderAt('/settings');
      expect(visibleHeading()).toEqual(['Gmail connection']);
      await userEvent.click(within(nav()).getByText('Rate tables'));
      expect(visibleHeading()).toEqual(['Rate tables']);
      expect(search).toBe('?section=rates');
    },
    SLOW_TEST_MS,
  );

  it(
    "imports today's emails, or the last N days, from the import section",
    async () => {
      renderAt('/settings?section=import');
      await userEvent.click(await screen.findByRole('button', { name: "Import today's emails" }));
      expect(api.gmailImport).toHaveBeenLastCalledWith({ today: true });
      expect(await screen.findByText(/Found 4 inbox emails from today \(since midnight US Eastern\)/)).toBeVisible();

      await userEvent.type(screen.getByRole('spinbutton', { name: 'Import emails from the last' }), '7');
      await userEvent.click(screen.getByRole('button', { name: 'Import now' }));
      expect(api.gmailImport).toHaveBeenLastCalledWith({ days: 7 });
      expect(await screen.findByText(/Found 4 inbox emails from the last 7 days/)).toBeVisible();
    },
    SLOW_TEST_MS,
  );

  it(
    'processes every imported email still waiting, and only when there is one',
    async () => {
      awaitingImported = 2;
      renderAt('/settings?section=import');
      await userEvent.click(await screen.findByRole('button', { name: 'Process all imported (2)' }));
      await vi.waitFor(() => expect(api.processAllImported).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('2 imported emails queued for processing.')).toBeInTheDocument();
    },
    SLOW_TEST_MS,
  );

  it(
    'disables Process all when nothing is waiting',
    async () => {
      renderAt('/settings?section=import');
      expect(await screen.findByRole('button', { name: 'Process all imported (0)' })).toBeDisabled();
    },
    SLOW_TEST_MS,
  );

  it(
    'has no accessibility violations axe can detect, in each section',
    async () => {
      const { axeViolations } = await import('../../../test/axe');
      for (const section of ['gmail', 'automation', 'rates']) {
        const { container, unmount } = renderAt(`/settings?section=${section}`);
        expect(await axeViolations(container), section).toEqual([]);
        unmount();
      }
    },
    SLOW_TEST_MS,
  );

  it('opens the section named in the URL and ignores unknown ones', () => {
    renderAt('/settings?section=automation');
    expect(visibleHeading()).toEqual(['Automation']);
    renderAt('/settings?section=nope');
    expect(visibleHeading()).toContain('Gmail connection');
  });

  it('marks sections whose state matters with a dot in the rail', async () => {
    renderAt('/settings');
    const rail = nav();
    expect(await within(rail).findByRole('img', { name: 'Connected' })).toBeInTheDocument();
    expect(await within(rail).findByRole('img', { name: 'No key' })).toBeInTheDocument();
    expect(await within(rail).findByRole('img', { name: 'Loaded' })).toBeInTheDocument();
    expect(await within(rail).findByRole('img', { name: '1 failing' })).toBeInTheDocument();
  });

  it('has no search box and no link to user management', () => {
    renderAt('/settings');
    expect(screen.queryByRole('textbox', { name: 'Search settings' })).toBeNull();
    expect(within(nav()).queryByText(/Users and roles/)).toBeNull();
  });

  it('keeps unsaved edits when switching to another section and back', async () => {
    renderAt('/settings?section=automation');
    await screen.findByText('Email classification');
    const autoButtons = screen.getAllByRole('button', { name: 'Manual' });
    await userEvent.click(autoButtons[0]!);
    expect(screen.getByText('unsaved')).toBeInTheDocument();
    await userEvent.click(within(nav()).getByText('Skills'));
    await userEvent.click(within(nav()).getByText('Automation'));
    expect(screen.getByText('unsaved')).toBeInTheDocument();
  });

  it('carries a change along the chain: Manual down to the steps that wait on it, Auto up to the steps it waits on', async () => {
    renderAt('/settings?section=automation');
    await screen.findByText('Email classification');
    const automation = screen.getByRole('region', { name: 'Automation' });
    const row = (label: string) => within(automation).getByText(label).closest('li')!;
    const pressed = (label: string) => within(row(label)).getByRole('button', { pressed: true }).textContent;

    // Saved: Synthesis Auto, Analysis and quote Manual. Auto on the quote turns Analysis (and Synthesis) on too.
    await userEvent.click(within(row('Automatic quote')).getByRole('button', { name: 'Auto' }));
    expect([pressed('Synthesis report'), pressed('Underwriting analysis'), pressed('Automatic quote')]).toEqual([
      'Auto',
      'Auto',
      'Auto',
    ]);

    // Manual on Synthesis turns off everything after it, and nothing before it.
    await userEvent.click(within(row('Synthesis report')).getByRole('button', { name: 'Manual' }));
    expect([
      pressed('NPI verification'),
      pressed('Synthesis report'),
      pressed('Underwriting analysis'),
      pressed('Automatic quote'),
    ]).toEqual(['Auto', 'Manual', 'Manual', 'Manual']);
  });

  it('uploads a single rate workbook from its row', async () => {
    const { container } = renderAt('/settings?section=rates');
    const row = (await screen.findByText('Hours worked factors')).closest('tr')!;
    expect(within(row).getByText('5 hours')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Import' }));
    const file = new File(['x'], 'Hours_Worked_Factor_Lookup_2026-11-04.xlsx');
    await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);
    // The file crossed the network as multipart form data: the server got the same workbook and file.
    await vi.waitFor(() => expect(api.importRateWorkbook).toHaveBeenCalledTimes(1));
    const sent = api.importRateWorkbook.mock.calls[0]![0];
    expect(sent.workbook).toBe('Hours_Worked_Factor_Lookup');
    expect(sent.file.name).toBe(file.name);
    expect(
      await screen.findByText(
        /Hours worked factors imported from Hours_Worked_Factor_Lookup_2026-11-04.xlsx as rate group rates-2026-11-04-hours-worked-factor/,
      ),
    ).toBeInTheDocument();
  });

  it('exports a workbook, keeps ZIP data in the same table, and has no full re-import', async () => {
    renderAt('/settings?section=rates');
    const row = (await screen.findByText('Policy fees')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Export' }));
    await vi.waitFor(() => expect(downloadRateWorkbook.mock.calls[0]).toEqual(['Policy_Fees_Lookup']));
    const zip = screen.getByText('ZIP codes to county').closest('tr')!;
    expect(within(zip).getByText('10 ZIPs · 12 ZIP–county rows')).toBeInTheDocument();
    expect(within(zip).getByRole('button', { name: 'Reload ZIP data' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-import rates/ })).toBeNull();
  });

  it('lists ZIP data first, then every lookup in one list with export and import', async () => {
    renderAt('/settings?section=rates');
    const row = (await screen.findByText('Rating deductibles')).closest('tr')!;
    expect(within(row).getByText('3 deductibles')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Import' })).toBeInTheDocument();
    const rows = screen.getAllByRole('row').map((r) => r.textContent ?? '');
    const at = (text: string) => rows.findIndex((t) => t.includes(text));
    // ZIP data first, then every workbook in one list (no group headings).
    expect(at('ZIP codes to county')).toBe(1);
    expect(at('Hours worked factors')).toBe(2);
    expect(at('Rating deductibles')).toBe(4);
    expect(at('Used for pricing')).toBe(-1);
    expect(at('Reference lookups')).toBe(-1);
  });
});

describe('Settings limits', () => {
  /** A limits group, once its fields have loaded (each shows its default under it). */
  const region = async (name: string) => {
    const found = await screen.findByRole('region', { name });
    await within(found).findAllByText(/Default [\d,]+ · allowed/);
    return found;
  };

  it('opens from ?section=limits with uploads and document text at their saved values, defaults and bounds', async () => {
    renderAt('/settings?section=limits');
    expect(visibleHeading()).toEqual(['Limits']);
    expect(within(nav()).getByText('Limits')).toBeInTheDocument();
    const uploads = await region('Uploads');
    expect(within(uploads).getByRole('spinbutton', { name: 'Max size per file' })).toHaveValue(30);
    expect(within(uploads).getByRole('spinbutton', { name: 'Max files per upload' })).toHaveValue(20);
    expect(within(uploads).getByText('Default 25 · allowed 6–100')).toBeInTheDocument();
    expect(within(uploads).getAllByText('MB')).toHaveLength(2);
    expect(within(uploads).getByText(/^Last changed by Dana Admin on /)).toBeInTheDocument();
    const text = await region('Document text & OCR');
    expect(within(text).getByRole('spinbutton', { name: 'Text kept per document (reports)' })).toHaveValue(80000);
    expect(within(text).getByText('Default 80,000 · allowed 20,000–320,000')).toBeInTheDocument();
  });

  it('saves only the changed keys of a group', async () => {
    renderAt('/settings?section=limits');
    const uploads = await region('Uploads');
    const save = within(uploads).getByRole('button', { name: 'Save uploads' });
    expect(save).toBeDisabled();
    const files = within(uploads).getByRole('spinbutton', { name: 'Max files per upload' });
    await userEvent.clear(files);
    await userEvent.type(files, '12');
    await userEvent.click(save);
    await vi.waitFor(() => expect(api.saveLimitsSettings).toHaveBeenCalled());
    expect(api.saveLimitsSettings.mock.calls[0]![0]).toEqual({ uploadMaxFiles: 12 });
    // Confirmed in a toast, outside the section.
    expect(await screen.findByRole('status')).toHaveTextContent('Saved. New work uses these limits right away.');
  });

  it('resets a key to its default by sending null', async () => {
    renderAt('/settings?section=limits');
    const uploads = await region('Uploads');
    // Already at its default: nothing to reset.
    expect(within(uploads).getByRole('button', { name: 'Reset Max files per upload to default' })).toBeDisabled();
    await userEvent.click(within(uploads).getByRole('button', { name: 'Reset Max size per file to default' }));
    expect(within(uploads).getByRole('spinbutton', { name: 'Max size per file' })).toHaveValue(25);
    await userEvent.click(within(uploads).getByRole('button', { name: 'Save uploads' }));
    await vi.waitFor(() => expect(api.saveLimitsSettings).toHaveBeenCalled());
    expect(api.saveLimitsSettings.mock.calls[0]![0]).toEqual({ uploadMaxFileMb: null });
  });

  it('shows the eight Claude output limits under the Claude section, with no retry limits', async () => {
    renderAt('/settings?section=claude');
    const out = await region('Output limits');
    expect(within(out).getByRole('spinbutton', { name: 'Automatic quote' })).toHaveValue(16000);
    expect(within(out).getByRole('spinbutton', { name: 'Classification' })).toHaveValue(16000);
    expect(within(out).getByRole('spinbutton', { name: 'Field extraction' })).toHaveValue(64000);
    expect(within(out).getAllByRole('spinbutton')).toHaveLength(8);
    expect(within(out).queryByRole('spinbutton', { name: 'Classification retry' })).toBeNull();
    expect(within(out).queryByRole('spinbutton', { name: 'Field extraction retry' })).toBeNull();
    expect(screen.queryByText(/Must be at least the/)).toBeNull();
  });

  it('puts the three report limits first in Output limits, and no report field in the Claude API section', async () => {
    renderAt('/settings?section=claude');
    const out = await region('Output limits');
    const inputs = within(out).getAllByRole('spinbutton');
    for (const [i, name] of ['Synthesis report', 'Analysis report', 'Report comparison'].entries()) {
      expect(inputs[i]).toHaveAccessibleName(name);
      expect(inputs[i]).toHaveValue(32000);
      expect(within(out).getByRole('button', { name: `Reset ${name} to default` })).toBeDisabled();
    }
    expect(inputs[3]).toHaveAccessibleName('Classification');
    expect(within(out).getAllByText('Default 32,000 · allowed 20,000–64,000')).toHaveLength(3);
    expect(screen.queryByText(/Report limit:/)).toBeNull();
    expect(screen.queryByLabelText('Synthesis & Analysis report')).toBeNull();
  });

  const typeInto = async (input: HTMLElement, value: string) => {
    await userEvent.clear(input);
    await userEvent.type(input, value);
  };

  it('saves a changed report limit to the limits settings only, as its own key', async () => {
    renderAt('/settings?section=claude');
    const out = await region('Output limits');
    await typeInto(within(out).getByRole('spinbutton', { name: 'Analysis report' }), '40000');
    await userEvent.click(within(out).getByRole('button', { name: 'Save output limits' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/^Saved./);
    await vi.waitFor(() => expect(api.saveLimitsSettings).toHaveBeenCalled());
    expect(api.saveLimitsSettings.mock.calls).toEqual([[{ analysisMaxTokens: 40000 }]]);
    expect(api.saveAnthropicSettings).not.toHaveBeenCalled();
  });

  it('saves a changed output limit to the limits settings only', async () => {
    renderAt('/settings?section=claude');
    const out = await region('Output limits');
    await typeInto(within(out).getByRole('spinbutton', { name: 'Chat answer' }), '20000');
    await userEvent.click(within(out).getByRole('button', { name: 'Save output limits' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/^Saved./);
    await vi.waitFor(() => expect(api.saveLimitsSettings).toHaveBeenCalled());
    expect(api.saveLimitsSettings.mock.calls).toEqual([[{ chatMaxTokens: 20000 }]]);
    expect(api.saveAnthropicSettings).not.toHaveBeenCalled();
  });

  it('flags a report limit outside its bounds', async () => {
    renderAt('/settings?section=claude');
    const out = await region('Output limits');
    await typeInto(within(out).getByRole('spinbutton', { name: 'Report comparison' }), '10000');
    expect(within(out).getByText('Enter a whole number from 20,000 to 64,000')).toBeInTheDocument();
    expect(within(out).getByRole('button', { name: 'Save output limits' })).toBeDisabled();
  });

  it('shows timeouts under Connections and flags a value out of bounds', async () => {
    renderAt('/settings?section=connections');
    const t = await region('Timeouts');
    const npi = within(t).getByRole('spinbutton', { name: 'NPI registry' });
    await userEvent.clear(npi);
    await userEvent.type(npi, '500');
    expect(within(t).getByText('Enter a whole number from 4 to 60')).toBeInTheDocument();
    expect(within(t).getByRole('button', { name: 'Save timeouts' })).toBeDisabled();
    const gmail = within(t).getByRole('spinbutton', { name: 'Gmail' });
    expect(gmail).toHaveValue(60);
    expect(within(t).getByText('Default 60 · allowed 15–240')).toBeInTheDocument();
  });

  it('shows the overall Claude answer timeout, in minutes, under the Claude section', async () => {
    renderAt('/settings?section=claude');
    const t = await region('Timeout');
    expect(within(t).getByRole('spinbutton', { name: 'Claude answer (overall)' })).toHaveValue(15);
    expect(within(t).getByText('minutes')).toBeInTheDocument();
    expect(
      within(t).getByText('The longest one Claude answer may take, start to finish. Default 15 · allowed 4–60'),
    ).toBeInTheDocument();
  });

  it('is read-only for non-admins', async () => {
    role = 'UNDERWRITER';
    renderAt('/settings?section=limits');
    const uploads = await region('Uploads');
    for (const input of within(uploads).getAllByRole('spinbutton')) expect(input).toBeDisabled();
    expect(within(uploads).queryByRole('button', { name: 'Save uploads' })).toBeNull();
    expect(within(uploads).queryByRole('button', { name: /Reset .* to default/ })).toBeNull();
    expect(within(uploads).getByText('Only administrators can change these limits.')).toBeInTheDocument();
  });

  it('rejects a rate workbook over the size limit without uploading it', async () => {
    const { container } = renderAt('/settings?section=rates');
    const row = (await screen.findByText('Hours worked factors')).closest('tr')!;
    expect(await screen.findByText('.xlsx, up to 20 MB')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Import' }));
    const file = new File(['x'], 'Hours_Worked_Factor_Lookup_big.xlsx');
    Object.defineProperty(file, 'size', { value: 21 * 1024 * 1024 });
    await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);
    expect(api.importRateWorkbook).not.toHaveBeenCalled();
    expect(
      screen.getByText(/over the 20 MB limit: Hours_Worked_Factor_Lookup_big\.xlsx \(21\.0 MB\)/),
    ).toBeInTheDocument();
  });
});
