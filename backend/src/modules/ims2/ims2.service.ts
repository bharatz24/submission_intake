import { IMS2_SENDING_STALE_MS } from '../../constants.js';
import { pool, type Queryable, withTransaction } from '../../db/pool.js';
import type { AppDeps } from '../../deps.js';
import { AppError, type AuthUser } from '../../http.js';
import type { Ims2Client } from '../../integrations/index.js';
import { logger } from '../../logger.js';
import { audit, recordSystemError } from '../../services/audit.js';
import { start, taskSnapshot } from '../../services/backgroundTasks.js';
import { Ims2Error, type LookupQuery } from '../../services/ims2.js';
import {
  INTAKE_ID_RE,
  type IntakePushV1,
  type IntakeStatus,
  MAX_STATUS_IDS,
  MAX_STATUS_LIMIT,
  type QueueBrokerHit,
} from '../../services/ims2IntakeQueue.js';
import {
  buildPush,
  intakeReview,
  payloadHash,
  queueDefaults,
  type queueFormSchema,
} from '../../services/intakeQueuePayload.js';
import { requireLiveSubmission } from '../shared/submissionGuards.js';
import type { QueueRow, QueueState } from './ims2.repository.js';
import * as repo from './ims2.repository.js';

type QueueForm = import('zod').infer<typeof queueFormSchema>;

const ACCEPT_DECISIONS = ['ACCEPT', 'ACCEPT_WITH_CONDITIONS'];
const LAST_SINCE_KEY = 'ims2_intake_queue.last_status_changed_at';
const LAST_SYNC_KEY = 'ims2_intake_queue.last_sync';
const STATE_OF: Record<IntakeStatus['status'], QueueState> = { new: 'QUEUED', linked: 'LINKED', rejected: 'REJECTED' };

/** The submission id is the intake id: a uuid always fits IMS 2's pattern. */
const intakeIdFor = (submissionId: string) => {
  if (!INTAKE_ID_RE.test(submissionId))
    throw new AppError('BAD_INTAKE_ID', 500, 'This submission id cannot be an IMS 2 intake id');
  return submissionId;
};

/** IMS 2's 400 names the payload path in `field`. */
const refusal = (err: Ims2Error) => ({
  message: err.message,
  field: typeof err.body.field === 'string' ? err.body.field : null,
});

const isStatus = (v: unknown): v is IntakeStatus =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as IntakeStatus).intakeId === 'string' &&
  typeof (v as IntakeStatus).version === 'number';

const mapRow = (r: QueueRow, ims2: Ims2Client) => ({
  intakeId: r.intake_id as string,
  version: r.version as number,
  state: r.state as QueueState,
  lastHttpStatus: r.last_http_status,
  lastError: r.last_error,
  lastErrorField: r.last_error_field,
  imsSubmissionId: r.ims_submission_id,
  imsSubmissionNumber: r.ims_submission_number,
  imsInsuredId: r.ims_insured_id,
  imsUrl: ims2.appUrl(r.ims_url),
  remoteStatus: r.remote_status,
  remoteStatusChangedAt: r.remote_status_changed_at,
  remoteCheckedAt: r.remote_checked_at,
  rejectedReason: r.rejected_reason,
  sent: r.payload,
  form: r.form,
  sentBy: { id: r.sent_by, name: r.sent_by_name },
  sentAt: r.sent_at,
});

/** Lookup hits merged across several broker names: no duplicate ids, active first, then the most identifiers matched. */
export function mergeBrokers(lists: QueueBrokerHit[][]): QueueBrokerHit[] {
  const byId = new Map<number, QueueBrokerHit>();
  for (const b of lists.flat()) {
    const seen = byId.get(b.id);
    if (!seen) byId.set(b.id, b);
    else if (b.matchedOn.length > seen.matchedOn.length)
      byId.set(b.id, { ...b, matchedOn: [...new Set([...seen.matchedOn, ...b.matchedOn])] });
  }
  return [...byId.values()].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.matchedOn.length - a.matchedOn.length,
  );
}

/**
 * Applies an IntakeStatus to the local row, idempotently (ims2.repository.ts applyStatusRow), and audits a move to
 * LINKED or REJECTED. Returns the old and new state when the row changed.
 */
