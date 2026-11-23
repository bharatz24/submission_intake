import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { clearNotificationStorage } from '../lib/notifications';
import { api, ApiError, setUnauthorizedHandler } from '../services/api';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  /** True while restoring the session from the cookie. */
  initializing: boolean;
  /** Set when the session could not be checked (server unreachable or failing); not a sign-out. */
  restoreError: unknown;
  retryRestore: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (body: { email: string; password: string; name: string; setupToken?: string }) => Promise<void>;
  logout: () => Promise<void>;
  /** Replace the signed-in user after a profile change (e.g. a password change re-issues the session). */
  setCurrentUser: (user: User) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** Tabs of this app tell each other about a sign-out here, so none keeps showing cached submission data. */
const AUTH_CHANNEL = 'auth';
type AuthMessage = { type: 'logout' };

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [restoreError, setRestoreError] = useState<unknown>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);

  const channel = useRef<BroadcastChannel | null>(null);

  /** Drop everything this tab holds for the signed-in user, so the next user can't see it. */
  const clearSession = useCallback(() => {
    clearNotificationStorage();
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  const logout = useCallback(async () => {
    // The server clears the httpOnly cookie and revokes the session; sign out locally even if it is unreachable.
    await api.logout().catch(() => undefined);
    clearSession();
    channel.current?.postMessage({ type: 'logout' } satisfies AuthMessage);
  }, [clearSession]);

  // Session expired: drop the same local state a sign-out does.
  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  // A sign-out in another tab signs this one out too (the cookie is already gone; only local state is left).
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return; // other tabs then sign out on their next 401
    const ch = new BroadcastChannel(AUTH_CHANNEL);
    ch.onmessage = (e: MessageEvent<AuthMessage>) => {
      if (e.data?.type === 'logout') clearSession();
    };
    channel.current = ch;
    return () => {
      ch.close();
      channel.current = null;
    };
  }, [clearSession]);

  // Restore the session: only a 401 means signed out; a network error or 5xx keeps the user on a retry screen.
  useEffect(() => {
    let cancelled = false;
    setInitializing(true);
    setRestoreError(null);
    api
      .me()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) setUser(null);
        else setRestoreError(e);
      })
      .finally(() => {
        if (!cancelled) setInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [restoreAttempt]);

  const retryRestore = useCallback(() => setRestoreAttempt((n) => n + 1), []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setRestoreError(null);
    setUser(res.user);
  }, []);

  const register = useCallback(async (body: { email: string; password: string; name: string; setupToken?: string }) => {
    const res = await api.register(body);
    setRestoreError(null);
    setUser(res.user);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, initializing, restoreError, retryRestore, login, register, logout, setCurrentUser: setUser }),
    [user, initializing, restoreError, retryRestore, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
