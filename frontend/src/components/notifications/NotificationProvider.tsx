// Notification state for the signed-in user: list, read state, preferences, connection status, toasts, tab title.
// Persisted per user in localStorage and kept in sync across tabs through the `storage` event.
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { useAuth } from '../../auth/AuthContext';
import { TOAST_LIMIT } from '../../constants';
import { submissionKeys } from '../../features/submissions';
import { startEmailEvents } from '../../lib/eventStream';
import {
  addNotification,
  clearedKey,
  type ClearScope,
  type ConnectionStatus,
  DEFAULT_PREFS,
  type EmailNotification,
  idsToClear,
  markAllRead as markAllReadIn,
  markRead as markReadIn,
  type NewEmailEvent,
  type NotificationPrefs,
  notificationsKey,
  prefsKey,
  readJson,
  rememberCleared,
  titleWithCount,
  toNotification,
  unreadCount,
  writeJson,
} from '../../lib/notifications';
import { paths } from '../../paths';
import { ToastStack } from './ToastStack';

export type DesktopPermission = NotificationPermission | 'unsupported';

interface NotificationState {
  notifications: EmailNotification[];
  unread: number;
  status: ConnectionStatus;
  prefs: NotificationPrefs;
  setPrefs: (p: NotificationPrefs) => void;
  desktopPermission: DesktopPermission;
  requestDesktopPermission: () => Promise<void>;
  markRead: (id: string) => void;
  markAllRead: () => void;
  /** Remove one notification by id, or every notification in a scope. */
  clear: (target: { id: string } | ClearScope) => void;
  open: (id: string) => void;
}

const NotificationContext = createContext<NotificationState | null>(null);

const desktopSupported = () => typeof window !== 'undefined' && 'Notification' in window;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [notifications, setNotifications] = useState<EmailNotification[]>(() =>
    userId ? readJson(notificationsKey(userId), []) : [],
  );
  const [prefs, setPrefsState] = useState<NotificationPrefs>(() =>
    userId ? { ...DEFAULT_PREFS, ...readJson(prefsKey(userId), {}) } : DEFAULT_PREFS,
  );
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [toasts, setToasts] = useState<EmailNotification[]>([]);
  const [desktopPermission, setDesktopPermission] = useState<DesktopPermission>(() =>
    desktopSupported() ? Notification.permission : 'unsupported',
  );

  // Event handlers read the latest values without restarting the connection.
  const listRef = useRef(notifications);
  const prefsRef = useRef(prefs);
  listRef.current = notifications;
  prefsRef.current = prefs;

  const save = useCallback(
    (next: EmailNotification[]) => {
      listRef.current = next;
      setNotifications(next);
      if (userId) writeJson(notificationsKey(userId), next);
    },
    [userId],
  );

  // Another tab changed the list or preferences.
  useEffect(() => {
    if (!userId) return undefined;
    const onStorage = (e: StorageEvent) => {
      if (e.key === notificationsKey(userId)) setNotifications(readJson(notificationsKey(userId), []));
      if (e.key === prefsKey(userId)) setPrefsState({ ...DEFAULT_PREFS, ...readJson(prefsKey(userId), {}) });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId]);

  const open = useCallback(
    (id: string) => {
      save(markReadIn(listRef.current, id));
      setToasts((t) => t.filter((x) => x.id !== id));
      navigate(paths.submission(id));
    },
    [navigate, save],
  );
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!userId) return undefined;
    const onEvent = (event: NewEmailEvent, { leader }: { leader: boolean }) => {
      const { list, added } = addNotification(listRef.current, event, readJson<string[]>(clearedKey(userId), []));
      // Every tab refreshes its inbox and badge; only the leader writes storage (followers get it via `storage`).
      void qc.invalidateQueries({ queryKey: submissionKeys.unreadCount() });
      void qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      if (!added) return;
      if (leader) save(list);
      else {
        listRef.current = list;
        setNotifications(list);
      }
      const n = toNotification(event);
      if (prefsRef.current.toasts) setToasts((t) => [n, ...t.filter((x) => x.id !== n.id)].slice(0, TOAST_LIMIT));
      // One desktop notification per email: only the connected tab shows it, and only while it is in the background.
      if (
        leader &&
        prefsRef.current.desktop &&
        document.hidden &&
        desktopSupported() &&
        Notification.permission === 'granted'
      ) {
        const desktop = new Notification(n.subject, { body: `From ${n.senderName}`, tag: `email-${n.id}` });
        desktop.onclick = () => {
          window.focus();
          openRef.current(n.id);
          desktop.close();
        };
      }
    };
    return startEmailEvents({ userId, onEvent, onStatus: setStatus });
  }, [userId, qc, save]);

  const dismissToast = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const unread = unreadCount(notifications);

  // "(3) Title" while there is unread mail.
  useEffect(() => {
    document.title = titleWithCount(document.title, unread);
  }, [unread]);
  useEffect(
    () => () => {
      document.title = titleWithCount(document.title, 0);
    },
    [],
  );

  const setPrefs = useCallback(
    (p: NotificationPrefs) => {
      setPrefsState(p);
      if (userId) writeJson(prefsKey(userId), p);
    },
    [userId],
  );

  const requestDesktopPermission = useCallback(async () => {
    if (!desktopSupported()) return;
    const result = await Notification.requestPermission();
    setDesktopPermission(result);
    if (result === 'granted' && !prefsRef.current.desktop) setPrefs({ ...prefsRef.current, desktop: true });
  }, [setPrefs]);

  const value = useMemo<NotificationState>(
    () => ({
      notifications,
      unread,
      status,
      prefs,
      setPrefs,
      desktopPermission,
      requestDesktopPermission,
      markRead: (id) => save(markReadIn(listRef.current, id)),
      markAllRead: () => save(markAllReadIn(listRef.current)),
      clear: (target) => {
        const ids = typeof target === 'string' ? idsToClear(listRef.current, target) : [target.id];
        if (!ids.length) return;
        if (userId) writeJson(clearedKey(userId), rememberCleared(readJson<string[]>(clearedKey(userId), []), ids));
        save(listRef.current.filter((n) => !ids.includes(n.id)));
        setToasts((t) => t.filter((x) => !ids.includes(x.id)));
      },
      open,
    }),
    [notifications, unread, status, prefs, setPrefs, desktopPermission, requestDesktopPermission, save, open, userId],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onOpen={open} onDismiss={dismissToast} />
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationState {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used inside <NotificationProvider>');
  return ctx;
}
