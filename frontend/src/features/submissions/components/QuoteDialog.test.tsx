// @vitest-environment jsdom
// Editing a saved quote: prefilled from that version, saved as a new one that names it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import type { Quote, RateOptions } from '../../../types';

const api = {
  ratingInputs: vi.fn(),
  quoteEditInputs: vi.fn(),
  // The active group differs from the one the submission prices with: the notice must not use it.
  rateOptions: vi.fn(
    async (_state?: string): Promise<Partial<RateOptions>> => ({
      rateGroup: 'rates-active',
      states: ['TX'],
      surgeryTypes: [],
      hours: [],
      scheduledCredits: [],
      policyFees: [],
      limits: [],
      ratingFees: [],
    }),
  ),
  previewQuote: vi.fn(),
  createQuote: vi.fn(async (..._args: unknown[]) => ({})),
  updateQuote: vi.fn(async (..._args: unknown[]) => ({ version: 2 })),
  specialityOptions: vi.fn(),
};
// The dialog reaches these over the network (MSW), through the real API client, with the same arguments.
type Inputs = { inputs: unknown; basedOn?: string; index?: number; title?: string };
const serveRating = () =>
  mockApi({
    'GET /submissions/:id/rating-inputs': ({ params }) => api.ratingInputs(params.id),
    'GET /submissions/:id/quotes/:quoteId/inputs': ({ params }) => api.quoteEditInputs(params.id, params.quoteId),
    'GET /rates/options': ({ query }) => api.rateOptions(query.get('state') ?? undefined),
    'POST /submissions/:id/quotes/preview': ({ params, body }) => api.previewQuote(params.id, (body as Inputs).inputs),
    'POST /submissions/:id/quotes': ({ params, body }) =>
      api.createQuote(params.id, (body as Inputs).inputs, (body as Inputs).basedOn),
    'PUT /submissions/:id/quotes/:quoteId': ({ params, body }) =>
      api.updateQuote(params.id, params.quoteId, (body as Inputs).inputs),
    'POST /submissions/:id/speciality-options': ({ params, body }) =>
      api.specialityOptions(params.id, (body as Inputs).inputs, (body as Inputs).index, (body as Inputs).title),
  });

const { QuoteDialog } = await import('./QuoteDialog');

const from = {
  id: 'q-2',
  version: 2,
  label: 'Option A',
  status: 'QUOTED',
  rateGroup: 'rates-2026-01',
} as unknown as Quote;
const prefill = (rateGroup: string) => ({
  inputs: {
    state: 'TX',
    zip: '78701',
    uwCreditPercent: -10,
    label: 'Option A',
    specialities: [{ code: '80420', practicePercent: 100 }],
  },
  sources: {
    state: 'quote v2',
    zip: 'quote v2',
    uwCreditPercent: 'quote v2',
    label: 'quote v2',
    specialities: 'quote v2',
  },
  rateGroup,
});

const renderDialog = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <QuoteDialog submissionId="s-1" from={from} onClose={() => {}} />
    </QueryClientProvider>,
  );

