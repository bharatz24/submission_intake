import { useEffect } from 'react';

/** The app's name, after the page name in the browser tab: "Inbox · Submission Intake Workbench". */
export const APP_TITLE = 'Submission Intake Workbench';

/** The unread count the notification provider puts in front of the title ("(3) "), kept when the page changes. */
const COUNT_PREFIX = /^\(\d+\+?\)\s*/;

/**
 * Names the browser tab (and the page, for screen readers announcing a navigation) after the current screen.
 * PageHeader calls it with its title, so every page with a header is named without extra code.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const prefix = COUNT_PREFIX.exec(document.title)?.[0] ?? '';
    document.title = `${prefix}${title} · ${APP_TITLE}`;
  }, [title]);
}
