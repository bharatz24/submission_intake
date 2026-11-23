# Runbook

What to do when something goes wrong in production. Each entry: how it shows up, how to confirm, what to do. Deploy,
rollback and configuration are in [deploy.md](deploy.md).

Commands assume the `docker-compose.prod.yml` stack (`dc` = `docker compose -f docker-compose.prod.yml --env-file
deploy.env`). Logs are JSON (pino); `dc logs --since 1h api | grep '"level":50'` shows errors. Never paste log lines,
email content or applicant data into tickets or chat without redacting them.

## Where to look first

**`GET /api/ready`** (no auth): `{"ok":true,"db":true,"migrations":true}` when healthy.

| Answer                              | Meaning                                                                 | Do                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 503, `db:false`                     | The API cannot reach Postgres (down, wrong credentials, pool exhausted) | `dc ps db`, `dc logs db`; see [DB pool exhaustion](#db-pool-exhaustion-503-db_busy) |
| 503, `migrations:false`             | Migrations pending: the release step did not run or failed              | `dc logs migrate db-roles db-grants`; fix, then `dc up -d`                          |
| No answer, `/api/health` also fails | The process is down or restarting                                       | `dc ps api`, `dc logs api` (startup errors name the bad config)                     |
| `/api/health` OK, `/api/ready` slow | DB reachable but saturated                                              | see DB pool exhaustion                                                              |

**Settings → Monitoring** (admins): pipeline counts for the chosen range, the ingest queue (waiting / flagged /
parked, oldest), job queue depth, the last Gmail poll time, LLM usage and spend against the budgets, and **recent
system errors** (`recordSystemError`: Gmail poll/auth, job failures, budget alerts). A rising queue depth with no
progress, an old "last poll", or new system errors are the usual first signs. **Settings → Connections** tests the
database, Claude, Gmail, Drive and NPI live.

## Gmail disconnected / `invalid_grant`

- **Symptoms:** no new submissions; Settings → Connections shows Gmail failing; Monitoring shows a `gmail:auth`
  system error "Google rejected the stored Gmail authorization…"; logs: `gmail refresh token rejected
(invalid_grant); reconnect required`. The last poll time stops advancing.
- **Cause:** the refresh token was revoked (password change, admin revoked access, the OAuth app is in Google
  "Testing" status and the 7-day token lifetime ran out, scopes changed) or `ENCRYPTION_KEY` changed without
  `ENCRYPTION_KEYS_PREVIOUS`.
- **Fix:** an admin opens Settings → Gmail → **Connect** and signs in with the intake mailbox. Polling resumes on the
  next interval; mail that arrived meanwhile is picked up from the history cursor or, if that has expired (about a
  week), by the recent-mail fallback (last 2 days) and the daily reconciliation. For a longer outage use Settings →
  Gmail → Import for the missing days. If the OAuth app is in Testing status, publish it (or use an internal app) so
  tokens stop expiring.
- **Push (Pub/Sub) only:** a lapsed watch is renewed on each poll when it has less than a day left; polling covers
  the gap meanwhile.

## Claude credit or budget exhausted

- **Symptoms:** classification/extraction/report jobs fail; submissions show "Claude API credit is exhausted" (the
  friendly error for Anthropic's credit-balance/billing error); AI routes answer **429 `LLM_BUDGET_EXCEEDED`**
  (instance-wide daily token budget, `LLM_DAILY_TOKEN_BUDGET`) or **429 `LLM_SUBMISSION_BUDGET_EXCEEDED`** (per
  submission, `LLM_SUBMISSION_DAILY_TOKEN_BUDGET`); **503 `LLM_UNAVAILABLE`** when no API key is set. Monitoring →
  LLM usage shows spend against the budgets and the 80 % alert.
- **Credit:** top up the Anthropic account (console → Billing), then Settings → Claude API → **Test**. Retry failed
  submissions: Inbox → Errors → **Retry all** (or retry each; a retry resumes from the failed step).
- **Budget:** it is a guard against runaway cost (a loop, a flood of email). Check Monitoring for what consumed it
  before raising it. Raise `LLM_DAILY_TOKEN_BUDGET` / `LLM_SUBMISSION_DAILY_TOKEN_BUDGET` in `backend/.env` and
  `dc up -d api` only when the volume is legitimate; otherwise wait for the rolling window.
- **Bad key:** Settings → Claude API → enter the new key (stored encrypted, never shown again) → Test.

## Stuck jobs or ingest queue

- **Job queue** (`jobs` table: classification, extraction, reports): a worker claims a job with a lease
  (`JOB_LEASE_SECONDS`, 120 s); a job whose worker died is taken over when the lease lapses, so a crash or restart
  never strands work for long. If Monitoring's queue depth keeps growing: check `dc logs api` for repeated job errors
  (usually Claude or Drive), `JOB_CONCURRENCY` versus load, and the DB (below). Restarting the API is safe: shutdown
  drains for `SHUTDOWN_TIMEOUT_MS` and hands unfinished jobs back.
- **Submission stuck "processing":** open it and use **Retry** (resumes from the failed step); a submission whose job
  finished in error shows the step and the error.
- **Gmail ingest queue** (`gmail_ingest_queue`): message ids wait here until the email and every attachment are
  stored. Failures back off up to 6 h; after several attempts a row is **flagged** on Monitoring, after the maximum it
  is **parked** (dead letter, never retried automatically) and listed under Inbox → Errors. Fix the cause (Drive quota
  or permissions, Gmail auth), then **Retry** the message or Monitoring → **Retry now** for the whole queue. A message
  deleted from Gmail is dropped as gone, not retried forever.

## `ENCRYPTION_KEY` lost or rotated

- **Rotation (planned):** follow [deploy.md → Rotating ENCRYPTION_KEY](deploy.md#rotating-encryption_key): new key in
  `ENCRYPTION_KEY`, old one in `ENCRYPTION_KEYS_PREVIOUS`, restart, wait until Settings shows Claude and Gmail
  working, then remove the old key. Update the escrowed copy in the same change.
- **Lost (no copy of the key the secrets were encrypted with):** the stored Anthropic key and Gmail refresh token are
  unrecoverable; nothing else is encrypted with it (users, submissions and audit are unaffected). Generate a new key
  (`echo "base64:$(openssl rand -base64 32)"`), set it, restart; then re-enter the Anthropic key (Settings → Claude
  API) and reconnect Gmail. Record the incident; recover the key from escrow first if one exists
  ([deploy.md → Disaster recovery notes](deploy.md#disaster-recovery-notes-mon-06)).
- **Suspected leak:** treat as a security incident: rotate `ENCRYPTION_KEY` _and_ the secrets it
  protected (new Anthropic key, revoke and reconnect Gmail), since an attacker with a DB copy and the old key can
  decrypt them.

## DB pool exhaustion (503 `DB_BUSY`)

- **Symptoms:** requests answer **503 `DB_BUSY`** "The server is busy right now…" with `Retry-After`; logs warn
  about pool waits; `/api/ready` slow or `db:false`. A request waits at most `DB_CONNECTION_TIMEOUT_MS` (10 s) for a
  connection and a statement at most `DB_LOCK_TIMEOUT_MS` for a lock before this answer, instead of hanging.
- **Confirm:** `dc exec db psql -U ims -d ims -c "SELECT usename, state, wait_event_type, now()-query_start AS age,
left(query,80) FROM pg_stat_activity WHERE datname='ims' ORDER BY age DESC NULLS LAST"`. Look for many `active`
  long-running queries, `idle in transaction` sessions (closed after `DB_IDLE_IN_TX_TIMEOUT_MS`) or lock waits.
- **Fix:** a burst clears by itself. For sustained load: lower `JOB_CONCURRENCY` (jobs hold connections), or raise
  `DB_POOL_MAX` within Postgres `max_connections` across all instances ([deploy.md → Sizing](deploy.md#sizing)).
  Cancel a runaway query with `SELECT pg_cancel_backend(<pid>)`. Restart the API only if the pool does not recover.

## Release went wrong

Roll back the images by `RELEASE_SHA` ([deploy.md → Rollback](deploy.md#rollback)). If the `migrate` job failed, its
transaction rolled back and the new API image is not started (`api` waits for the release jobs, and refuses to start
with pending migrations): read `dc logs migrate`, then either fix forward or set `RELEASE_SHA` back and `dc up -d`.
