# Deploying Submission Review on Netlify

One Netlify site serves the SPA (`frontend/dist`) and the Express API (Netlify Functions) on the same origin: `/api/*`
is rewritten to the `api` function, so the session cookie and CSRF header work exactly as behind nginx. The Docker
Compose deployment ([deploy.md](deploy.md)) is unchanged and remains the fallback; nothing below affects it.

## How it runs

`RUNTIME=netlify` (backend) changes how work is **triggered**, not what it does:

| Server (`RUNTIME=server`)                        | Netlify (`RUNTIME=netlify`)                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Job poll loop + LISTEN/NOTIFY in the API process | `enqueue` POSTs to `worker-background`, which drains the `jobs` table (15 min limit)          |
| Startup requeue of orphaned work                 | `jobs-kick` (every minute) → `recover`: requeues orphans, drains due retries and lapsed jobs  |
| Gmail monitor timer                              | `gmail-poll` (every minute; honours Settings → Monitoring "off")                              |
| Daily reconcile / weekly Drive sweep / retention | `daily-maintenance` (03:15 UTC; Drive sweep on Sundays)                                       |
| Rates / ZIP import at startup                    | `deploy-succeeded` → `bootstrap`, then `recover`                                              |
| Settings synced by LISTEN/NOTIFY                 | re-read at the start of a request when older than 30 s                                        |
| SSE notification stream                          | SPA polls `GET /api/events/since` every 15 s (`VITE_EVENTS_TRANSPORT=poll`)                   |
| Multipart uploads up to 100 MB                   | 3 MiB chunks held in Netlify Blobs (`VITE_UPLOAD_MODE=chunked`), assembled by the upload call |
| Gmail poll / IMS 2 sync / ZIP reload after a 202 | handed to the worker (`gmail-manual-poll`, `ims2-sync`, `geo-import`)                         |

The worker stops claiming jobs after 12 minutes and at 14 minutes hands unfinished jobs back to the queue (attempt not
counted). A worker killed anyway leaves its job `running` with a lease that lapses; the next `recover` reclaims it and
counts the attempt. Every worker trigger carries `WORKER_TOKEN`; anything else is refused and logged.

## Prerequisites

