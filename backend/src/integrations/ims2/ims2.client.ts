import type { LookupQuery } from '../../services/ims2.js';
import {
  type IntakePushV1,
  type IntakeStatus,
  type IntakeStatusName,
  queueAppUrl,
  queueConfigured,
  queueLookup,
  type QueueLookupResult,
  queueProbe,
  queuePush,
  type QueuePushResult,
  queueStatus,
  queueStatusPage,
} from '../../services/ims2IntakeQueue.js';

/** One page of intake statuses. */
export type IntakeStatusPage = Awaited<ReturnType<typeof queueStatusPage>>;

/**
 * IMS 2's Submission Intake queue (external-integrations skill). The real client is services/ims2IntakeQueue.ts:
 * bearer token, timeouts, Zod-checked answers, Ims2Error for refusals. Tests give a fake through
 * setIntegrations({ ims2 }) or createApp({ ims2 }) instead of mocking the module.
 */
export interface Ims2Client {
  /** Whether the queue's base URL and token are set. */
  configured(): boolean;
  /** Insureds and brokers IMS 2 already has that match the query. */
  lookup(q: LookupQuery): Promise<QueueLookupResult>;
  /** Sends (or re-sends) one intake. */
  push(body: IntakePushV1): Promise<QueuePushResult & { httpStatus: number }>;
  /** The current state of one intake. */
  status(intakeId: string): Promise<IntakeStatus>;
  /** A page of intake states, by change time or by id. */
  statusPage(p: {
    since?: string | null;
    ids?: string[];
    status?: IntakeStatusName[];
    limit?: number;
    cursor?: string | null;
  }): Promise<IntakeStatusPage>;
  /** Where a link IMS 2 returned leads: absolute as given, or a path on IMS 2's app address. */
  appUrl(url: string | null | undefined): string | null;
  /** A live check of the connection, for Settings → Connections. */
  probe(): Promise<string>;
}

export function createIms2Client(): Ims2Client {
  return {
    configured: () => queueConfigured(),
    lookup: (q) => queueLookup(q),
    push: (body) => queuePush(body),
    status: (intakeId) => queueStatus(intakeId),
    statusPage: (p) => queueStatusPage(p),
    appUrl: (url) => queueAppUrl(url),
    probe: () => queueProbe(),
  };
}