export async function applyStatus(
  s: IntakeStatus,
  opts: { fromSend?: boolean; actorId?: string | null } = {},
  db: Queryable = pool,
) {
  const next = STATE_OF[s.status];
  if (!next || (next === 'LINKED' && s.submissionId == null)) return null;
  const r = await repo.applyStatusRow(db, s, next, opts.fromSend === true);
  if (!r) return null;
  if (r.old_state !== r.new_state && (r.new_state === 'LINKED' || r.new_state === 'REJECTED')) {
    await audit(
      {
        action: r.new_state === 'LINKED' ? 'IMS2_QUEUE_LINKED' : 'IMS2_QUEUE_REJECTED',
        entityType: 'submission',
        entityId: r.submission_id,
        submissionId: r.submission_id,
        actorId: opts.actorId ?? null,
        details: {
          intakeId: s.intakeId,
          version: s.version,
          imsSubmissionId: s.submissionId,
          imsSubmissionNumber: s.submissionNumber,
          rejectedReason: s.rejectedReason,
        },
      },
      db,
    );
  }
  return { submissionId: r.submission_id, oldState: r.old_state, newState: r.new_state };
}

export interface SyncResult {
  at: string;
  by: string | null;
  pages: number;
  seen: number;
  updated: number;
  linked: number;
  rejected: number;
  error?: string;
}

/** One sync at a time per process (backgroundTasks.ts single-flight key). */
const SYNC_TASK = 'ims2-intake-sync';

/**
 * Hand-off of an accepted submission to IMS 2's Submission Intake queue, through the injected IMS 2 client. The
 * reviewer sends the intake; an IMS 2 user later creates the submission and links it, or rejects it with a reason. The
 * outcome comes back by reading status, per submission or for every intake at once (Settings → IMS 2 intake → Sync). A
 * submission the removed direct hand-off already created in IMS 2 (ims2_handoffs) is not sent again.
 */
