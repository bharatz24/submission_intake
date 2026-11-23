# Gmail Submission Intake, Monitoring & AI Review Platform

From email to insight: automated, intelligent, auditable.

```
Gmail (read + send replies) → Dedup → Classify → Extract (PDF/DOCX/XLSX/OCR) → Verify NPI (CMS) → Synthesis (Claude, skill-driven)
   → Analysis (Claude, skill-driven) → Versioned Assessment → Audit Trail → React Dashboard
```

> Synthesis creates the facts. LLM Analysis interprets the risks. The underwriter decides.

## Layout

```
backend/                 Node.js + TypeScript + Express API
  src/
    app.ts, server.ts    HTTP app + startup (runs migrations, starts Gmail monitor)
    config.ts            zod-validated environment
    http.ts              auth (JWT), roles, errors, validation helpers
    db/                  pg pool, SQL migrations, migrator
    modules/             one folder per domain (inbox, submissions, reports, npi, gmail, rating, ims2, …):
                         <domain>.routes.ts → .service.ts → .repository.ts, built from createApp(deps)
    integrations/        Drive, Gmail, IMS 2 and NPI clients behind interfaces (injected; setIntegrations in tests)
    services/
      gmail.ts           OAuth (gmail.readonly + gmail.send), history polling, Pub/Sub push, watch renewal, sending
      outbound.ts + mime.ts  reply / reply all / forward from a submission (threaded, attachments, audit)
      fields.ts          manual field entries; effectiveFields() = manual first, then extracted
      notifications.ts   new-email event bus + replay for GET /api/events/stream (SSE, modules/events)
      duplicates.ts      content duplicate detection at ingest (fingerprints, rules R1–R5; no LLM)
      classificationRules.ts + classification.ts   rule scoring, then Claude when the rules are not decisive
      textExtraction.ts  pdf-parse (OCR fallback for scans), mammoth, exceljs, tesseract.js
      fieldExtraction.ts Claude field extraction with verbatim evidence quotes
      npi.ts             CMS NPPES lookup, Luhn check, name/state/taxonomy comparison
      pipeline.ts        ingest → dedup → classify → extract → NPI → context version
      skills.ts          skill loader; skill version = semver + content hash
      reports.ts         versioned Synthesis / Analysis generation (async jobs)
      reportSchemas.ts   structured-output schemas + markdown rendering
      contextVersion.ts  evidence snapshot hashing → context versions
      audit.ts           append-only audit events (DB trigger blocks UPDATE/DELETE)
  skills/
    synthesis/           SKILL.md + references/ (applicant-profile, document-reconciliation, dpl-manual-facts, npi-verification, missing-information)
    underwriting-analysis/ SKILL.md + references/ (dpl-eligibility-and-appetite, dpl-coverage-rules, dpl-specialty-programs, dpl-procedures-and-endorsements, dpl-rating-reference, specialty-risk-analysis, application-completeness, inconsistency-analysis, risk-indicators, follow-up-questions)
  tests/                 unit + end-to-end API tests (real Postgres, Claude/NPI mocked)
frontend/                React + TypeScript + Vite + MUI + TanStack Query
docker-compose.yml       PostgreSQL 16 on localhost:5435
```

## Quick start

```bash
cp .env.example .env                    # optional: Compose variables (DB_PORT, POSTGRES_PASSWORD); defaults work as is
docker compose up -d db                 # PostgreSQL on :5435

cd backend
cp env.example .env                     # then set JWT_SECRET, ENCRYPTION_KEY
npm install
npm run dev                             # http://localhost:3002 (migrations run automatically)

cd ../frontend
npm install
npm run dev                             # http://localhost:5174
```

Open http://localhost:5174. The first account you create becomes the ADMIN. Use
**New manual submission** in the inbox to test without Gmail.

## Gmail setup

1. In Google Cloud, enable the Gmail API and create an OAuth client (Web). Add the redirect URI
   `http://localhost:3002/api/gmail/oauth/callback`.
2. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `backend/.env`.
3. Settings → Connect Gmail. The scopes are `gmail.readonly` and `gmail.send`: the platform reads mail
   and sends the replies and forwards an underwriter writes, and never deletes or modifies mail. A mailbox
   connected before `gmail.send` was added must be reconnected before Reply/Forward work. The refresh token
   is stored AES-256-GCM encrypted.
