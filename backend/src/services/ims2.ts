import { config } from '../config.js';

/**
 * What every call to IMS 2 shares (services/ims2IntakeQueue.ts is the client): its error, the reasons it could not be
 * reached, and the lookup query. IMS 2 owns its data: nothing here reads or writes its tables.
 */

/** An IMS 2 answer other than 2xx, or no answer at all (status 0). body is IMS 2's JSON ({ error, field?, ... }). */
export class Ims2Error extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === 'string' ? body.error : `IMS 2 answered ${status || 'nothing'}`);
    this.name = 'Ims2Error';
  }
  /** Network, timeout or 5xx: the same intakeId + version is safe to send again. */
  get retryable() {
    return this.status === 0 || (this.status >= 500 && this.status !== 503);
  }
  /** 401 / 503: the token here or IMS 2's is wrong or missing. Retrying will not help. */
  get misconfigured() {
    return this.status === 401 || this.status === 503;
  }
}

/**
 * No answer from IMS 2. Node's fetch says only "fetch failed"; the reason (refused, closed, DNS) is in err.cause, and
 * "closed" usually means the URL points at something that is not IMS 2 (e.g. its database port).
 */
export function unreachable(err: unknown): Ims2Error {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e.name === 'TimeoutError')
    return new Ims2Error(0, { error: `IMS 2 did not answer within ${config.IMS2_TIMEOUT_MS / 1000}s` });
  const code = e.cause?.code;
  const why =
    code === 'ECONNREFUSED'
      ? 'connection refused: is IMS 2 running on that port?'
      : code === 'UND_ERR_SOCKET'
        ? 'the connection was closed without an answer: check the URL points at the IMS 2 app, not its database'
        : code === 'ENOTFOUND'
          ? 'the host name was not found'
          : (e.cause?.message ?? e.message);
  return new Ims2Error(0, { error: `IMS 2 could not be reached (${why})` });
}

/** IMS 2's own 503 when it has no token: say which side to fix. */
export function explainNotConfigured(
  status: number,
  body: Record<string, unknown>,
  tokenVar: string,
): Record<string, unknown> {
  return status === 503 && typeof body.error === 'string' && /not configured/i.test(body.error)
    ? {
        ...body,
        error: `IMS 2 answered "${body.error}": set ${tokenVar} in IMS 2's .env (the same value as here) and restart IMS 2`,
      }
    : body;
}

export interface LookupQuery {
  npi?: string | null;
  email?: string | null;
  licenseNumber?: string | null;
  name?: string | null;
  brokerCode?: string | null;
  brokerName?: string | null;
}

/** Where a prefilled field's value came from: unchanged extraction, a change to it, or nothing extracted behind it. */
export type FieldSource = 'extracted' | 'edited' | 'manual';
