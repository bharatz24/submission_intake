// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LOADING_MESSAGES } from '../constants';

const { Loading } = await import('./common');

describe('Loading', () => {
  it('draws placeholder shapes with no visible text, and names itself for screen readers', () => {
    render(<Loading label="Loading submission…" shape="table" />);
    const status = screen.getByRole('status', { name: 'Loading submission' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('');
    expect(status.querySelectorAll('.MuiSkeleton-root').length).toBeGreaterThan(4);
  });

  it.each(['text', 'table', 'list', 'form', 'chat', 'cards', 'document', 'page'] as const)(
    'renders the %s shape',
    (shape) => {
      render(<Loading shape={shape} />);
      expect(screen.getByRole('status').querySelector('.MuiSkeleton-root')).not.toBeNull();
    },
  );

  it('says so when a load runs long', () => {
    vi.useFakeTimers();
    try {
      render(<Loading />);
      expect(screen.queryByText(LOADING_MESSAGES.slow)).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText(LOADING_MESSAGES.slow)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