4. **Polling:** Gmail is checked every 60 seconds by default. Admins change it in Settings → Monitoring →
   Gmail monitoring (0 = off, otherwise 10–3600 seconds); it applies without a restart.
   **Production:** create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` publish
   rights, create a push subscription to `https://<host>/api/gmail/push?token=<GMAIL_PUSH_TOKEN>`, and set
   `GMAIL_PUBSUB_TOPIC`. The server renews the 7-day watch automatically. Push only triggers a
   history fetch, so notification payloads are never trusted.

### Gmail via MCP (alternative to Google OAuth)

Set `GMAIL_ENABLE_VIA_MCP=true`, or simply leave `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` blank, and the
backend reads mail through a Gmail MCP server instead. Configure one of:

- `GMAIL_MCP_URL` (+ optional `GMAIL_MCP_TOKEN`, sent as a Bearer token) for a remote Streamable HTTP server, or
- `GMAIL_MCP_COMMAND` + `GMAIL_MCP_ARGS` for a local stdio server (e.g. `npx -y @gongrzhe/server-gmail-autoauth-mcp`).

`GMAIL_MCP_SEARCH_TOOL` / `GMAIL_MCP_READ_TOOL` / `GMAIL_MCP_SEND_TOOL` name the server's tools (defaults
`search_emails` / `read_email` / `send_email`). Over MCP, replies and forwards are sent without attachments.
Polling searches `in:inbox newer_than:2d`; push/watch is OAuth-only. Attachments are ingested only if the
server returns them as base64 in a JSON result. The connectors attached to Claude.ai / Claude Code
belong to your Claude session and cannot be called by this server.

## Google Drive storage

Attachments (Gmail and manual uploads) are stored in Google Drive; the server keeps no copy on disk. PostgreSQL keeps
metadata, extracted text and audit. Design: `docs/google-drive-storage-plan.md`.

The server uses Drive as one Google account through an OAuth **refresh token**, so files are owned by that account
and use its storage. No key file is stored.

1. In the Google Cloud project used for Gmail, enable the **Google Drive API**.
2. Get a refresh token with scope `https://www.googleapis.com/auth/drive` from the **same OAuth client** as
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (a token only works with the client that issued it). For example, in the
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground): ⚙ → _Use your own OAuth credentials_
   (the client must list `https://developers.google.com/oauthplayground` as a redirect URI), authorize the scope
   while signed in as the storage account, then _Exchange authorization code for tokens_.
   While the OAuth consent screen is in **Testing** status, Google expires refresh tokens after 7 days: use an
   **Internal** (Workspace) or published app for production.
3. Configure `backend/.env` (git-ignored; use a secret manager in production):

```
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
GOOGLE_REFRESH_TOKEN=<refresh token>
# GOOGLE_TOKEN_URI=https://oauth2.googleapis.com/token   # default
# GDRIVE_ROOT_FOLDER_NAME=Submission Review               # default
# GDRIVE_SHARED_DRIVE_ID=<shared drive id>               # only to store in a Shared Drive
```

The root folder is found by its name, so no folder ID is configured. The server looks for a folder named
`GDRIVE_ROOT_FOLDER_NAME` that this app tagged as its root, at the top of My Drive, or of the Shared Drive when
`GDRIVE_SHARED_DRIVE_ID` is set (the account then needs at least Content manager access). It uses that folder on every
restart, and creates it if there is none. If several match, the oldest is used. A folder made by hand with the same name
is ignored, so attachments cannot land in a folder nobody chose. Tags are private to `GOOGLE_CLIENT_ID`: after changing
the OAuth client the server no longer sees the folder and creates a new one. Keep external sharing off.

- **Do not rename or move the folder.** The server would no longer find it, would create a new one and record it on
  Monitoring. To change the name, rename the folder and update `GDRIVE_ROOT_FOLDER_NAME`, then restart.
