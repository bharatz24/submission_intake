// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary, isChunkLoadError } from './ErrorBoundary';

let failWith: Error | null = null;
function Child() {
  if (failWith) throw failWith;
  return <div>content</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    failWith = null;
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('shows a recoverable error and retries', async () => {
    failWith = new Error('boom');
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    failWith = null;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('offers a reload for a failed lazy chunk (stale deploy)', async () => {
    failWith = new TypeError(
      'Failed to fetch dynamically imported module: https://app.test/assets/SkillEditorDialog-abc.js',
    );
    const onReload = vi.fn();
    render(
      <ErrorBoundary onReload={onReload}>
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('A new version is available');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('clears the error when the reset key changes (navigation)', () => {
    failWith = new Error('boom');
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    failWith = null;
    rerender(
      <ErrorBoundary resetKey="/b">
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('recognises chunk-load errors from the major browsers', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /x.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError('nope')).toBe(false);
  });
});