describe('QuoteDialog edit mode', () => {
  beforeEach(() => {
    serveRating();
  });
  afterEach(() => vi.clearAllMocks());

  it('prefills from the saved quote and saves a new version based on it', async () => {
    api.quoteEditInputs.mockResolvedValue(prefill('rates-2026-11'));
    renderDialog();
    expect(screen.getByText('Edit quote v2')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Option A')).toBeInTheDocument();
    expect(screen.getByDisplayValue('-10')).toBeInTheDocument();
    expect(api.quoteEditInputs).toHaveBeenCalledWith('s-1', 'q-2');
    expect(api.ratingInputs).not.toHaveBeenCalled();
    expect(screen.getByText(/Re-priced with rate tables rates-2026-11; v2 used rates-2026-01/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    expect(api.createQuote).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({ uwCreditPercent: -10, label: 'Option A' }),
      'q-2',
    );
    expect(api.updateQuote).not.toHaveBeenCalled();
  });

  it('saves the changes over the quote being edited, keeping its version', async () => {
    api.quoteEditInputs.mockResolvedValue(prefill('rates-2026-01'));
    renderDialog();
    await screen.findByDisplayValue('Option A');
    await userEvent.clear(screen.getByDisplayValue('-10'));
    await userEvent.type(screen.getByLabelText(/UW credit/), '-5');

    await userEvent.click(screen.getByRole('button', { name: 'Save changes to v2' }));
    expect(api.updateQuote).toHaveBeenCalledWith('s-1', 'q-2', expect.objectContaining({ uwCreditPercent: -5 }));
    expect(api.createQuote).not.toHaveBeenCalled();
  });

  it('shows no rate-table notice when the save prices with the tables the quote used', async () => {
    api.quoteEditInputs.mockResolvedValue(prefill('rates-2026-01'));
    renderDialog();
    await screen.findByDisplayValue('Option A');
    expect(screen.queryByText(/Re-priced with rate tables/)).toBeNull();
  });
});

describe('QuoteDialog manual specialty factor', () => {
  beforeEach(() => {
    serveRating();
  });
  afterEach(() => vi.clearAllMocks());
  const withSpecialty = (title: string) => ({
    ...prefill('rates-2026-01'),
    inputs: { ...prefill('rates-2026-01').inputs, specialities: [{ title, practicePercent: 100 }] },
  });
  const option = (score: number) => ({
    rank: 1,
    code: 'SP_78',
    title: 'Family Medicine',
    description: null,
    surgeryType: 'No Surgery',
    specialityClass: 1,
    factorState: 'FL',
    score,
    matchedFrom: 'fuzzy',
    recommended: true,
    lowestPremium: false,
    weak: score < 60,
    quote: { status: 'QUOTED', premium: 1, total: 1, missing: [] },
  });

  it('lets an underwriter rate an unmatched specialty with a factor and a reason, under the name as written', async () => {
    api.quoteEditInputs.mockResolvedValue(withSpecialty('Hyperbaric wound care'));
    api.rateOptions.mockResolvedValue({
      rateGroup: 'rates-2026-01',
      states: ['TX'],
      surgeryTypes: [],
      hours: [],
      scheduledCredits: [],
      policyFees: [],
      limits: [],
      ratingFees: [],
      manualFactor: { min: 0.1, max: 10 },
    } as never);
    api.specialityOptions.mockResolvedValue({
      state: 'TX',
      requested: 'Hyperbaric wound care',
      index: 0,
      rateGroup: 'r',
      options: [option(40)],
    });
    renderDialog();
    await screen.findByDisplayValue('Hyperbaric wound care');

    await userEvent.click(screen.getByRole('button', { name: 'Find the rate class' }));
    await userEvent.click(await screen.findByRole('button', { name: /None of these fit/ }));
    const save = screen.getByRole('button', { name: 'Save as new version' });
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Manual factor'), '135');
    expect(screen.getByText(/Factor: Between 0.1 and 10/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Manual factor'));
    await userEvent.type(screen.getByLabelText('Manual factor'), '1.35');
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: /Reason for the manual factor/ }), 'Carrier agreed');
    expect(save).toBeEnabled();

    await userEvent.click(save);
    expect(api.createQuote).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({
        specialities: [
          { title: 'Hyperbaric wound care', practicePercent: 100, manualFactor: 1.35, manualReason: 'Carrier agreed' },
        ],
      }),
      'q-2',
    );
    // Several fields typed into: slow under a full parallel run.
  }, 15_000);

  it('offers no manual factor when the specialty matches a rate class exactly', async () => {
    api.quoteEditInputs.mockResolvedValue(withSpecialty('Family Medicine'));
    api.specialityOptions.mockResolvedValue({
      state: 'TX',
      requested: 'Family Medicine',
      index: 0,
      rateGroup: 'r',
      options: [option(100)],
    });
    renderDialog();
    await screen.findByDisplayValue('Family Medicine');
    await userEvent.click(screen.getByRole('button', { name: 'Find the rate class' }));
    expect(
      await screen.findByText(/matches SP_78 exactly, so it is rated with the rate table's factor/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /None of these fit/ })).toBeNull();
  });
});
