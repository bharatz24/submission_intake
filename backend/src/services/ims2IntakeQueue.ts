import { config } from '../config.js';
import { fetchWithRetry } from './httpRetry.js';
import { explainNotConfigured, Ims2Error, type LookupQuery, unreachable } from './ims2.js';
import { ims2QueueBase, ims2QueueToken } from './ims2QueueSettings.js';
import { observeOutbound } from './metrics.js';

/**
 * Client for IMS 2's Submission Intake queue (ims2finance lib/modules/submission-intake, docs/submission-intake/
 * INTEGRATION_PLAN.md). The URL and token come from Settings → IMS 2 intake (ims2QueueSettings.ts); every call
 * carries `Authorization: Bearer <token>`. IMS 2 only stores the
 * intake: one of its users creates the submission and links it, and we learn the outcome by reading status. Errors are
 * Ims2Error (services/ims2.ts), with its retryable / misconfigured rules.
 */

export const QUEUE_CONTRACT_VERSION = 1;
/** IMS 2's si_intakes CHECK; a submission uuid fits. */
export const INTAKE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** NUMERIC(14,2) in IMS 2. */
export const MAX_PREMIUM = 999_999_999_999.99;
/** Bulk status: ids per call and items per page. */
export const MAX_STATUS_IDS = 200;
export const MAX_STATUS_LIMIT = 500;

/**
 * Reads (lookup, status) are idempotent GETs: retried on network errors, timeouts and 408/425/429/5xx with backoff
 * and Retry-After (httpRetry.ts, PERF-06). A push (POST) is never retried here: the reviewer resends, and IMS 2
 * replays an identical version.
 */
const GET_RETRY = { attempts: 3, baseDelayMs: 500, maxDelayMs: 4000 } as const;

export const queueConfigured = () => Boolean(ims2QueueBase() && ims2QueueToken());

/** A queue URL and token: the saved ones, or values from the Settings form being tested before they are saved. */
export interface QueueConnection {
  baseUrl: string | null;
  token: string | null;
}
const savedConnection = (): QueueConnection => ({ baseUrl: ims2QueueBase(), token: ims2QueueToken() });

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  conn: QueueConnection = savedConnection(),
): Promise<{ status: number; data: T }> {
  if (!conn.baseUrl || !conn.token) {
    throw new Ims2Error(503, {
      error: 'The IMS 2 intake queue is not configured (Settings → IMS 2 intake: queue URL and token)',
    });
  }
  const url = `${conn.baseUrl.replace(/\/$/, '')}${path}`;
  const headers = {
    Authorization: `Bearer ${conn.token}`,
    Accept: 'application/json',
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };
  let res: Response;
  try {
    if (method === 'GET') {
      res = await fetchWithRetry(url, fetch, {
        ...GET_RETRY,
        timeoutMs: config.IMS2_TIMEOUT_MS,
        headers,
        integration: 'ims2',
      });
    } else {
      const started = performance.now();
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(config.IMS2_TIMEOUT_MS),
      }).catch((err: unknown) => {
        observeOutbound('ims2', null, (performance.now() - started) / 1000);
        throw err;
      });
      observeOutbound('ims2', res.status, (performance.now() - started) / 1000);
    }
  } catch (err) {
    throw unreachable(err);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    const err =
      data && typeof data === 'object' ? (data as Record<string, unknown>) : { error: String(data ?? res.statusText) };
    throw new Ims2Error(res.status, explainNotConfigured(res.status, err, 'SUBMISSION_INTAKE_TOKEN'));
  }
  return { status: res.status, data: data as T };
}

/** Where a status url leads: IMS 2 sends an absolute url when it knows its own address, otherwise a path. */
export function queueAppUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const base = config.IMS2_APP_URL ?? ims2QueueBase()?.replace(/\/api(\/submission-intake)?\/?$/, '');
  return base ? `${base.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}` : url;
}

// ---- Lookup -------------------------------------------------------------------------------------------------------

/** No score here (unlike the Dev lookup): exact identifiers and substring names, best first, at most 10 each. */
export interface QueueInsuredHit {
  insuredId: string;
  canonicalName: string;
  insuredType: string | null;
  npi: string | null;
  email: string | null;
  licenseNumber: string | null;
  /** `active` or null can be chosen; any other status is hidden from the picker (IMS 2 blocks it in its own). */
  status: string | null;
  matchedOn: string[];
}

export interface QueueBrokerHit {
  id: number;
  brokerCode: string | null;
  brokerName: string;
  shortName: string | null;
  active: boolean;
  matchedOn: string[];
}

