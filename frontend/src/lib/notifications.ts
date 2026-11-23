// Notification bell state: pure helpers so NotificationProvider stays thin and testable.
import { BACKOFF_SECONDS, BACKOFF_SECONDS_MAX, CURSOR_MAX_AGE_MS, MAX_NOTIFICATIONS } from '../constants';
import { initials, parseAddress } from './email';

/** Payload of a `new-email` server event (backend services/notifications.ts). */
export interface NewEmailEvent {
  submissionId: string;
  subject: string;
  fromAddress: string;
  receivedAt: string;
  ingestedAt: string;
  status: string;
}

export interface EmailNotification {
  id: string; // submission id
  subject: string;
  senderName: string;
  senderInitials: string;
  receivedAt: string;
  ingestedAt: string;
  read: boolean;
}

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface NotificationPrefs {
  toasts: boolean;
  desktop: boolean;
}
export const DEFAULT_PREFS: NotificationPrefs = { toasts: true, desktop: true };

export { CURSOR_MAX_AGE_MS, MAX_NOTIFICATIONS };

export function toNotification(e: NewEmailEvent): EmailNotification {
  const from = parseAddress(e.fromAddress);
  const senderName = from.name ?? from.address ?? 'Unknown sender';
  return {
    id: e.submissionId,
    subject: e.subject || '(no subject)',
    senderName,
    senderInitials: initials(senderName),
    receivedAt: e.receivedAt,
    ingestedAt: e.ingestedAt,
    read: false,
  };
}

/**
 * Newest first, one entry per submission (a replayed event never duplicates), capped at MAX_NOTIFICATIONS.
 * Ids in `cleared` were removed by the user and stay out when the server replays them.
 */
export function addNotification(
  list: EmailNotification[],
  e: NewEmailEvent,
  cleared: readonly string[] = [],
): { list: EmailNotification[]; added: boolean } {
  if (cleared.includes(e.submissionId) || list.some((n) => n.id === e.submissionId)) return { list, added: false };
  const next = [toNotification(e), ...list]
    .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt))
    .slice(0, MAX_NOTIFICATIONS);
  return { list: next, added: true };
}

export const markRead = (list: EmailNotification[], id: string) =>
  list.map((n) => (n.id === id && !n.read ? { ...n, read: true } : n));
export const markAllRead = (list: EmailNotification[]) =>
  list.some((n) => !n.read) ? list.map((n) => ({ ...n, read: true })) : list;
export const unreadCount = (list: EmailNotification[]) => list.filter((n) => !n.read).length;

export type ClearScope = 'all' | 'read' | 'unread';
export const idsToClear = (list: EmailNotification[], scope: ClearScope) =>
  list.filter((n) => scope === 'all' || (scope === 'read') === n.read).map((n) => n.id);

/** Cleared ids to remember, newest first; twice the list cap covers anything a reconnect can replay. */
export const CLEARED_LIMIT = MAX_NOTIFICATIONS * 2;
export const rememberCleared = (cleared: readonly string[], ids: readonly string[]) =>
  [...ids, ...cleared.filter((id) => !ids.includes(id))].slice(0, CLEARED_LIMIT);

/** "(3) Title"; the count is dropped at zero and any earlier count is replaced. */
export function titleWithCount(title: string, count: number): string {
  const base = title.replace(/^\(\d+\+?\)\s*/, '');
  return count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
}

/** Badge text: at most "99+". */
export const badgeLabel = (count: number) => (count > 99 ? '99+' : String(count));

/** Delay before reconnect attempt `attempt` (0-based): 1, 2, 5, 10, then 30 seconds. */
export const reconnectDelay = (attempt: number) =>
  (BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] ?? BACKOFF_SECONDS_MAX) * 1000;
/** Spreads a delay over ±25% so tabs/browsers that lost the server together don't reconnect in lockstep. */
export const withJitter = (ms: number, random: () => number = Math.random) => Math.round(ms * (0.75 + random() * 0.5));

export interface StoredCursor {
  id: string;
  savedAt: number;
}

/** The stored cursor is resumed on page load only when recent; older mail is already in the Inbox. */
export function usableCursor(stored: StoredCursor | null, now = Date.now()): string | null {
  if (!stored?.id || now - stored.savedAt > CURSOR_MAX_AGE_MS) return null;
  return stored.id;
}

// localStorage keys, per user so a shared browser never mixes accounts.
export const notificationsKey = (userId: string) => `notifications:${userId}`;
export const prefsKey = (userId: string) => `notificationPrefs:${userId}`;
export const clearedKey = (userId: string) => `notificationsCleared:${userId}`;
export const cursorKey = (userId: string) => `emailEventsCursor:${userId}`;

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable */
  }
}

/** On sign-out: drop every account's notification list, cleared list and event cursor (preferences stay). */
export function clearNotificationStorage(): void {
  const prefixes = ['notifications:', 'notificationsCleared:', 'emailEventsCursor:'];
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && prefixes.some((p) => key.startsWith(p))) doomed.push(key);
    }
    doomed.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* storage unavailable */
  }
}
