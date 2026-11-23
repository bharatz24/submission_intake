import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useToast } from '../../../components/feedback/FeedbackProvider';
import { POLL_MS, TOAST_MESSAGES } from '../../../constants';
import { api, apiWith } from '../../../services/api';
import type { SubmissionPage, SubmissionSummary } from '../../../types';
import { ims2Keys, submissionKeys } from '../queryKeys';
import { isBusy } from './InboxCells';
import type { InboxParams } from './useInboxParams';

export type DeleteTarget = SubmissionSummary | 'selected' | 'all';

/**
 * Everything a person can do from the inbox: release or retry a row, flip read state, mark all read, retry all errors,
 * select and delete rows, and sync IMS 2 status. Each refreshes the lists and unread count it changes.
 */
export function useInboxActions(
  p: InboxParams,
  list: SubmissionPage | undefined,
  opts: { writable: boolean; canDelete: boolean },
) {
  const qc = useQueryClient();
  const toast = useToast();
  const refreshLists = () => {
    qc.invalidateQueries({ queryKey: submissionKeys.lists() });
    qc.invalidateQueries({ queryKey: submissionKeys.unreadCount() });
  };

  // One-click release from the Ignored and Duplicates tabs, or retry from the Errors tab; the reason is recorded in the audit trail.
  const release = useMutation({
    mutationFn: (s: SubmissionSummary): Promise<unknown> =>
      s.status === 'ERROR'
        ? api.retrySubmission(s.id)
        : s.status === 'DUPLICATE'
          ? api.setDuplicate(s.id, null, 'Processed anyway from the Duplicates tab')
          : api.overrideClassification(s.id, 'SUBMISSION', 'Processed as a submission from the Ignored tab'),
    onSuccess: (_r, s) => {
      refreshLists();
      toast.success(
        s.status === 'ERROR'
          ? TOAST_MESSAGES.retryQueued
          : s.status === 'DUPLICATE'
            ? TOAST_MESSAGES.duplicateReleased
            : TOAST_MESSAGES.ignoredReleased,
      );
    },
    onError: (err, s) =>
      toast.error(err, { action: { label: TOAST_MESSAGES.retry, onClick: () => release.mutate(s) } }),
  });

  // Process an imported email (only classified on arrival) from its row: the same call as the workspace's import banner.
  const processImported = useMutation({
    mutationFn: (s: SubmissionSummary) => api.processImported(s.id),
    onSuccess: (_r, s) => {
      refreshLists();
      qc.invalidateQueries({ queryKey: submissionKeys.detail(s.id) });
      toast.success(TOAST_MESSAGES.importProcessQueued);
    },
    onError: (err, s) =>
      toast.error(err, { action: { label: TOAST_MESSAGES.retry, onClick: () => processImported.mutate(s) } }),
  });

  // Read state is per user, so anyone can flip it. Mark-all-read follows the tab's search and filters, like delete-all.
  const refreshUnread = (r: { unread: number }) => {
    qc.setQueryData(submissionKeys.unreadCount(), { unread: r.unread });
    qc.invalidateQueries({ queryKey: submissionKeys.lists() });
  };
  const toggleRead = useMutation({
    mutationFn: (s: SubmissionSummary) => (s.isRead ? api.markUnread(s.id) : api.markRead(s.id)),
    onSuccess: (r, s) => {
      refreshUnread(r);
      toast.success(s.isRead ? TOAST_MESSAGES.markedUnread : TOAST_MESSAGES.markedRead, {
        action: { label: TOAST_MESSAGES.undo, onClick: () => toggleRead.mutate({ ...s, isRead: !s.isRead }) },
      });
    },
    onError: (err) => toast.error(err),
  });
  const retryAll = useMutation({
    mutationFn: api.retryAllErrors,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      toast.success(TOAST_MESSAGES.retryAllQueued(r.queued));
    },
    onError: (err) => toast.error(err, { action: { label: TOAST_MESSAGES.retry, onClick: () => retryAll.mutate() } }),
  });
  const readAll = useMutation({
    mutationFn: () => api.markAllRead(p.view, p.filters),
    onSuccess: (r) => {
      refreshUnread(r);
      toast.success(TOAST_MESSAGES.allMarkedRead);
    },
    onError: (err) => toast.error(err),
  });

  // Delete (by permission): one row, the ticked ones ('selected'), or every row of the tab matching its search and
  // filters ('all'). Rows still being processed can't be deleted.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set());
  }, [p.view, p.q, p.status, p.classification, p.strength, p.page, p.pageSize]);
  const pageIds = opts.canDelete ? (list?.items ?? []).filter((s) => !isBusy(s)).map((s) => s.id) : [];
  const pageSelected = pageIds.filter((id) => selected.has(id)).length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePage = () => setSelected(pageSelected === pageIds.length ? new Set() : new Set(pageIds));
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const deleteCount = deleteTarget === 'all' ? (list?.total ?? 0) : deleteTarget === 'selected' ? selected.size : 1;
  const remove = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (target: DeleteTarget) =>
      target === 'all'
        ? api.deleteMatching(p.view, p.filters)
        : target === 'selected'
          ? api.deleteSelected(p.view, [...selected])
          : api.deleteSubmission(target.id),
    onSuccess: (r) => {
      toast.success(TOAST_MESSAGES.deleted(r.deleted));
      setDeleteTarget(null);
      setSelected(new Set());
      refreshLists();
    },
  });

  // IMS 2 sends no notifications: this sync reads what IMS 2 users did with the intakes sent there.
  const ims2 = useQuery({
    queryKey: ims2Keys.sync(),
    queryFn: ({ signal }) => apiWith(signal).ims2QueueSyncInfo(),
    enabled: opts.writable,
    refetchInterval: (query) => (query.state.data?.running ? POLL_MS.inboxSyncRunning : false),
  });
  const ims2Sync = useMutation({
    mutationFn: api.ims2QueueSync,
    onSuccess: (r) => (r.error ? toast.error(r.error) : toast.success(TOAST_MESSAGES.ims2Synced(r))),
    onError: (err) => toast.error(err),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ims2Keys.all() });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
    },
  });

  return {
    release,
    processImported,
    toggleRead,
    retryAll,
    readAll,
    selection: { selected, pageIds, pageSelected, toggle, togglePage },
    deletion: { target: deleteTarget, setTarget: setDeleteTarget, count: deleteCount, remove },
    ims2: { configured: !!ims2.data?.configured, syncing: ims2Sync.isPending || !!ims2.data?.running, sync: ims2Sync },
  };
}

export type InboxActions = ReturnType<typeof useInboxActions>;
