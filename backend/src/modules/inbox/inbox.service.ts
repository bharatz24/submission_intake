import type { AppDeps } from '../../deps.js';
import {
  getSubmissionDetail,
  inboxWhere,
  listSubmissions,
  markAllRead,
  markRead,
  markUnread,
  searchWhere,
  unreadCount,
  type View,
} from '../../services/queries.js';
import { assertNotProcessing, requireLiveSubmission } from '../shared/submissionGuards.js';
import * as repo from './inbox.repository.js';
import type { BulkDeleteBody, ListQuery, ReadAllBody } from './inbox.schemas.js';

/** The inbox tabs: listing, read state per user, and deleting (hiding) rows. */
export function createInboxService({ db }: Pick<AppDeps, 'db'>) {
  return {
    list: (userId: string, q: ListQuery) => listSubmissions(userId, q),

    unread: (userId: string) => unreadCount(userId),

    /** Opening a submission marks it read; the new unread count is for the inbox badge. */
    async setRead(userId: string, submissionId: string, read: boolean) {
      await requireLiveSubmission(db, submissionId);
      await (read ? markRead : markUnread)(userId, submissionId);
      return unreadCount(userId);
    },

    /** Every row of one tab, narrowed by the tab's search and filters. */
    async readAll(userId: string, view: View, filters: ReadAllBody) {
      const params: unknown[] = [];
      const where = inboxWhere({ view, ...filters }, params);
      const search = searchWhere(filters.q, params);
      if (search) where.push(search);
      const marked = await markAllRead(userId, where, params);
      return { marked, unread: await unreadCount(userId) };
    },

    /** The selected ids (skipping those outside the tab or still processing), otherwise every row matching the filters. */
    bulkDelete(actorId: string, view: View, body: BulkDeleteBody) {
      const params: unknown[] = [];
      const where = inboxWhere(
        body.ids
          ? { view }
          : { view, status: body.status, classification: body.classification, strength: body.strength },
        params,
      );
      if (body.ids) {
        params.push(body.ids);
        where.push(`s.id = ANY($${params.length}::uuid[])`);
      } else {
        const search = searchWhere(body.q, params);
        if (search) where.push(search);
      }
      const { ids, ...filters } = body;
      return repo.deleteSubmissions(actorId, where, params, {
        bulk: true,
        view,
        ...(ids ? { selected: ids.length } : filters),
      });
    },

    /** One row and the copies held as duplicates of it. Not while it is still being processed. */
    async deleteOne(actorId: string, id: string) {
      const { status } = await getSubmissionDetail(id);
      assertNotProcessing(status, 'This email is still being processed; delete it once processing finishes');
      return repo.deleteSubmissions(actorId, ['s.id = $1'], [id], { bulk: false });
    },
  };
}