export function createIms2Service({ db, ims2 }: Pick<AppDeps, 'db' | 'ims2'>) {
  // 409, not 503: the server is working; this deployment has no IMS 2 queue set up, which retrying will not change.
  const requireConfigured = () => {
    if (!ims2.configured()) {
      throw new AppError(
        'IMS2_QUEUE_NOT_CONFIGURED',
        409,
        'The IMS 2 intake queue is not configured: set its URL and token in Settings → IMS 2 intake.',
      );
    }
  };
  const loadRow = async (id: string) => {
    const r = await repo.loadRow(db, id);
    return r ? mapRow(r, ims2) : null;
  };
  const legacyHandoff = async (id: string) => {
    const h = await repo.legacyHandoff(db, id);
    return h ? { state: h.state, imsUrl: ims2.appUrl(h.ims_url), imsSubmissionNumber: h.ims_submission_number } : null;
  };

  /** Every status change since the last sync (paged), then the live state of queued and linked intakes. */
  const runSync = async (actorId: string | null, by: string | null): Promise<SyncResult> => {
    const out: SyncResult = { at: '', by, pages: 0, seen: 0, updated: 0, linked: 0, rejected: 0 };
    const count = (r: Awaited<ReturnType<typeof applyStatus>>) => {
      if (!r) return;
      out.updated++;
      if (r.oldState !== r.newState && r.newState === 'LINKED') out.linked++;
      if (r.oldState !== r.newState && r.newState === 'REJECTED') out.rejected++;
    };
    try {
      const since = await repo.readSetting<string>(db, LAST_SINCE_KEY);
      let maxAt = since;
      let cursor: string | null = null;
      do {
        const page = await ims2.statusPage({ since, limit: MAX_STATUS_LIMIT, cursor });
        out.pages++;
        for (const s of page.items) {
          out.seen++;
          count(await applyStatus(s, { actorId }, db));
          if (!maxAt || s.statusChangedAt > maxAt) maxAt = s.statusChangedAt;
        }
        cursor = page.nextCursor;
      } while (cursor);
      if (maxAt && maxAt !== since) await repo.writeSetting(db, LAST_SINCE_KEY, maxAt, actorId);

      // Workflow status and policy number change without a status change. Intakes IMS 2 has that are not ours are ignored.
      const ids = await repo.openIntakeIds(db);
      for (let i = 0; i < ids.length; i += MAX_STATUS_IDS) {
        const chunk = ids.slice(i, i + MAX_STATUS_IDS);
        let c: string | null = null;
        do {
          const page = await ims2.statusPage({ ids: chunk, limit: MAX_STATUS_LIMIT, cursor: c });
          out.pages++;
          for (const s of page.items) count(await applyStatus(s, { actorId }, db));
          c = page.nextCursor;
        } while (c);
      }
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err);
      if (err instanceof Ims2Error && err.misconfigured) await recordSystemError('ims2', err).catch(() => undefined);
      logger.warn({ err }, 'IMS 2 intake sync failed');
    }
    // Stamped when it ends, so a client waiting since the start (startSync's `since`) sees this result.
    out.at = new Date().toISOString();
    await repo.writeSetting(db, LAST_SYNC_KEY, out, actorId);
    return out;
  };

  return {
    /** The submission's hand-off state, whether it can be sent, and the form's prefill. */
    async overview(id: string) {
      await requireLiveSubmission(db, id);
      const [row, decision, legacy] = await Promise.all([loadRow(id), repo.latestDecision(db, id), legacyHandoff(id)]);
      return {
        configured: ims2.configured(),
        latestDecision: decision,
        canSend: decision !== null && ACCEPT_DECISIONS.includes(decision),
        row,
        legacyHandoff: legacy,
        // Linked: the record lives in IMS 2 now, there is nothing left to prefill.
        defaults: row?.state === 'LINKED' ? null : (await queueDefaults(id)).queue,
      };
    },

    /** Insureds and brokers IMS 2 already has: for the given query, or (none given) for what triage knows. */
    async lookup(id: string, given: LookupQuery) {
      await requireLiveSubmission(db, id);
      requireConfigured();
      try {
        if (Object.keys(given).length) {
          const r = await ims2.lookup(given);
          return { query: given, insureds: r.insureds, brokers: mergeBrokers([r.brokers]) };
        }
        // Each broker name is tried (agency part, full name, email domain).
        const { queue } = await queueDefaults(id);
        const [main, ...more] = await Promise.all([
          ims2.lookup(queue.lookup),
          ...queue.brokerNames.slice(1).map((brokerName) => ims2.lookup({ brokerName })),
        ]);
        return {
          query: queue.lookup,
          insureds: main!.insureds,
          brokers: mergeBrokers([main!.brokers, ...more.map((m) => m.brokers)]),
        };
      } catch (err) {
        if (err instanceof Ims2Error)
          throw new AppError('IMS2_ERROR', 502, `IMS 2 lookup failed: ${err.message}`, { ims2Status: err.status });
        throw err;
      }
    },

    async send(id: string, form: QueueForm, user: AuthUser) {
      await requireLiveSubmission(db, id);
      requireConfigured();
      const decision = await repo.latestDecision(db, id);
      if (!decision || !ACCEPT_DECISIONS.includes(decision)) {
        throw new AppError('NOT_ACCEPTED', 409, 'Record an Accept assessment before sending the submission to IMS 2');
      }
      const legacy = await legacyHandoff(id);
      if (legacy?.state === 'ACCEPTED') {
        throw new AppError(
          'IMS2_ALREADY_HANDED_OFF',
          409,
          'IMS 2 already created this submission through the direct hand-off',
          { url: legacy.imsUrl },
        );
      }
      const intakeId = intakeIdFor(id);
      const [{ queue, draft }, review] = await Promise.all([queueDefaults(id), intakeReview(id)]);

      // Claim the send: version, payload and SENDING under the row lock, then the HTTP call outside any transaction.
      let body = await withTransaction(async (tx) => {
        const prev = await repo.lockRow(tx, id);
        if (prev?.state === 'LINKED') {
          throw new AppError(
            'IMS2_QUEUE_LINKED',
            409,
            'IMS 2 already linked this intake to a submission; edit the record in IMS 2',
            { url: ims2.appUrl(prev.ims_url) },
          );
        }
        if (prev?.state === 'SENDING' && Date.now() - new Date(prev.updated_at).getTime() < IMS2_SENDING_STALE_MS) {
          throw new AppError('IN_PROGRESS', 409, 'A send to IMS 2 is already in progress for this submission');
        }
        const b = buildPush({ form, draft, queue, review, intakeId, version: 1, sentBy: user.email, submissionId: id });
        const hash = payloadHash(b);
        // Unchanged: same version, so a resend after a lost answer replays. Changed, or after a rejection: the next
        // version (IMS 2 reopens a rejected intake only for a newer version).
        b.version = !prev
          ? 1
          : prev.state !== 'REJECTED' && prev.payload_hash === hash
            ? prev.version
            : prev.version + 1;
        await repo.claimSend(tx, {
          submissionId: id,
          intakeId,
          version: b.version,
          payload: b,
          payloadHash: hash,
          form,
          sentBy: user.id,
        });
        return b;
      });

      const markError = async (
        state: 'ERROR' | 'FAILED',
        httpStatus: number | null,
        message: string,
        field: string | null,
      ) => {
        await repo.markError(db, id, { state, httpStatus, message, field });
        await audit({
          action: 'IMS2_QUEUE_ERROR',
          entityType: 'submission',
          entityId: id,
          submissionId: id,
          actorId: user.id,
          details: { intakeId, version: body.version, ims2Status: httpStatus, error: message, field, state },
        });
      };

      // At most one automatic resend, when IMS 2 holds a newer version than ours (stale / version_reused).
      for (let attempt = 0; ; attempt++) {
        try {
          const ok = await ims2.push(body);
          if (ok.status === 'new') {
            await repo.markQueued(db, id, ok.httpStatus);
          } else {
            // A replay of an intake IMS 2 already decided on: read the decision and keep it.
            await applyStatus(await ims2.status(intakeId), { fromSend: true, actorId: user.id }, db);
            await repo.setHttpStatus(db, id, ok.httpStatus);
          }
          await audit({
            action: 'IMS2_QUEUE_SENT',
            entityType: 'submission',
            entityId: id,
            submissionId: id,
            actorId: user.id,
            details: {
              intakeId,
              version: body.version,
              status: ok.status,
              updated: !!ok.updated,
              reopened: !!ok.reopened,
              replayed: !!ok.replayed,
            },
          });
          break;
        } catch (err) {
          if (!(err instanceof Ims2Error)) {
            // The original error is what the caller needs; a failure to record it is logged, not swallowed.
            await markError('FAILED', null, (err as Error).message, null).catch((markErr: unknown) =>
              logger.warn({ err: markErr, submissionId: id }, 'recording the IMS 2 send failure failed'),
            );
            throw err;
          }
          const code = err.body.code;
          const status = err.body.status;
          if (err.status === 409 && isStatus(status) && (code === 'linked' || status.status === 'linked')) {
            await applyStatus(status, { fromSend: true, actorId: user.id }, db);
            await repo.setHttpStatus(db, id, 409);
            break;
          }
          if (
            err.status === 409 &&
            isStatus(status) &&
            (code === 'stale' || code === 'version_reused') &&
            attempt === 0
          ) {
            body = { ...body, version: Math.max(body.version, status.version) + 1 } satisfies IntakePushV1;
            await repo.bumpVersion(db, id, body.version, body);
            continue;
          }
          const { message, field } = refusal(err);
          await markError(
            err.retryable ? 'FAILED' : 'ERROR',
            err.status || null,
            message,
            err.retryable ? null : field,
          );
          if (err.misconfigured) await recordSystemError('ims2', err).catch(() => undefined);
          else
            logger.warn({ submissionId: id, ims2Status: err.status, error: message }, 'IMS 2 did not take the intake');
          break;
        }
      }
      return loadRow(id);
    },

    /**
     * The intake's last known state, read-only (SEC-07): no call to IMS 2 and no write, so any signed-in user may read
     * it. `refreshStatus` asks IMS 2.
     */
    async status(id: string) {
      await requireLiveSubmission(db, id);
      const row = await loadRow(id);
      if (!row)
        throw new AppError('IMS2_QUEUE_NOT_SENT', 409, 'This submission has not been sent to the IMS 2 intake queue');
      return row;
    },

    /** What became of the intake in IMS 2 (queued, linked with its submission, rejected with a reason): asks IMS 2. */
    async refreshStatus(id: string, actorId: string) {
      await requireLiveSubmission(db, id);
      requireConfigured();
      const row = await loadRow(id);
      if (!row)
        throw new AppError('IMS2_QUEUE_NOT_SENT', 409, 'This submission has not been sent to the IMS 2 intake queue');
      try {
        await applyStatus(await ims2.status(row.intakeId), { actorId }, db);
      } catch (err) {
        if (!(err instanceof Ims2Error)) throw err;
        if (err.status !== 404)
          throw new AppError('IMS2_ERROR', 502, `IMS 2 status failed: ${err.message}`, { ims2Status: err.status });
        // Never received (the send failed before IMS 2 stored it): keep the local state.
        await repo.noteNotFound(db, id, err.message);
      }
      return loadRow(id);
    },

    /** Counts by state, the last sync, and whether one is running (Settings → IMS 2 intake). */
    async syncOverview() {
      const [counts, lastSync, lastStatusChangedAt] = await Promise.all([
        repo.stateCounts(db),
        repo.readSetting<SyncResult>(db, LAST_SYNC_KEY),
        repo.readSetting<string>(db, LAST_SINCE_KEY),
      ]);
      return {
        configured: ims2.configured(),
        counts,
        lastSync,
        lastStatusChangedAt,
        running: taskSnapshot(SYNC_TASK).running,
      };
    },

    /**
     * Starts a sync in the background (PERF-01: it pages through every status change) and answers at once. `since` is
     * the server time it started: the sync is over once GET /ims2-queue/sync shows a `lastSync.at` at or after it
     * (lastSync is stored in the database, so any instance answers that).
     */
    async startSync(actor: AuthUser): Promise<{ started: true; since: string }> {
      requireConfigured();
      const since = new Date().toISOString();
      // Netlify: worker (it pages through every status change).
      const started = await start(SYNC_TASK, () => runSync(actor.id, actor.name), undefined, {
        worker: { task: 'ims2-sync', payload: { actor: { id: actor.id, name: actor.name } } },
      });
      if (!started) throw new AppError('SYNC_IN_PROGRESS', 409, 'An IMS 2 status sync is already running');
      return { started: true, since };
    },

    /** The sync itself, run by the Netlify worker's `ims2-sync` task. */
    runSync: (actor: { id: string; name: string }) => runSync(actor.id, actor.name),
  };
}
