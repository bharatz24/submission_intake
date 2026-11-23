// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { APP_TITLE, useDocumentTitle } from './useDocumentTitle';

describe('useDocumentTitle', () => {
  it('names the tab after the page, keeping the unread count in front', () => {
    document.title = '(3) Old page';
    const { rerender } = renderHook(({ t }) => useDocumentTitle(t), { initialProps: { t: 'Inbox' } });
    expect(document.title).toBe(`(3) Inbox · ${APP_TITLE}`);
    rerender({ t: 'Settings' });
    expect(document.title).toBe(`(3) Settings · ${APP_TITLE}`);
  });

  it('leaves the title alone without a page name', () => {
    document.title = 'Unchanged';
    renderHook(() => useDocumentTitle(null));
    expect(document.title).toBe('Unchanged');
  });
});