- A Netlify plan with background and scheduled functions. Functions run with the default 1 GB; configurable memory
  (3 GB for the worker's OCR, see `netlify.toml`) needs a Pro plan with credit-based pricing. Each production deploy costs build credits: test on deploy previews / branch deploys.
- PostgreSQL 16 reachable from Netlify: Netlify DB or Neon. Use the **pooled** connection URL for `DATABASE_URL`
  (functions open few connections each, `DB_POOL_MAX` 3 and `DB_LOCK_POOL_MAX` 2 by default, but many instances).
- Least-privilege roles: run [`backend/scripts/db-roles.sql`](../backend/scripts/db-roles.sql) once as the database
  owner before the first deploy, and again after the first deploy on a fresh database (so `audit_events` gets its
  revokes); see [deploy.md → Database roles](deploy.md#database-roles-least-privilege). The build migrates as
  `ims_migrator`; the functions connect as `ims_app`.
- A Google Cloud OAuth client and Drive refresh token, as for the Docker deployment.

## Environment variables

Set them in Netlify → Site configuration → Environment variables. **Secrets use the scope Functions only**; nothing
secret is ever prefixed `VITE_` (those are baked into the public bundle). Functions get at most 4 KB of variables in
total: set only what differs from [`backend/env.example`](../backend/env.example).

| Name                       | Scope     | Example / note                                                             |
| -------------------------- | --------- | -------------------------------------------------------------------------- |
| `NODE_ENV`                 | Functions | `production`                                                               |
| `RUNTIME`                  | Functions | `netlify`                                                                  |
| `WORKER_TOKEN`             | Functions | `openssl rand -hex 32` (required with `RUNTIME=netlify`)                   |
| `DATABASE_URL`             | Functions | pooled URL as `ims_app`                                                    |
| `MIGRATOR_DATABASE_URL`    | Builds    | URL as `ims_migrator`; read only by `netlify/migrate.mjs` during the build |
| `JWT_SECRET`               | Functions | `openssl rand -base64 48`                                                  |
| `ENCRYPTION_KEY`           | Functions | `base64:` + `openssl rand -base64 32`                                      |
| `SETUP_TOKEN`              | Functions | one-time first-admin secret (16+ chars); remove after setup                |
| `GOOGLE_CLIENT_ID`         | Functions |                                                                            |
| `GOOGLE_CLIENT_SECRET`     | Functions |                                                                            |
| `GOOGLE_REFRESH_TOKEN`     | Functions | Drive scope                                                                |
| `GOOGLE_REDIRECT_URI`      | Functions | `https://<site>/api/gmail/oauth/callback`                                  |
| `FRONTEND_ORIGIN`          | Functions | `https://<site>`                                                           |
| `GMAIL_PUBSUB_TOPIC`       | Functions | optional: push instead of the one-minute poll                              |
| `GMAIL_PUSH_TOKEN`         | Functions | optional, with the topic                                                   |
| `OUTBOUND_ALLOWED_DOMAINS` | Functions | recipient domains replies may go to                                        |
| `GDRIVE_ROOT_FOLDER_NAME`  | Functions | different per environment sharing a Google account                         |
| `TRUST_PROXY`              | Functions | leave unset (`false`): see Client IP below                                 |
| `MIGRATE_ON_BOOT`          | Functions | `false` (the build migrates)                                               |
| `EXTRACTION_WORKERS`       | Functions | `0` (parse in-thread: worker-thread files do not survive bundling)         |
| `SKILLS_PATH`              | Functions | `backend/skills`                                                           |
| `RATES_DIR`                | Functions | `backend/data/rates`                                                       |
| `OCR_DATA_PATH`            | Functions | `backend/assets/ocr`                                                       |

`VITE_EVENTS_TRANSPORT=poll` and `VITE_UPLOAD_MODE=chunked` are set in [`netlify.toml`](../netlify.toml)
(`[build.environment]`); they are not secrets. Variables in `netlify.toml` do not reach functions, which is why the
non-secret function settings above are set in the UI too.

## Client IP

serverless-http takes the request's socket address from a field Netlify's events do not carry, so `req.ip` would be
empty (and the per-IP rate limiter would fail). The API function copies Netlify's edge header
`x-nf-client-connection-ip` (set by Netlify, not by the client) into that field and drops `X-Forwarded-For`
(`backend/src/runtime/lambdaEvent.ts`). Express then sees the real client as the socket address, so `TRUST_PROXY` must
stay `false`: trusting `X-Forwarded-For` as well would let a client choose its own address.

## Google Cloud console

- OAuth client → Authorized redirect URIs: add `https://<site>/api/gmail/oauth/callback`.
- Gmail push (optional): Pub/Sub push subscription endpoint `https://<site>/api/gmail/push?token=<GMAIL_PUSH_TOKEN>`.
  Once it delivers, delete `netlify/functions/gmail-poll.mts` (the daily reconciliation still catches anything missed).

## Deploying

Connect the repository; Netlify reads [`netlify.toml`](../netlify.toml). The build runs, in order: backend build,
**migrations** (`netlify/migrate.mjs`, forward-only, an edited applied migration fails the deploy), SPA build, function
dependencies. Migrations follow the expand/contract policy in [deploy.md](deploy.md#migration-policy-expand--contract):
the previous deploy keeps serving until the new one is published, so every migration must be safe for the old code.

After the first deploy, watch the worker function's log for out-of-memory errors on OCR or large documents at the
default 1 GB; if they occur, move to a plan with configurable memory and restore the 3 GB setting in `netlify.toml`.

## Smoke test (branch deploy on a staging database, then production)

1. First-admin setup with `SETUP_TOKEN`; sign in; the session cookie is set.
2. `GET /api/health` is OK; sign in and check that the API function's request log shows your own IP as
   `remoteAddress` (not a Netlify address): see Client IP below.
3. Upload a 20 MB PDF (several chunks; the per-file limit is 25 MB by default, Settings → Limits); its extraction runs in a `worker-background` log; fields appear.
4. Connect Gmail in the popup; a new email arrives in the inbox and the notification bell within ~15 s.
5. Full pipeline run (`/test-pipeline`), Synthesis report, Analysis.
6. Functions log: no timeouts, no out-of-memory.

Scheduled functions run on the **published production deploy only**. On a branch deploy, work runs only when
something triggers the worker (an enqueue, an upload, Poll now); due retries and lapsed jobs wait for one.

For production, also set a credit-usage alert.

## Rollback

Netlify → Deploys → pick the previous deploy → **Publish deploy**. Migrations are forward-only and are not undone: the
previous code must work with the newer schema, which expand/contract guarantees. Restoring a database backup is the last
resort ([deploy.md → Rollback](deploy.md#rollback)). The Docker Compose deployment stays available as a fallback.

## Known limits on this runtime

- **Downloads above ~4.5 MB through the API fail.** A function response is buffered and capped at 6 MB, and binary
  bodies are base64-encoded. Opening or downloading a larger stored document needs a different path (for example a
  short-lived Drive link); until then, open those in Google Drive.
- **"Running" for Poll now, IMS 2 sync and ZIP reload is not shown**: they run in the worker, not in the instance the
  status request reaches. Their screens still finish when the stored "last run" time passes the start time.
- **Rate workbooks upload in one request**, so a workbook above ~4.5 MB is refused there.
- A notification can be missed when an email's ingest commits after a later one was already polled; the inbox list
  itself always shows it.