- **Trashed, deleted or unreachable folder:** at the next status check or new submission the server switches to a
  folder with the configured name, creating one if needed, and records an error on Monitoring. Stored files stay in the
  old folder, so restore it from the trash within Google's 30 days. Restored, it is older than the replacement, so the
  server goes back to it on its next restart. Drive also reports lost access as "not found", so check sharing and
  `GOOGLE_REFRESH_TOKEN` if this error appears when nobody trashed the folder.
- **Environments sharing a Google account need different names**, for example `Submission Review (dev)`. The orphan
  sweep treats files in its folder that it does not recognise as leftovers, so with the same name one environment would
  trash the other's files. If it finds more than `GDRIVE_ORPHAN_SWEEP_MAX` (default 100) it trashes nothing and fails
  on Monitoring, each week until this is resolved. If they are real leftovers, raise the limit for one run.
- **Leftovers under an earlier root are not swept.** After a root is replaced, the sweep covers only the current
  folder's files, so a file left by a crash under the old folder stays there until someone removes it.
- **Moving from `GDRIVE_ROOT_FOLDER_ID`:** delete the old line from `.env`. The server creates its own folder for new
  files. Files already stored stay in the old folder and keep opening, so do not trash or delete that folder.

`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are also the Gmail OAuth client: once they are set, Gmail is read through
OAuth (Settings → Connect Gmail) unless `GMAIL_ENABLE_VIA_MCP=true`.

The system status menu shows Google Drive as unreachable (reason in the server log) until the token works and the
root folder is writable. A revoked or expired token is reported as "GOOGLE_REFRESH_TOKEN was revoked or has expired".

Attachments are always stored in Google Drive; there is no local-disk option, so the `GOOGLE_*` credentials are
required to start the server (tests fake Drive). Physician applications can contain PHI: confirm your Google Workspace BAA covers Drive.

**Nothing is missed:** Gmail message IDs go into a durable retry queue before the poll cursor moves, and a message
leaves the queue only once every attachment is in Drive. Failed messages retry with back-off (up to every 6 hours,
forever) and are flagged on Monitoring after `GMAIL_RETRY_ALERT_AFTER` attempts; admins can **Retry now**.
Attachments that cannot be stored (over `ATTACHMENT_MAX_BYTES`, shared as a Drive link, listed by MCP without
content) are shown on the submission as warnings. A daily reconciliation re-queues any recent Gmail message that was
neither ingested nor queued and flags attachment-count mismatches; a weekly sweep trashes Drive files with no
document row.

## Inbox: Submissions, Ignored, Duplicates

The inbox has three tabs. The submission's status decides the tab, and only the first is processed.

| Tab             | Status                                                        | Processed?                                 |
| --------------- | ------------------------------------------------------------- | ------------------------------------------ |
| **Submissions** | anything else (classified `SUBMISSION` or `REVIEW_REQUIRED`)  | Yes: extraction, NPI, Synthesis, Analysis  |
| **Ignored**     | `NOT_SUBMISSION` (stored under that name, labelled "Ignored") | No. Classification only.                   |
| **Duplicates**  | `DUPLICATE`                                                   | No. Not even classification, so no tokens. |

- A new email is on no tab until it has a verdict, so it never passes through Submissions on its way to Ignored. If it
  has none after 5 minutes (a restart drops queued jobs), it shows under Submissions.
- **Duplicates** are found at ingest by deterministic code (`services/duplicates.ts`), before classification,
  by comparing the email with submissions received in the last `DUPLICATE_LOOKBACK_DAYS` (default 90):
  same `Message-ID` (R1), identical normalized subject + body + attachments (R2), same attachments with
  ≥ `DUPLICATE_BODY_SIMILARITY` (default 0.85) similar text, a trivial body or a short note (R3), identical text
  before the sign-off under any subject, whatever the closing or signature (R7), or the earlier text plus a short note on a forward or under the same subject (R8).
  Resemblance without proof is held as **Possible** for a person: a few changed words under the same subject (R4),
  documents already received with different text (R5), a note on top under a new subject (R8), or the same
  content from a different sender. Each duplicate carries a sentence stating its evidence. Subjects drop
  `Re:`/`Fwd:` prefixes, replies drop their quoted history, forwards keep the forwarded text, a sign-off and the
  signature below it never make a body non-trivial, and small inline/signature images never count. **An email with any new attachment is never a
  duplicate.** A duplicate points at the original (never at another duplicate). Every case:
  `docs/inbox-ignore-duplicate-plan.md` §12.
- A certain repeat of an _ignored_ email goes to Ignored, not Duplicates, also when it arrived while the original
  was still being classified. An ignored email is never re-run through the pipeline; only a classification change does that.
- **Ignore** without asking Claude needs structural evidence (auto-reply/bulk/bounce headers, an automatic subject,
  an automated sender); keywords and Gmail's own category (Promotions, Social) alone go to Claude, and an email with
  submission documents or in a submission thread is never ignored unless Claude is ≥ 85% sure. Every reason quotes what
  it matched.
- Claude ignores an email only when it is **not related to underwriting**: no provider or practice, insurance request,
  underwriting data, documents (files that could not be stored count) or submission thread, or those are plainly about
  something else. Anything with a signal it cannot settle is `REVIEW_REQUIRED`. See the `email-classification` skill.
- Nothing duplicate-like is processed automatically. **Process anyway** (Duplicates tab, or "Not a duplicate"
  on the submission page) releases it into the full pipeline; **Process as submission** does the same for an
  ignored email. The submission page's **Change** dialog moves an email between Submission, Review required,
  Ignored and Duplicate of… . Every change is audited (`DUPLICATE_DETECTED`, `DUPLICATE_MARKED`, `DUPLICATE_CLEARED`).
- `DUPLICATE_DETECTION=false` turns detection off (fingerprints are still stored). The unread badge counts
  all three tabs.

## Claude usage

- The Anthropic API key and model are set by an admin in Settings → Claude API (model default `claude-sonnet-5-5`),
  with a Test connection button; the key is stored encrypted with `ENCRYPTION_KEY` and never shown again.
  Adaptive thinking, streaming, and Zod-validated structured outputs throughout.
- Every Claude call is skill-driven: prompts live in `backend/skills/<name>/SKILL.md` (plus companion
  `.md` files), never in code. Skills: `email-classification`, `field-extraction`, `synthesis`,
  `underwriting-analysis`, `workspace-chat`. Edit a skill file and the next call uses it — no rebuild.
- Skills use the standard SKILL.md format: `name` (matches the folder), `description`, and a
  `metadata:` map that may set `version:`, `effort:` and `model:`. Companion files live in `references/`. Model precedence:
  `ANTHROPIC_MODEL_<TASK>` env var → skill `model:` → the model in Settings → Claude API. Task env vars:
  `ANTHROPIC_MODEL_CLASSIFICATION`, `_EXTRACTION`, `_SYNTHESIS`, `_ANALYSIS`, `_CHAT`, `_COMPARISON`, `_QUOTE`.
  The model and skill version used are stored on each report and chat audit entry.
- Server-side refusal fallback (`fallbacks: "default"`) is enabled: if a safety classifier declines,
  the API retries on Anthropic's recommended fallback model.
- **Settings → Automation** sets each step to Auto or Manual: email classification, field extraction, NPI
  verification, Synthesis, Analysis and the automatic quote. Auto: the step runs by itself when a new email arrives.
  Manual: it waits for its button on the submission ("Re-run extraction + NPI", "Re-verify", "Generate"); a click
  always runs the step in full. With classification on Manual, Claude is not asked and emails the rules cannot decide
  go to Review required. A change applies from then on; nothing already processed is re-run. Until an admin saves,
  the three report steps follow `AUTO_REPORTS` and the others are Auto.
- Fully automatic by default (`AUTO_REPORTS=true`): every ingested email is classified, attachments stored
  and extracted, fields and coverage extracted, NPIs verified, then the Synthesis Report and the
  Underwriting Analysis are generated with no click. After the automatic Analysis, a first quote ("Automatic quote") is
  priced: the `auto-quote` skill (Claude Haiku, `claude-haiku-5-5`) picks the rate class per speciality from the
  engine's ranked options and fills a limit or hours the Analysis states; the rating engine does the pricing. It is
  skipped when the submission already has a quote for its current context version or no rate tables are imported.
  Reprocessing re-runs the
  whole chain as new report versions (the reports only when Synthesis is on Auto).
- **Settings → Connections** tests each service live, on demand (admins): database, Claude API, Gmail, Google
  Drive, NPI Registry and the IMS 2 server.
- **Settings → Limits & timeouts** (`GET`/`PUT /api/settings/limits`; anyone signed in reads, admins change):
  Claude output caps per task and the overall Claude response timeout, upload size and file count, rate workbook
  size, Gmail/Drive/NPI/connection-test timeouts, OCR pages and characters per document in reports. Unset values
  use the code defaults; `ATTACHMENT_MAX_BYTES`, `UPLOAD_MAX_TOTAL_MB` and `LLM_PROMPT_MAX_CHARS` are ceilings.
  A change applies at once, on every instance.
- Effort: `low` for classification, `medium` for field extraction and chat, `high` for Synthesis and Analysis.
- Email and attachment content is always framed as untrusted data (prompt-injection hardening).
- Without an API key in Settings the platform still runs: classification falls back to rules, NPIs
  are found by regex and verified, and report and chat endpoints return `503 LLM_UNAVAILABLE`.

## Versioning & audit

- **Context version** increments whenever the evidence snapshot hash changes (new documents,
  reprocessing, NPI re-verification, an underwriter's decision on a partial NPI match, classification override).
- **NPI decisions:** an underwriter can set a `PARTIAL_MATCH` to `MATCH` or `MISMATCH` with a reason. `status` holds the
  decision and `auto_status` the registry result. Re-verification keeps the decision while the differences are unchanged,
  and clears it (`NPI_OVERRIDE_CLEARED`) when they change.
- **Reports** are immutable rows numbered per submission and kind. Each records its skill version
  (semver + hash of all skill files), model, context version, and for Analysis the Synthesis it was based on.
- **Assessments** are versioned human decisions linked to the analysis and context they were made on.
- **Audit events** are append-only; a database trigger rejects any UPDATE or DELETE.

## IMS 2 hand-off

An accepted submission goes to IMS 2 through its Submission Intake queue (ims2finance `lib/modules/submission-intake`, `docs/submission-intake/INTEGRATION_PLAN.md`):
the reviewer sends the intake to IMS 2's queue, and an IMS 2 user creates the submission from it and links it, or rejects
it with a reason. IMS 2 never creates the record by itself and sends no notifications.

The queue is connected in **Settings → System → IMS 2 intake** by an administrator, not in the environment:

| Setting   | Value                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| Queue URL | IMS 2's queue API, e.g. `http://localhost:5700/api/submission-intake` (the IMS 2 app's port, not its database's) |
| Token     | The same secret as IMS 2's `SUBMISSION_INTAKE_TOKEN`; stored encrypted with `ENCRYPTION_KEY`, never shown again  |

