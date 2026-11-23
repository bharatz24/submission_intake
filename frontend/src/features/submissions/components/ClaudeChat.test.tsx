// @vitest-environment jsdom
// Claude chat: answers are written by a background job. The panel polls while an answer is PENDING, allows one
// question at a time, and shows why an answer failed.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { bodyOf, mockApi } from '../../../test/msw/api';
import type { ChatMessage } from '../../../types';
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Uma Writer' } }) }));

const { ClaudeChat } = await import('./ClaudeChat');
// The markdown renderer is lazy (FE-05): load it once up front so no test waits on its first import.
await (await import('../../../components/common')).preloadMarkdown();
// jsdom does not lay out, so elements have no scrollTo (the panel scrolls to the newest message).
Element.prototype.scrollTo = () => {};

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm-1',
  role: 'user',
  content: 'Who is the applicant?',
  createdAt: '2026-11-04T10:00:00Z',
  userName: 'Uma Writer',
  status: 'COMPLETED',
  error: null,
  ...over,
});
const question = msg({});
const pending = msg({ id: 'm-2', role: 'assistant', content: '', userName: null, status: 'PENDING' });
const answered = msg({ id: 'm-2', role: 'assistant', content: 'Dr. Jane Smith, cardiology.', userName: null });

const renderChat = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <ClaudeChat submissionId="s-1" />
    </QueryClientProvider>,
  );

/** GET /chat answers each poll with the next thread in `threads` (the last one repeats). */
const chatServer = (threads: ChatMessage[][]) => {
  let n = 0;
  return mockApi({
    'GET /submissions/:id/chat': () => ({ items: threads[Math.min(n++, threads.length - 1)] }),
    'POST /submissions/:id/chat': () => [question, pending],
  });
};

describe('ClaudeChat', () => {
  it('sends a question and polls until the job has answered it', async () => {
    const api = chatServer([[], [question, pending], [question, answered]]);
    renderChat();
    await userEvent.type(await screen.findByPlaceholderText(/Ask a question/), 'Who is the applicant?{Enter}');
    expect(await screen.findByText('Claude is thinking…')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(await screen.findByText('Dr. Jane Smith, cardiology.', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText('Claude is thinking…')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(api['POST /submissions/:id/chat']).toHaveBeenCalledWith(expect.objectContaining({ params: { id: 's-1' } }));
    expect(bodyOf(api['POST /submissions/:id/chat'])).toEqual({ message: 'Who is the applicant?' });
  });

  it('shows why an answer failed and lets the next question be asked', async () => {
    chatServer([
      [
        question,
        msg({
          id: 'm-2',
          role: 'assistant',
          content: '',
          userName: null,
          status: 'FAILED',
          error: 'Claude is overloaded',
        }),
      ],
    ]);
    renderChat();
    expect(await screen.findByText(/Claude could not answer: Claude is overloaded/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('footnotes the values of an answer that were not found in the submission', async () => {
    const graded = msg({
      id: 'm-2',
      role: 'assistant',
      content: 'The policy paid $888,777 in 2020.',
      userName: null,
      grounding: {
        checked: 1,
        verified: 0,
        unverified: 1,
        items: [
          { path: 'answer[0]', text: 'The policy paid $888,777 in 2020.', verdict: 'unverified', missing: ['888777'] },
        ],
      },
    });
    chatServer([[question, graded]]);
    renderChat();
    expect(await screen.findByRole('note')).toHaveTextContent('Not found in source — not in the submission: 888,777');
  });

  it('adds no footnote to an answer with no concrete values', async () => {
    chatServer([[question, msg({ ...answered, grounding: { checked: 0, verified: 0, unverified: 0, items: [] } })]]);
    renderChat();
    expect(await screen.findByText('Dr. Jane Smith, cardiology.')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
