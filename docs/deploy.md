# Deploying Submission Review

## Artifacts

| Image | Built from            | Serves                                                                                               |
| ----- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| API   | `backend/Dockerfile`  | Express API on `:3002`, non-root, `node dist/server.js`                                              |
| Web   | `frontend/Dockerfile` | nginx (unprivileged, uid 101) on `:8080`: the built SPA, `/api` proxied to the API, security headers |

There is no CI pipeline: nothing runs on push, pull request or merge. Run the checks locally before merging
(`npm run typecheck`, `npm run lint`, `npm run test:coverage` and `npm run build` in `backend/` and `frontend/`, and
`npm test` in `e2e/`). Images are built and pushed by hand; production runs exactly those images (see Release steps);
nothing is built on the server.

Alternatively the SPA and the API can run on one Netlify site (Functions, `RUNTIME=netlify`): see
[deploy-netlify.md](deploy-netlify.md). Everything else in this document is about the Docker Compose deployment.

Base images (Dockerfiles, compose) are pinned by digest; bump them by hand (there is no Dependabot). Use
`npm outdated` and `npm audit` in each app to find dependency updates. Dependency version ranges in `package.json` stay
caret ranges: the committed lockfiles plus `npm ci` make installs reproducible (OPS-11, accepted).

## Topology

```
browser ──HTTPS──> TLS edge (LB / Caddy / Traefik) ──HTTP──> web (nginx :8080) ──/api──> api (:3002) ──> Postgres
```

- **TLS** terminates at the edge. Redirect HTTP to HTTPS there, and have the edge set `X-Forwarded-Proto`: nginx
  passes it through to the API unchanged. nginx sends `Strict-Transport-Security`, which browsers only honour over
  HTTPS.
- **web container**: `nginxinc/nginx-unprivileged` running as uid 101 (non-root) on `:8080`, with a Docker
  `HEALTHCHECK` on `GET /healthz`. Access logs omit query strings (search terms and ids in them can be PHI).
- **Headers** come from `frontend/nginx/security-headers.conf`, included in every `location` (nginx does not inherit
  `add_header` into a location that sets its own): CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS. The API adds its own through helmet.
- **Timeouts and SSE**: `/api/` is proxied with a 300 s timeout. The notification stream has its own
  `location = /api/events/stream` with buffering off and a 1 h read timeout. The edge proxy also needs buffering off
  for that path and an idle timeout above 30 s (the heartbeat is every 25 s).
- **`TRUST_PROXY`** is the number of proxies that set `X-Forwarded-For` in front of the API. With the edge plus
  nginx, and the edge appending its own entry, that's `2`, which is what `docker-compose.prod.yml` uses
  (`${TRUST_PROXY:-2}`). Set `TRUST_PROXY=1` in `deploy.env` only if nothing sits in front of `web`. Never `true`. A
  value too low makes every client share the edge's IP, so one rate-limit bucket (and login lockout) covers all users;
  too high lets clients spoof their IP.

## Configuration

Two files live on the host, neither committed:

- **`backend/.env`** (from `backend/env.example`): the API's configuration, loaded into the `api` and `migrate`
  containers.
- **`deploy.env`** (from the root `.env.example`): what `docker-compose.prod.yml` interpolates: `RELEASE_SHA`, `IMAGE_PREFIX`
  (`ghcr.io/<owner>/<repo>`, lowercase), `POSTGRES_PASSWORD`, `MIGRATOR_DB_PASSWORD`, `APP_DB_PASSWORD` and optionally
  `TRUST_PROXY`. Keep the database passwords out of `backend/.env`, which the API container sees. `chmod 600` both.

`DATABASE_URL` is required in production (compose sets it per service, see Database roles). Production refuses to
start unless:

- **`JWT_SECRET`** and **`ENCRYPTION_KEY`** are set (`env.example` leaves them blank), are not placeholder or weak
  values (anything copied from the docs, repetitive strings, too short), and differ from each other. Generate them:
  - `JWT_SECRET`: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`
  - `ENCRYPTION_KEY`: `echo "base64:$(openssl rand -base64 32)"` (production accepts only this `base64:` 32-byte form)
- **`FRONTEND_ORIGIN`** and **`GOOGLE_REDIRECT_URI`** are `https://` URLs on a non-localhost host (the public origin,
  and `https://<host>/api/gmail/oauth/callback`).

