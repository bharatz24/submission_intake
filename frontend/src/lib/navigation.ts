// Top-bar back arrow. Back never leaves the app or returns to the login page.
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';

/** Where Back goes when there is no earlier page in the app. Every page is one level under the Inbox today. */
export function parentPath(pathname: string): string {
  void pathname; // add nested routes here (and to navigation.test.ts) when pages get deeper
  return '/';
}

export type BackTarget = { kind: 'history' } | { kind: 'replace'; to: string };

/**
 * React Router stores the index of the current entry in history.state.idx: above 0 means an earlier page of this
 * app is in history. At 0 (opened directly, in a new tab, or right after sign-in) the page is replaced by its parent.
 */
export function backTarget(historyState: unknown, pathname: string): BackTarget {
  const idx = (historyState as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && idx > 0 ? { kind: 'history' } : { kind: 'replace', to: parentPath(pathname) };
}

export function useBackNavigation(): () => void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return useCallback(() => {
    const t = backTarget(window.history.state, pathname);
    if (t.kind === 'history') navigate(-1);
    else navigate(t.to, { replace: true });
  }, [navigate, pathname]);
}