Both are kept in `app_settings`, picked up by every instance without a restart, and audited as
`IMS2_QUEUE_SETTINGS_CHANGED`. Sending to IMS 2 is off until both are set. **Test connection** checks them before saving.
`IMS2_INTAKE_QUEUE_BASE` / `SUBMISSION_INTAKE_TOKEN` in `.env` are no longer read (a startup warning says so).

| Variable          | Value                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `IMS2_APP_URL`    | Optional: IMS 2's screens for "Open in IMS 2" links when IMS 2 returns a path (default: the queue URL without `/api/submission-intake`) |
| `IMS2_TIMEOUT_MS` | Optional: per-call timeout (default 20000)                                                                                              |

The **IMS 2 intake** card is at the bottom of the Assessment tab. An absolute status url from IMS 2 is used as is.

**Flow:** after an Accept assessment the card looks up the insured (NPI, email, name, license) and broker in IMS 2;
inactive insureds and brokers are shown but cannot be chosen. The broker may go by name only. Location and contact are
optional and go with an existing insured too. **Send to IMS 2 Intake** queues it (`intakeId` = submission id); a changed
intake updates the queued one (next version), an unchanged resend replays. A rejected intake shows the reason and is fixed
and resent (IMS 2 reopens it). Once linked, the card shows the IMS 2 submission, its workflow status and policy number.