export interface QueueLookupResult {
  insureds: QueueInsuredHit[];
  brokers: QueueBrokerHit[];
}

export async function queueLookup(q: LookupQuery): Promise<QueueLookupResult> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (typeof v === 'string' && v.trim()) params.set(k, v.trim());
  // IMS 2 answers 400 to an empty lookup.
  if (![...params.keys()].length) return { insureds: [], brokers: [] };
  const { data } = await call<QueueLookupResult>('GET', `/lookup?${params}`);
  return { insureds: data?.insureds ?? [], brokers: data?.brokers ?? [] };
}

/**
 * Live check for Settings → Connections and Settings → IMS 2 intake: an authorized lookup that matches nothing proves
 * the URL and the token. `conn` defaults to the saved ones.
 */
export async function queueProbe(conn: QueueConnection = savedConnection()): Promise<string> {
  await call<QueueLookupResult>('GET', '/lookup?npi=0000000000', undefined, conn);
  return `Reachable · ${new URL(conn.baseUrl!).host}`;
}

// ---- Push ---------------------------------------------------------------------------------------------------------

/** Contract v1 (IMS 2 domain/contract.ts). Blank optional fields are left out, never sent as null. */
export interface IntakePushV1 {
  contractVersion: typeof QUEUE_CONTRACT_VERSION;
  intakeId: string;
  version: number;
  sourceUrl?: string;
  sentBy: string;
  receivedAt?: string;
  insured:
    | { mode: 'existing'; insuredId: string }
    | {
        mode: 'new';
        insuredType: 'individual' | 'entity';
        canonicalName: string;
        firstName?: string;
        lastName?: string;
        companyName?: string;
        npi?: string;
        email?: string;
        licenseNumber?: string;
      };
  broker: { brokerId?: number; brokerName?: string };
  policy: { effectiveDate: string } & Record<string, string | number>;
  location?: Record<string, string>;
  contact?: Record<string, string>;
  ratingIndication?: unknown;
  setupProposal?: unknown;
  fieldSources?: unknown;
  /** What the reviewer saw (IntakeReview), shown read-only on the IMS 2 intake page. */
  quote?: unknown;
  analysisReport?: unknown;
  coverage?: unknown;
  documents?: { filename: string; url: string }[];
}

export type IntakeStatusName = 'new' | 'linked' | 'rejected';

/** 201 (inserted) or 200 (updated / reopened / replayed); `status` is the intake's status after the push. */
export interface QueuePushResult {
  intakeId: string;
  version: number;
  status: IntakeStatusName;
  updated?: boolean;
  reopened?: boolean;
  replayed?: boolean;
}

/** Anything but 2xx throws Ims2Error; a 409 body carries `code` (linked / stale / version_reused) and `status`. */
export async function queuePush(body: IntakePushV1): Promise<QueuePushResult & { httpStatus: number }> {
  const { status, data } = await call<QueuePushResult>('POST', '/inbox', body);
  return { ...data, httpStatus: status };
}

// ---- Status -------------------------------------------------------------------------------------------------------

export interface IntakeStatus {
  intakeId: string;
  version: number;
  status: IntakeStatusName;
  statusChangedAt: string;
  submissionId: number | null;
  submissionNumber: string | null;
  url: string | null;
  workflowStatus: string | null;
  policyNumber: string | null;
  insuredId: string | null;
  linkedAt: string | null;
  rejectedReason: string | null;
  rejectedAt: string | null;
}

export async function queueStatus(intakeId: string): Promise<IntakeStatus> {
  const { data } = await call<IntakeStatus>('GET', `/inbox/${encodeURIComponent(intakeId)}/status`);
  return data;
}

/** One page of statuses, ordered by statusChangedAt; `since` is exclusive. Same filters with each `cursor`. */
export async function queueStatusPage(p: {
  since?: string | null;
  ids?: string[];
  status?: IntakeStatusName[];
  limit?: number;
  cursor?: string | null;
}) {
  const params = new URLSearchParams();
  if (p.since) params.set('since', p.since);
  if (p.ids?.length) params.set('ids', p.ids.join(','));
  if (p.status?.length) params.set('status', p.status.join(','));
  if (p.limit) params.set('limit', String(p.limit));
  if (p.cursor) params.set('cursor', p.cursor);
  const { data } = await call<{ items: IntakeStatus[]; nextCursor: string | null }>('GET', `/inbox/status?${params}`);
  return { items: data?.items ?? [], nextCursor: data?.nextCursor ?? null };
}
