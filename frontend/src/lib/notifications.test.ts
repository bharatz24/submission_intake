import { describe, expect, it } from 'vitest';

import {
  addNotification,
  badgeLabel,
  CLEARED_LIMIT,
  CURSOR_MAX_AGE_MS,
  idsToClear,
  markAllRead,
  markRead,
  MAX_NOTIFICATIONS,
  type NewEmailEvent,
  reconnectDelay,
  rememberCleared,
  titleWithCount,
  toNotification,
  unreadCount,
  usableCursor,
  withJitter,
} from './notifications';

const event = (n: number, at = `2026-10-30T10:00:${String(n).padStart(2, '0')}.000Z`): NewEmailEvent => ({
  submissionId: `s${n}`,
  subject: `Quote ${n}`,
  fromAddress: 'Pat Broker <pat@brokerage.test>',
  receivedAt: at,
  ingestedAt: at,
  status: 'NEW',
});

describe('notification helpers', () => {
  it('builds a notification with the sender name and initials', () => {
    expect(toNotification(event(1))).toMatchObject({
      id: 's1',
      subject: 'Quote 1',
      senderName: 'Pat Broker',
      senderInitials: 'PB',
      read: false,
    });
    expect(toNotification({ ...event(2), fromAddress: 'ops@agency.com', subject: '' })).toMatchObject({
      senderName: 'ops@agency.com',
      subject: '(no subject)',
    });
  });

  it('adds newest first, never duplicates a replayed event, and caps the list', () => {
    let list = addNotification([], event(1)).list;
    list = addNotification(list, event(3)).list;
    list = addNotification(list, event(2)).list;
    expect(list.map((n) => n.id)).toEqual(['s3', 's2', 's1']);
    const again = addNotification(list, event(2));
    expect(again).toEqual({ list, added: false });

    let many = list;
    for (let i = 10; i < 10 + MAX_NOTIFICATIONS; i++)
      many = addNotification(many, event(i, `2026-10-31T00:00:${String(i % 60).padStart(2, '0')}.${i}Z`)).list;
    expect(many).toHaveLength(MAX_NOTIFICATIONS);
  });

  it('marks one or all as read and counts unread', () => {
    const list = [event(1), event(2), event(3)].reduce(
      (l, e) => addNotification(l, e).list,
      [] as ReturnType<typeof toNotification>[],
    );
    expect(unreadCount(list)).toBe(3);
    const one = markRead(list, 's2');
    expect(unreadCount(one)).toBe(2);
    expect(one.find((n) => n.id === 's2')!.read).toBe(true);
    const all = markAllRead(one);
    expect(unreadCount(all)).toBe(0);
    expect(markAllRead(all)).toBe(all); // unchanged list keeps its identity (no needless re-render)
  });

  it('keeps cleared notifications out when the server replays them', () => {
    const list = addNotification([], event(1)).list;
    const cleared = rememberCleared(
      [],
      list.map((n) => n.id),
    );
    expect(addNotification([], event(1), cleared)).toEqual({ list: [], added: false });
    expect(addNotification([], event(2), cleared).added).toBe(true);
  });

  it('picks all, read or unread notifications to clear', () => {
    const list = markRead(
      [event(1), event(2), event(3)].reduce(
        (l, e) => addNotification(l, e).list,
        [] as ReturnType<typeof toNotification>[],
      ),
      's2',
    );
    expect(idsToClear(list, 'all')).toEqual(['s3', 's2', 's1']);
    expect(idsToClear(list, 'read')).toEqual(['s2']);
    expect(idsToClear(list, 'unread')).toEqual(['s3', 's1']);
  });

  it('remembers the newest cleared ids only, without duplicates', () => {
    const many = Array.from({ length: CLEARED_LIMIT + 5 }, (_, i) => `s${i}`);
    expect(rememberCleared([], many)).toHaveLength(CLEARED_LIMIT);
    expect(rememberCleared(['a', 'b'], ['b', 'c'])).toEqual(['b', 'c', 'a']);
  });

  it('formats the tab title and badge', () => {
    expect(titleWithCount('Submission Intake', 3)).toBe('(3) Submission Intake');
    expect(titleWithCount('(3) Submission Intake', 5)).toBe('(5) Submission Intake');
    expect(titleWithCount('(99+) Submission Intake', 0)).toBe('Submission Intake');
    expect(titleWithCount('Submission Intake', 120)).toBe('(99+) Submission Intake');
    expect(badgeLabel(7)).toBe('7');
    expect(badgeLabel(100)).toBe('99+');
  });

  it('jitters a delay within ±25%', () => {
    expect(withJitter(1000, () => 0)).toBe(750);
    expect(withJitter(1000, () => 0.5)).toBe(1000);
    expect(withJitter(1000, () => 0.999999)).toBe(1250);
  });

  it('backs off 1, 2, 5, 10 then 30 seconds and resumes only a recent cursor', () => {
    expect([0, 1, 2, 3, 4, 9].map(reconnectDelay)).toEqual([1000, 2000, 5000, 10000, 30000, 30000]);
    const now = 1_000_000_000;
    expect(usableCursor({ id: 'c', savedAt: now - 1000 }, now)).toBe('c');
    expect(usableCursor({ id: 'c', savedAt: now - CURSOR_MAX_AGE_MS - 1 }, now)).toBeNull();
    expect(usableCursor(null, now)).toBeNull();
  });
});
