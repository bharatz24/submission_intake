// Protects typed-in work: a long email, assessment notes, quote inputs or a skill edit. While a form is dirty the
// browser warns before the tab is closed or reloaded, in-app navigation (links, Back) asks first, and a dialog's
// Cancel/close asks before throwing the changes away.
import { useCallback, useContext, useEffect, useRef } from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router';

import { type ConfirmOptions, useConfirm } from '../components/feedback/FeedbackProvider';

const DISCARD: ConfirmOptions = {
  title: 'Discard unsaved changes?',
  message: 'What you entered here has not been saved and will be lost.',
  confirmLabel: 'Discard',
  tone: 'error',
};

/** The browser's own "Leave site?" prompt on tab close or reload while `dirty`. */
export function useBeforeUnloadWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older browsers need it set
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

/** `discard(action)` runs `action` (close, cancel) at once when clean, and after a "Discard?" confirmation when dirty. */
export function useDiscardGuard(dirty: boolean): (action: () => void) => Promise<void> {
  const confirm = useConfirm();
  return useCallback(
    async (action: () => void) => {
      if (!dirty || (await confirm(DISCARD))) action();
    },
    [dirty, confirm],
  );
}

/**
 * Render inside a form while it is open. Warns on tab close, and blocks in-app navigation that would unmount the form
 * (another page, or the same page with other query parameters such as a different tab) until the user confirms.
 */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
  useBeforeUnloadWarning(when);
  // Navigation can only be blocked under a data router (main.tsx); component tests render without one.
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  return dataRouter ? <NavigationBlocker when={when} /> : null;
}

function NavigationBlocker({ when }: { when: boolean }) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      when && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );
  const confirm = useConfirm();
  const latest = useRef(blocker);
  latest.current = blocker;

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let live = true;
    void confirm(DISCARD).then((ok) => {
      if (!live) return;
      if (ok) latest.current.proceed?.();
      else latest.current.reset?.();
    });
    return () => {
      live = false;
    };
  }, [blocker.state, confirm]);
  return null;
}
