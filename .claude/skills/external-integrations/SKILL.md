---
name: external-integrations
description: Use when the backend talks to an external system — Gmail API (OAuth, history sync, Pub/Sub push, watch renewal, sending replies/forwards with MIME threading), Gmail via MCP, Google Drive attachment storage, the CMS NPPES NPI Registry, IMS/IMS2 handoffs, or any new third-party API. Covers adapter design, OAuth token storage and refresh, least-privilege scopes, timeouts, retries and rate limits, idempotent sync cursors, webhook verification, response validation, caching, fakes for tests, and failure isolation.
---

# External Integrations

External systems are slow, rate-limited, occasionally wrong, and change without notice. Each one gets an
**adapter** that hides its quirks behind a small typed interface, so the rest of the app never handles a
raw Google/CMS response, and tests can swap in a fake.

Related: `background-jobs` (where most calls run), `security` (secrets, SSRF), `llm-integration`
(the Anthropic adapter), `testing` (fakes), `environment-config`.

## Rules

- **One adapter per system** in `integrations/<system>/` (`gmail`, `drive`, `npi`, `ims`, `anthropic`),
  exposing domain-shaped functions (`listNewMessages(cursor)`, `sendReply(draft)`, `lookupNpi(npi)`) and
  domain types. Route and service code never imports `googleapis` directly.
- **Define the adapter as an interface** and inject the implementation (`createApp(deps)`), with a fake
  for tests and local development without credentials.
- **Validate responses with Zod** at the adapter edge. Upstream APIs add, drop or null fields; fail with a
  clear `UPSTREAM_INVALID_RESPONSE` instead of propagating `undefined`.
- **Every call has a timeout** (AbortSignal) and goes through a shared retry helper: retry 429/5xx/network
  with exponential backoff + jitter, honour `Retry-After`, never retry 4xx validation/auth errors.
- **Least privilege:** request the narrowest scopes that work (`gmail.readonly` + `gmail.send`, adding
  `gmail.modify` only if the app must label or archive). For Drive prefer `drive.file`, which reaches only
  files the app created or the user picked; it can't write into a folder a person created, so if the
  storage folder is user-owned, either let the app create it or use the full `drive` scope and record
  why. Never add scopes "just in case", and document why each one is needed.
- **OAuth tokens:** store refresh tokens encrypted (AES-256-GCM, see `security`), refresh access tokens
  automatically, detect revoked/expired grants (`invalid_grant`) and surface a "Reconnect Gmail" state in
  Settings instead of failing silently in a loop. Bind the OAuth flow with a `state` parameter (and a
  short-lived cookie) to prevent login CSRF.
- **Sync with cursors, not timestamps:** Gmail uses `historyId`; persist the cursor only after the batch
  is safely stored, handle "history too old" by falling back to a bounded full sync, and dedupe by message
  id so overlap is harmless.
- **Webhooks/push** verify a shared secret or token (constant-time compare) and only enqueue a fetch; the
  payload itself is never trusted as data.
- **Outbound mail** is threaded correctly (`In-Reply-To`, `References`, `threadId`), built with a MIME
  library or a well-tested builder that encodes headers (RFC 2047) and rejects CR/LF in header values
  (header injection), and recorded with the provider message id, sender, and audit event.
- **Respect rate limits proactively:** bounded concurrency per integration; batch where the API supports
  it; cache idempotent lookups (NPI by number, ZIP→county) with a TTL and record the fetch time so data
  freshness is visible.
- **Isolate failures:** an NPI outage marks the NPI stage failed and retryable; it doesn't fail ingestion or
  hide already-extracted data. Show integration health (last success, last error, lag) on Monitoring.
- **Compare, don't overwrite:** registry data (NPI name/state/taxonomy) is compared against submitted
  data and differences are flagged for the underwriter, never silently "corrected".
- **Storage integrations** (Drive) record a SHA-256 hash and size for each file, verify on read when
  integrity matters, write the DB row and file in an order that leaves no orphans (or sweep orphans
  safely with a limit), and never delete remote files during a sweep against a restored or mismatched
  database.

## Patterns

```ts
// integrations/npi/npi.client.ts
export interface NpiClient { lookup(npi: string, signal?: AbortSignal): Promise<NpiRecord | null> }

const npiResponseSchema = z.object({ result_count: z.number(), results: z.array(npiResultSchema).optional() });

export function createNpiClient({ baseUrl, timeoutMs }: NpiConfig): NpiClient {
  return {
    async lookup(npi, signal) {
      if (!isValidNpi(npi)) throw new AppError('NPI_INVALID', 400, 'NPI must be 10 digits with a valid check digit');
      const url = `${baseUrl}/?version=2.1&number=${encodeURIComponent(npi)}`;
      const json = await withRetry(() => fetchJson(url, { signal: anySignal(signal, timeoutMs) }), { retries: 3 });
      const parsed = npiResponseSchema.safeParse(json);
      if (!parsed.success) throw new AppError('UPSTREAM_INVALID_RESPONSE', 502, 'The NPI registry returned an unexpected response');
      const first = parsed.data.results?.[0];
      return first ? toNpiRecord(first) : null;
    },
  };
}
```

```ts
// Shared retry helper (transient errors only, honours Retry-After)
export async function withRetry<T>(fn: () => Promise<T>, { retries = 3, baseMs = 500 } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt > retries || !isTransient(error)) throw error;
      await sleep(retryAfterMs(error) ?? backoffMs(attempt, baseMs));
    }
  }
}
```

## Review checklist

- [ ] Calls go through a typed adapter with an injectable fake
- [ ] Responses Zod-validated; timeouts on every call; retries only for transient errors
- [ ] Narrowest OAuth scopes; refresh tokens encrypted; revoked grants surface a reconnect state
- [ ] Sync uses persisted cursors and dedupes; push payloads only trigger fetches
- [ ] Outbound email threaded, header-injection safe, recorded and audited
- [ ] Failures isolated to their stage and visible on Monitoring
