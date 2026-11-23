// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTO_HIDE_MS, TOAST_LIMIT } from '../../constants';
import { ApiError } from '../../services/api';
import { FeedbackProvider, type Toaster, useConfirm, useToast } from './FeedbackProvider';

let toaster: Toaster;
let confirm: ReturnType<typeof useConfirm>;
function Grab() {
  toaster = useToast();
  confirm = useConfirm();
  return null;
}
const mount = () =>
  render(
    <FeedbackProvider>
      <Grab />
    </FeedbackProvider>,
  );

afterEach(() => vi.useRealTimers());

describe('toasts', () => {
  it('closes success toasts by themselves but keeps errors until dismissed', async () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      toaster.success('Quote v2 saved.');
      toaster.error('Something broke.');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Quote v2 saved.');
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke.');
    act(() => {
      vi.advanceTimersByTime(AUTO_HIDE_MS + 10);
    });
    expect(screen.queryByText('Quote v2 saved.')).toBeNull();
    expect(screen.getByText('Something broke.')).toBeInTheDocument();
    vi.useRealTimers();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Something broke.')).toBeNull();
  });

  it('words an error object in plain words', () => {
    mount();
    act(() => toaster.error(new ApiError(502, 'X', '529 {"type":"error","error":{"type":"overloaded_error"}}')));
    expect(screen.getByRole('alert')).toHaveTextContent(/^Claude is overloaded right now/);
  });

  it('runs the action and closes the toast', async () => {
    mount();
    const undo = vi.fn();
    act(() => toaster.success('Marked as read.', { action: { label: 'Undo', onClick: undo } }));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Marked as read.')).toBeNull();
  });

  it('shows at most TOAST_LIMIT, newest first, and does not stack a repeated message', () => {
    mount();
    act(() => {
      for (let i = 1; i <= TOAST_LIMIT + 2; i++) toaster.info(`Message ${i}`);
      toaster.info(`Message ${TOAST_LIMIT + 2}`);
    });
    const shown = screen.getAllByRole('status').map((el) => el.textContent);
    expect(shown).toHaveLength(TOAST_LIMIT);
    expect(shown[0]).toContain(`Message ${TOAST_LIMIT + 2}`);
  });
});

describe('confirm', () => {
  it('resolves true on confirm and false on cancel', async () => {
    mount();
    let answer: Promise<boolean>;
    act(() => {
      answer = confirm({
        title: 'Use a weak match?',
        message: 'Check it first.',
        confirmLabel: 'Use it anyway',
        tone: 'primary',
      });
    });
    expect(screen.getByRole('dialog')).toHaveTextContent('Check it first.');
    await userEvent.click(screen.getByRole('button', { name: 'Use it anyway' }));
    await expect(answer!).resolves.toBe(true);

    act(() => {
      answer = confirm({ title: 'Sure?', message: 'Really?', confirmLabel: 'Yes' });
    });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(answer!).resolves.toBe(false);
  });
});

describe('no browser dialogs', () => {
  it('uses useConfirm / useToast instead of window.alert, confirm or prompt anywhere in the app', () => {
    const sources = import.meta.glob<string>('../../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });
    const files = Object.entries(sources).filter(([f]) => !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter(([, code]) => {
        if (/\bwindow\.(?:alert|confirm|prompt)\(|(?<![\w.])(?:alert|prompt)\(/.test(code)) return true;
        // A bare confirm( is the browser's unless the file took `confirm` from useConfirm().
        return /(?<![\w.])confirm\(/.test(code) && !/\bconst confirm = useConfirm\(\)/.test(code);
      })
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});
