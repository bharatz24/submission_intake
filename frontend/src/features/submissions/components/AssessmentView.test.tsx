// @vitest-environment jsdom
// Recording a decision: the form starts with nothing chosen, insists on an outcome and risk level, and is cleared
// again once the decision is saved.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import type { Assessment, Quote } from '../../../types';

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Uma Writer', role: 'UNDERWRITER' } }),
}));
vi.mock('../../../hooks/useUnsavedChanges', () => ({ UnsavedChangesGuard: () => null }));
vi.mock('./Ims2IntakeQueueCard', () => ({ Ims2IntakeQueueCard: () => null }));

const { AssessmentView } = await import('./AssessmentView');

const saved: Assessment = {
  id: 'a1',
  version: 1,
  decision: 'DECLINE',
  riskRating: 'HIGH',
  notes: 'Too many open claims for the specialty.',
  analysisReportId: null,
  contextVersion: 1,
  createdBy: { id: 'u1', name: 'Uma Writer' },
  createdAt: '2026-11-17T10:00:00Z',
};

const renderView = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <MemoryRouter>
        <AssessmentView submissionId="s1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('AssessmentView', () => {
  it('requires an outcome and risk level, then clears the form after saving (a decline needs no quote)', async () => {
    let history: Assessment[] = [];
    const api = mockApi({
      'GET /submissions/:id/assessments': () => ({ items: history }),
      'GET /submissions/:id/reports': () => ({ items: [] }),
      'GET /submissions/:id/quotes': () => [],
      'POST /submissions/:id/assessments': () => {
        history = [saved];
        return saved;
      },
    });
    const user = userEvent.setup();
    renderView();

    // The outcome buttons are named by their tooltip, so find them by their text.
    const decline = (await screen.findByText('Decline')).closest('button') as HTMLElement;
    const high = screen.getByRole('button', { name: 'High' });
    expect(decline).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { pressed: true })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Reason for decision'), saved.notes);
    await user.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(await screen.findByText('Choose an outcome.')).toBeInTheDocument();
    expect(screen.getByText('Choose a risk level.')).toBeInTheDocument();
    expect(api['POST /submissions/:id/assessments']).not.toHaveBeenCalled();

    await user.click(decline);
    await user.click(high);
    await user.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(await screen.findByText(/^Saved:/)).toBeInTheDocument();
    expect(api['POST /submissions/:id/assessments']).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          decision: 'DECLINE',
          riskRating: 'HIGH',
          notes: saved.notes,
        },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('Reason for decision')).toHaveValue(''));
    expect(screen.queryByRole('button', { pressed: true })).not.toBeInTheDocument();

    // Entering the same decision again is refused before anything is sent.
    await user.click(decline);
    await user.click(high);
    await user.type(screen.getByLabelText('Reason for decision'), saved.notes);
    await user.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(await screen.findByText(/already the current one/)).toBeInTheDocument();
    expect(api['POST /submissions/:id/assessments']).toHaveBeenCalledTimes(1);
  }, 20_000); // typing the reason twice is slow under jsdom

  describe('accepting needs a primary quote priced above zero', () => {
    const quote = (over: Partial<Quote>) => ({ id: 'q1', version: 1, status: 'QUOTED', isPrimary: true, ...over });
    const setup = (quotes: unknown[]) =>
      mockApi({
        'GET /submissions/:id/assessments': () => ({ items: [] }),
        'GET /submissions/:id/reports': () => ({ items: [] }),
        'GET /submissions/:id/quotes': () => quotes,
        'POST /submissions/:id/assessments': () => ({ ...saved, decision: 'ACCEPT', riskRating: 'LOW' }),
      });
    const outcome = async (label: string) => (await screen.findByText(label)).closest('button') as HTMLElement;
    const fill = async (label: string) => {
      const user = userEvent.setup();
      renderView();
      await user.click(await outcome(label));
      await user.click(screen.getByRole('button', { name: 'Low' }));
      await user.type(screen.getByLabelText('Reason for decision'), 'Standard limits.');
      return user;
    };
    const saveButton = () => screen.getByRole('button', { name: 'Save decision' });

    it('explains and disables saving an accept when there is no primary quote', async () => {
      const api = setup([quote({ isPrimary: false, premium: 1000, total: 1100 })]);
      const user = await fill('Accept');
      expect(await screen.findByText(/has no primary quote/)).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
      expect(api['POST /submissions/:id/assessments']).not.toHaveBeenCalled();

      // Another outcome needs no quote: the message goes and the button is enabled again.
      await user.click(await outcome('Refer'));
      expect(screen.queryByText(/has no primary quote/)).not.toBeInTheDocument();
      expect(saveButton()).toBeEnabled();
    });

    it('disables saving an accept with conditions when the primary quote is not priced above $0', async () => {
      const api = setup([quote({ premium: 0, total: 0 })]);
      await fill('Accept with conditions');
      expect(await screen.findByText(/no premium or total above \$0/)).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
      expect(api['POST /submissions/:id/assessments']).not.toHaveBeenCalled();
    });

    it('saves an accept once the primary quote is priced', async () => {
      const priced = setup([quote({ premium: 1000, total: 1100 })]);
      const user = await fill('Accept');
      expect(saveButton()).toBeEnabled();
      await user.click(saveButton());
      await waitFor(() => expect(priced['POST /submissions/:id/assessments']).toHaveBeenCalledTimes(1));
    });
  });
});