**Sync:** Settings → System → **IMS 2 intake** shows the intakes by state and **Sync IMS status** (Submissions tab of the Submission Inbox) reads every status
change since the last sync (stored in `app_settings`), then refreshes queued and linked intakes. Each card also has
**Refresh status**. Results are kept in `ims2_intake_queue` and audited as `IMS2_QUEUE_SENT`, `IMS2_QUEUE_LINKED`,
`IMS2_QUEUE_REJECTED` or `IMS2_QUEUE_ERROR`.

The earlier direct hand-off (`IMS2_API_BASE` / `IMS2_INTAKE_TOKEN`, IMS 2's `/api/intake/drafts`) was removed; those
variables are ignored with a warning. Its table `ims2_handoffs` is kept for its history, and a submission it already
created in IMS 2 is never sent to the queue as well.

## Database migrations

`backend/src/db/migrations/*.sql` run in name order, each once, in its own transaction, recorded in
`schema_migrations`; data backfills (`db/backfills.ts`) run after them the same way. They run on every start
(`npm run dev` / `npm start`) or by hand with `npm run migrate`. A PostgreSQL advisory lock lets only one process
migrate at a time, so several instances can start together. **There are no down migrations**: migrations follow the
expand/contract policy so the previous release's image keeps working on the new schema, and rolling back is
redeploying that image (`RELEASE_SHA`, see [docs/deploy.md](docs/deploy.md) → Rollback). Restoring the dump taken
before the deploy (below) is the last resort, for a migration that damaged data.

**The database must be UTF8.** The docker-compose database is. A PostgreSQL cluster initialised on Windows defaults to
WIN1252, which cannot store characters found in emails and documents; the migrator refuses such a database with a
message. Create one with `CREATE DATABASE ims ENCODING 'UTF8' TEMPLATE template0` (or `initdb -E UTF8`). New migration
files must be plain ASCII (`scripts/check-migrations.mjs`).

`001_schema.sql` is the whole schema as one file. It replaced `001_init.sql` … `020_rating_quotes.sql` (and the
never-committed `021`–`024`, `002_minimize`, `002_drop_rate_group_files`, and later `002_rating_money`, `010_auth`,
`011_jobs`, `012_outbound`). On start the migrator handles every state a
database can be in:

| State                                                                                          | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Empty                                                                                          | `001_schema.sql` and every later file run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Migrated before the squash (any subset of the old files)                                       | Converged in **one transaction**: `001_schema.sql` is built in a scratch schema, every row is copied across (jsonb arrays → `text[]`, `emails.signals` → columns, report `usage` → token columns), foreign keys are re-checked, and the old tables are moved to schema **`legacy_pre_squash`** — nothing is dropped. Old `quotes` rows become `single_rating` versions (backfill `legacy_quotes`; a row that cannot be converted is logged and stays in `legacy_pre_squash.quotes`). Rate tables and ZIP data are re-imported on start from `data/rates` and Census/GeoNames. A database that already has the `001_schema.sql` shape is just recorded. |
| `001_schema.sql` recorded, nothing after it, but a different shape (an early copy of the file) | Converged the same way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Up to date                                                                                     | Pending files run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

After migrating, the live schema is compared with the migrations replayed in a scratch schema (tables, column types
and nullability, constraints, indexes). On any difference the server **refuses to start** and lists it; fix the drift
(or restore) rather than editing `schema_migrations`. A failed upgrade is rolled back and leaves the database as it
was. Once a converged database is verified, `DROP SCHEMA legacy_pre_squash CASCADE` reclaims the space (take a dump
first). Never edit a migration that has been applied anywhere: add the next numbered file.

## Backup & restore

Take a dump **before every deploy** (migrations change data and cannot be undone), and keep it until the deploy is
verified:

```bash
# custom format, compressed; includes schema_migrations so a restore is self-describing
pg_dump --format=custom --no-owner --file=ims-$(date +%Y%m%d-%H%M).dump "$DATABASE_URL"
# docker-compose database:
docker compose exec -T db pg_dump -U ims --format=custom ims > ims-$(date +%Y%m%d-%H%M).dump
```

Restore (rollback of a bad deploy): stop every API instance, redeploy the previous release, then restore into an empty
database and point `DATABASE_URL` at it (or recreate the original):

```bash
createdb --encoding=UTF8 --template=template0 ims_restored   # or: dropdb ims && createdb -E UTF8 -T template0 ims
pg_restore --no-owner --exit-on-error --dbname=ims_restored ims-YYYYMMDD-HHMM.dump
docker compose exec -T db pg_restore -U ims --no-owner --exit-on-error -d ims_restored < ims-YYYYMMDD-HHMM.dump
```

Test a backup regularly by restoring it into a scratch database and starting a staging instance on it (the
migrator verifies the schema on start), or at least `pg_restore --list` it and compare row counts
(`SELECT count(*) FROM submissions`, `single_rating`, `audit_events`). Attachments live in Google Drive, not in the dump: a restore of an older dump can reference files deleted since, and the Drive orphan
sweep must not run against a restored database until it matches Drive (see `GDRIVE_ORPHAN_SWEEP_MAX`).

## Tests

```bash
docker compose up -d db                 # the backend's DB-backed suites need Postgres
cd backend && npm test                  # or npm run test:coverage (thresholds enforced, report in coverage/)
cd frontend && npm test                 # or npm run test:coverage
cd e2e && npm ci && npx playwright install chromium && npm test   # browser smoke test (builds required, below)
```

**Backend database (`TEST_DATABASE_URL`).** The DB-backed suites (`api`, `auditErasure`, `authzMatrix`,
`autoReports`, `dbResilience`, `driveIngest`, `groundingApi`, `ims2Queue`, `injectionFlags`, `jobQueue`, `llmCost`,
`migrate`, `modules`, `rating`, `retention`, `retryFromFailedStep`, `reviewAuto`, `transcripts`) **drop and recreate
their own databases** (`ims_test`, `ims_test_<suite>`) on the server named by `TEST_DATABASE_URL` (default
`postgres://ims:ims_dev_password@localhost:5435/ims_test`, the docker-compose `db`). Only the host, port and
credentials are taken from it; each suite picks its own database name. Every other suite is DB-free.

- `tests/helpers/globalSetup.ts` runs first and **refuses** a `TEST_DATABASE_URL` whose database name does not contain
  `_test`, and **fails fast** with one message when the server is unreachable. To run only DB-free suites without
  Postgres: `TEST_DB_REQUIRED=false npx vitest run tests/unit.test.ts`.
- Never point it at a server holding data you care about. Two test runs on the same server at the same time collide
  (same database names): give each its own Postgres (`docker run -d -p 5499:5432 -e POSTGRES_USER=ims -e
POSTGRES_PASSWORD=ims_dev_password postgres:16-alpine` and `TEST_DATABASE_URL=postgres://ims:ims_dev_password@localhost:5499/ims_test`).
- External services are faked (Claude, NPI, Drive, Gmail at the googleapis boundary); the suites never call them.

**Coverage.** `npm run test:coverage` in either app writes `coverage/lcov.info` and `coverage/index.html` and fails
below the thresholds in `backend/vitest.config.ts` / `frontend/vite.config.ts`. Run it locally before merging.
Raise a threshold when coverage has gone up; never lower one to make a PR pass.

**Lint ratchet.** Keep the ESLint warning count from growing (`npm run lint` in each app): fixing warnings is
welcome, adding one is not.

**LLM evals** (`backend/evals`, not part of `npm test`: real, paid Claude calls). `npm run eval` scores the eval set
against `backend/evals/baseline.json`. **No baseline is committed yet**: someone with an Anthropic key must run
`cd backend && npm run eval -- --update-baseline` once on `main`, review the scores, and commit
`evals/baseline.json`. Then set the repository secret `ANTHROPIC_API_KEY` and the repository variable
`REQUIRE_EVALS=true`: from then on the CI `evals` job fails when a skill or prompt change regresses, when the key is
missing, or when the baseline is missing (`run.ts` exits 1 under `REQUIRE_EVALS=true`). Re-run with
`--update-baseline` and commit it together with any intended prompt or skill change.

**End-to-end (`e2e/`, Playwright).** A smoke test of the real SPA, API and database: the login page renders, the
seeded admin signs in, the inbox loads, a submission opens (when there is one) and the admin signs out. By default it
starts the built apps itself, so build them first:

```bash
(cd backend && npm run build) && (cd frontend && npm run build)
cd e2e && E2E_DATABASE_URL=postgres://ims:ims_dev_password@localhost:5435/ims_e2e_test npm test
```

The database must exist (`createdb`/`CREATE DATABASE ims_e2e_test`); the API migrates it, and the first run registers
the admin (`E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`, defaults in `e2e/tests/credentials.ts`). Against a running stack
(e.g. `docker-compose.prod.yml` on :8080) set `E2E_BASE_URL` instead, plus the admin credentials of that stack (in
production the first admin needs `SETUP_TOKEN`). CI runs it in the `e2e` job.

## Production notes

- LLM guardrails (injection, grounding, PII, cost, audit, human review, ...): see [docs/guardrails.md](docs/guardrails.md).
- Packaging, reverse proxy, health checks, least-privilege database roles, release, rollback and the expand/contract
  migration policy: see [docs/deploy.md](docs/deploy.md) (`backend/Dockerfile`, `frontend/Dockerfile` +
  `frontend/nginx.conf`, `docker-compose.prod.yml`, which deploys prebuilt images pinned by commit SHA).
  Netlify (SPA + API as Functions on one site): see [docs/deploy-netlify.md](docs/deploy-netlify.md).
- Operating it (Gmail disconnects, Claude credit, stuck queues, key loss, pool exhaustion): see
  [docs/runbook.md](docs/runbook.md).
- API reference: there is no OpenAPI/Swagger document yet and the API is unversioned (`/api` only; API-04). The Zod
  schemas next to each router (`backend/src/modules/*/*.schemas.ts` and the routes files) are the contract, and the
  only client is the SPA in this repository; generate an OpenAPI document from those schemas before exposing the API
  to any other consumer.
- The job queue (`services/jobQueue.ts`) is durable in Postgres and safe with several API instances: workers claim
  with leases and `FOR UPDATE SKIP LOCKED`, and a job whose worker died is taken over when its lease lapses.
- `GET /api/health` is liveness (no dependencies); `GET /api/ready` checks the database and that every migration
  is applied. Point the orchestrator's liveness and readiness probes at them respectively.
- Attachments are stored in Google Drive with SHA-256 integrity hashes; confirm the Drive account's
  encryption and retention meet your requirements.
- Put the API behind TLS. Set strong `JWT_SECRET` and `ENCRYPTION_KEY` values (production refuses weak or placeholder
  ones). Rotate `ENCRYPTION_KEY` with `ENCRYPTION_KEYS_PREVIOUS` ([docs/deploy.md](docs/deploy.md)) so Gmail and the
  Anthropic key survive it.
- `NODE_ENV=production` requires `DATABASE_URL`: the development default
  (`postgres://ims:ims_dev_password@localhost:5435/ims`) only applies outside production, and the server refuses to start
  without it. The docker-compose database listens on 127.0.0.1 only and takes its password from `POSTGRES_PASSWORD`
  (default `ims_dev_password`, for development); the password is set when the volume is first created, so changing it
  later means `ALTER USER ims PASSWORD ...` (or a new volume) as well.
- `TRUST_PROXY` sets Express `trust proxy`, which decides the client IP used by the per-IP rate limits
  (`API_RATE_LIMIT_PER_MIN`, `LOGIN_RATE_LIMIT_PER_15MIN`). Default `false`: the socket address is the client and
  `X-Forwarded-For` is ignored, which is right when browsers reach the API directly (or through the Vite dev proxy).
  Behind a reverse proxy or load balancer that terminates TLS, set it to the number of proxies in front of the API
  (`TRUST_PROXY=1` for one nginx/ALB; `docker-compose.prod.yml` defaults to `2` for the TLS edge plus its nginx), or to their addresses (`TRUST_PROXY=loopback,10.0.0.0/8`); otherwise every user
  shares the proxy's IP and its rate limit. `true` is refused, since any client could then forge its IP.
- Gmail OAuth: the sign-in is bound to the browser that started it by a short-lived `ims_gmail_oauth` cookie
  (httpOnly, SameSite=Lax, path of `GOOGLE_REDIRECT_URI`). The browser must call the API on the same host as
  `GOOGLE_REDIRECT_URI` (the port may differ), or the callback fails with `?gmail=error`.