**First administrator (`SETUP_TOKEN`).** In production the first account (the admin) can only be created with the
setup token: set `SETUP_TOKEN` (16+ random characters, e.g. `openssl rand -hex 16`) in `backend/.env` **before the
first boot**, then enter it in the setup form on the login page. Without it registration answers 503, with a wrong one 403. Once a user exists the token is unused; remove it afterwards.

**Existing deployment with a passphrase `ENCRYPTION_KEY`.** Production now requires the `base64:` form, so an instance
still configured with a passphrase refuses to start. Before upgrading: generate a new `base64:` key, set it as
`ENCRYPTION_KEY`, and move the old passphrase into `ENCRYPTION_KEYS_PREVIOUS`; the stored secrets are then re-encrypted
as described in [Rotating ENCRYPTION_KEY](#rotating-encryption_key).

### Database roles (least privilege)

The application never connects as the Postgres superuser. `backend/scripts/db-roles.sql` (idempotent) creates:

| Role              | Used by                               | Rights                                                                                                                                                                  |
| ----------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ims` (superuser) | the release jobs only (backup, roles) | bootstrap (`POSTGRES_USER`); never in `backend/.env`                                                                                                                    |
| `ims_migrator`    | `migrate` (`MIGRATOR_DB_PASSWORD`)    | owns the database, schemas and every table/function, so it runs DDL; as owner it can also alter `audit_events` (e.g. a migration that must disable its trigger)         |
| `ims_app`         | `api` (`APP_DB_PASSWORD`)             | `SELECT/INSERT/UPDATE/DELETE` only (default privileges cover future tables); no DDL, no `TRUNCATE`; no `UPDATE/DELETE` on `audit_events`; read-only `schema_migrations` |

`docker-compose.prod.yml` runs the script as the `db-roles` job (before `migrate`) and again as `db-grants` (after it,
so tables a release creates, and `audit_events` on a fresh database, get their grants and revokes), on every `up`.
Use URL-safe passwords (`openssl rand -hex 24`): they are embedded in connection URLs.

**Existing deployments** (migrated as the superuser) must run the script once: the first `up` of this version does it
automatically (it also hands ownership of the existing objects to `ims_migrator`). With another orchestrator, run it
yourself before the first migrate under the new role, and after every migrate:

```bash
psql "postgres://ims:$POSTGRES_PASSWORD@<db host>:5432/ims" \
  -v migrator_password="$MIGRATOR_DB_PASSWORD" -v app_password="$APP_DB_PASSWORD" -f backend/scripts/db-roles.sql
```

then point the migrate job at `postgres://ims_migrator:…@<host>/ims` and the API at `postgres://ims_app:…@<host>/ims`.
Rotating a role's password is the same command with the new value, followed by updating `deploy.env` and `up -d`.

### Data protection at rest and in transit (DB-19)

The database holds PHI/PII in plain columns (email bodies, extracted document text, LLM transcripts):

- **Disk encryption is required** for the Postgres data volume (`pgdata`), its backups and the host's swap/temp
  (where uploads are spooled): LUKS/dm-crypt on the host, or an encrypted cloud volume (EBS/PD/Azure disk with
  encryption on). A managed Postgres must have storage encryption enabled.
- **TLS to the database is required whenever it is off-host** (managed Postgres, another VM): add
  `?sslmode=verify-full&sslrootcert=/path/ca.pem` to both connection URLs and mount the CA into the containers.
  `sslmode=require` does not verify the server and is not enough. The bundled compose `db` service is reached over the
  private Docker network on the same host and needs no TLS.

## Rotating ENCRYPTION_KEY

`ENCRYPTION_KEY` encrypts the Gmail refresh token and the Anthropic API key in the database. Each stored value names
the key that encrypted it, so the key can be changed without re-entering either secret:

1. Generate a new key: `echo "base64:$(openssl rand -base64 32)"`.
2. Set `ENCRYPTION_KEY` to the new key and `ENCRYPTION_KEYS_PREVIOUS` to the old value, then restart every instance.
3. Each secret is re-encrypted under the new key the first time it is read: the Anthropic key at startup, the Gmail
   token on the next poll (within minutes while Gmail is connected).
4. Once Settings shows Claude and Gmail working, remove `ENCRYPTION_KEYS_PREVIOUS` and restart.

Changing `ENCRYPTION_KEY` without step 2 makes both secrets unreadable: Settings then asks for the Anthropic key again
and Gmail must be reconnected.

## Health checks

| Endpoint          | Meaning                                       | Use for                                 |
| ----------------- | --------------------------------------------- | --------------------------------------- |
| `GET /api/health` | The process answers (no dependencies)         | Liveness / Docker `HEALTHCHECK`         |
| `GET /api/ready`  | The DB answers and every migration is applied | Readiness / load-balancer target health |

## Release steps

A release is a commit on `main` whose CI run is green; its images are
`${IMAGE_PREFIX}-backend:<sha>` and `${IMAGE_PREFIX}-frontend:<sha>`. To deploy it:

```bash
# on the host, in the directory holding docker-compose.prod.yml, deploy.env, backend/.env, backend/scripts/db-roles.sql
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u <user> --password-stdin   # once; a token with read:packages
sed -i "s/^RELEASE_SHA=.*/RELEASE_SHA=<full commit sha>/" deploy.env
docker compose -f docker-compose.prod.yml --env-file deploy.env pull
docker compose -f docker-compose.prod.yml --env-file deploy.env up -d
```

`up` runs the release step itself, before the API starts:

1. **Back up** (`backup` service): `pg_dump -Fc` into the `backups` volume as `pre-deploy-<UTC time>.dump`. A failed
   dump stops the release.
2. **Roles** (`db-roles`): `backend/scripts/db-roles.sql` as the superuser (see Database roles).
3. **Migrate** (`migrate` service, as `ims_migrator`): `node dist/db/migrate.js` from the release image, under the
   migration advisory lock.
4. **Grants** (`db-grants`): the same script again, for what the migrations created.
5. **Start** the API (as `ims_app`) with `MIGRATE_ON_BOOT=false`: it refuses to start while any migration is pending,
   so an instance never runs against an older schema. (Development keeps the default `MIGRATE_ON_BOOT=true`.)
   `web` starts once the API's health check passes. Shutdown drains running jobs for `SHUTDOWN_TIMEOUT_MS` (25 s) and
   hands the rest back to the queue, so give the orchestrator a stop grace period of at least 40 s.
6. **Verify**: `curl -fsS http://127.0.0.1:8080/api/ready` returns 200, Settings → Monitoring shows no new system
   errors, and (optionally) the smoke test passes against the deployment:
   `cd e2e && E2E_BASE_URL=https://<host> E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… npm test`.

Every container has a memory and CPU limit and rotated `json-file` logs (10 MB × 5); adjust `mem_limit`/`cpus` in the
compose file to the host.

Another orchestrator does the same: a one-off backup job, the roles job, a one-off `node dist/db/migrate.js` job with
the migrator URL, the roles job again, then the API (app-role URL, `MIGRATE_ON_BOOT=false`) and web images pinned to
the same SHA.

## Rollback

**Image rollback (the normal case).** Set `RELEASE_SHA` back to the previous release's SHA and `up` again:

```bash
sed -i "s/^RELEASE_SHA=.*/RELEASE_SHA=<previous sha>/" deploy.env
docker compose -f docker-compose.prod.yml --env-file deploy.env up -d
```

The previous image starts against the current schema. That is safe only because migrations follow the
expand/contract policy below: a release's schema is always readable and writable by the release before it. The
migrate step of the older image has no new files to apply. Keep a record of each deployed SHA (e.g. the deploy log or
a git tag `deploy-<date>`) so "previous" is unambiguous, and rehearse a rollback on staging before relying on it.

**Database restore (last resort).** Only when a migration itself destroyed or corrupted data: restore the
pre-deploy dump (README "Backup & restore") and deploy the previous SHA. This discards everything written since the
dump, so prefer a forward fix.

## Migration policy: expand / contract

Migrations are forward-only and run before the new code starts, while the old code may still be serving (and may be
rolled back to). Every migration must therefore be compatible with **both** the previous and the new release:

1. **Expand** (release N): add tables, nullable columns or columns with defaults, new indexes
   (`CREATE INDEX CONCURRENTLY` where the table is large), new constraints as `NOT VALID` then `VALIDATE`. The new
   code writes both old and new shapes if it renamed something.
2. **Migrate data** (release N or a backfill): copy or derive values in batches; idempotent.
3. **Contract** (release N+1 or later, once N is the rollback target and no longer N-1): drop the old column/table,
   tighten `NOT NULL`, remove the dual writes.

Never in one release: rename or drop a column/table the previous release reads, change a column's type in place, or
add a `NOT NULL` column without a default. A migration that cannot follow this (rare) is called out in the PR and
the release notes, and its rollback plan is a database restore. `scripts/check-migrations.mjs` and the migration
checksum check keep applied migrations immutable.

## Branch protection (OPS-10)

Configure on `main` in GitHub → Settings → Branches (not visible from the repository, so verify it there):

- Require a pull request with at least one approval. Do not enable **Require review from Code Owners**: there is no
  CODEOWNERS file. Dismiss stale approvals on new commits.
- Do not require status checks: there are no CI workflows, so a required check would block every merge.
- Require linear history; block force pushes and deletions; include administrators.

## Disaster recovery notes (MON-06)

Backups themselves are out of scope here (the pre-deploy dump is the only one this repository produces). Whatever
backup system is put in place, record these decisions:

- **RPO / RTO**: _to be set by the business owner_ (placeholder: RPO ≤ 24 h, RTO ≤ 4 h). Write the agreed values here
  and test them with a restore drill.
- **`ENCRYPTION_KEY` escrow**: a database restore is useless for Gmail and the Anthropic key without the key that
  encrypted them, and a lost key means re-entering both. Keep the current `ENCRYPTION_KEY` (and any value still in
  `ENCRYPTION_KEYS_PREVIOUS`) in the organisation's secret manager or a sealed escrow held by two people, separate from
  the database backups; update the escrow in the same change as a rotation. The same applies to `JWT_SECRET` (losing it
  only signs everyone out) and the database role passwords.
- **Drive attachments**: documents live in the Google Drive folder, not in the database. Database backups do not
  contain them; Drive's own trash/version history (and Google Workspace retention or Vault, if licensed) is their only
  copy. Decide whether that is enough, keep the folder in a shared drive owned by the organisation rather than a
  person, and remember that the retention purge (`docs/data-retention.md`) deletes files there too.
- **Restore order**: database → `deploy.env` / `backend/.env` with the escrowed keys → `up` with the SHA that was
  running → `/api/ready` → check Settings → Connections (Gmail, Drive, Claude).

## Sizing

- Nothing is purged until an admin sets periods in Settings → Data retention (all default to keep forever; see
  `docs/data-retention.md`). Until then the database, its backups and the Drive folder grow with every submission.
  Plan storage and backup retention for that, expire backups in line with those periods, and encrypt backups (they
  hold PHI/PII).

- DB connections per instance: `DB_POOL_MAX` (default `JOB_CONCURRENCY × 2 + 10`) plus `DB_LOCK_POOL_MAX`
  (default `JOB_CONCURRENCY + 4`). Keep the total across instances under Postgres `max_connections`.
- Memory: browser uploads are written to a temporary file (the OS temp directory) and streamed to Drive in chunks,
  so they no longer sit in memory; only files up to 10 MB are kept in the Drive cache (`GDRIVE_CACHE_MB`). Downloads
  over 10 MB stream from Drive. Email attachments arrive from Gmail whole and are held while they are stored. Leave
  temp-disk space for `UPLOAD_CONCURRENCY × UPLOAD_MAX_TOTAL_MB`. Set a container memory limit and watch RSS.
- Document parsing runs in `EXTRACTION_WORKERS` worker threads (default 2), each with a heap limit of
  `EXTRACTION_WORKER_MAX_MB` (default 512) and an OCR engine (~150 MB). A file that hits the heap limit or
  `EXTRACTION_WORKER_TIMEOUT_MS` fails on its own; the worker is replaced. Budget roughly
  `EXTRACTION_WORKERS × (EXTRACTION_WORKER_MAX_MB + 150 MB)` on top of the API's own memory, and raise `mem_limit`
  in `docker-compose.prod.yml` if you add workers.

## Local production-like run

`docker-compose.prod.yml` only runs released images. To try the production stack with an image CI has published, write
a `deploy.env` with a real `RELEASE_SHA` and `IMAGE_PREFIX`, then:

```bash
docker compose -f docker-compose.prod.yml --env-file deploy.env up -d
curl -fsS http://127.0.0.1:8080/api/ready
```

To test unreleased local changes, build and tag the images yourself and point the variables at them:

```bash
docker build -t local/submission-review-backend:dev backend
docker build -t local/submission-review-frontend:dev frontend
IMAGE_PREFIX=local/submission-review RELEASE_SHA=dev docker compose -f docker-compose.prod.yml --env-file deploy.env up -d
```

`docker compose -f docker-compose.prod.yml --env-file deploy.env config` renders the file without starting anything,
and names any missing variable.
