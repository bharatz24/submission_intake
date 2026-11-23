// @vitest-environment jsdom
// Monitoring → a Claude call's transcript: what was sent and returned, or a note that only hashes were kept.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import { apiError } from '../../../test/msw/handlers';
import { TranscriptDialog } from './TranscriptDialog';

const transcript = (over: Record<string, unknown> = {}) => ({
  callId: '42',
  task: 'synthesis',
  model: 'claude-opus-5-5',
  createdAt: '2026-11-17T15:00:00Z',
  systemSha256: 'a'.repeat(64),
  promptSha256: 'b'.repeat(64),
  prompt: 'Applicant SSN [REDACTED-SSN]',
  output: '{"ok":true}',
  ...over,
});

const renderDialog = (onClose = vi.fn()) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TranscriptDialog callId="42" onClose={onClose} />
    </QueryClientProvider>,
  );

describe('TranscriptDialog', () => {
  it('shows the prompt and output in scrollable monospace regions', async () => {
    mockApi({ 'GET /monitoring/llm-calls/:id/transcript': () => transcript() });
    renderDialog();
    const prompt = await screen.findByRole('region', { name: 'Prompt sent' });
    expect(prompt).toHaveTextContent('Applicant SSN [REDACTED-SSN]');
    expect(prompt.style.fontFamily || getComputedStyle(prompt).fontFamily).toMatch(/mono/i);
    expect(getComputedStyle(prompt).overflow).toBe('auto');
    expect(prompt).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('region', { name: 'Output received' })).toHaveTextContent('{"ok":true}');
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
  });

  it('says when only hashes were kept', async () => {
    mockApi({ 'GET /monitoring/llm-calls/:id/transcript': () => transcript({ prompt: null, output: null }) });
    renderDialog();
    expect(await screen.findAllByText('Not stored for this call (hash only)')).toHaveLength(2);
    expect(screen.getByText('b'.repeat(64))).toBeInTheDocument();
  });

  it('says when no transcript was recorded (404), without a retry', async () => {
    mockApi({ 'GET /monitoring/llm-calls/:id/transcript': () => apiError(404, 'NOT_FOUND', 'Transcript not found') });
    renderDialog();
    expect(await screen.findByText('No transcript was recorded for this call.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('closes', async () => {
    mockApi({ 'GET /monitoring/llm-calls/:id/transcript': () => transcript() });
    const onClose = vi.fn();
    renderDialog(onClose);
    await userEvent.setup().click(await screen.findByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
