---
name: background-jobs
description: Use when working on asynchronous backend work — the submission pipeline (ingest → dedup → classify → extract → NPI verify → synthesis → analysis), the job queue and workers, retries with backoff, idempotent job handlers, per-stage status and progress, retry-from-failed-step, concurrency limits, scheduled/recurring tasks (Gmail polling, watch renewal, Drive orphan sweeps), outbox patterns for side effects, LISTEN/NOTIFY, crash recovery, or moving to a durable queue such as pg-boss. Use it whenever work shouldn't run inside an HTTP request.
---

# Background Jobs & the Pipeline

Anything slow, flaky or external (OCR, document parsing, LLM calls, Gmail/Drive/NPI, IMS submission) runs
as a **job**, not inside a request. Jobs must survive restarts, retry safely, report progress, and never
do the same side effect twice.

Related: `node-api` (202 endpoints), `database-postgres` (locking, LISTEN/NOTIFY), `llm-integration`,
`external-integrations`, `logging-monitoring`.

## Rules

- **Use the existing durable queue** (`services/jobQueue.ts` on the `jobs` table: kind + JSON payload,
  leases, backoff, `max_attempts`) rather than adding a second mechanism.
- **Durable by default.** Job state lives in Postgres (or a Postgres-backed queue like pg-boss), not only
  in memory. An in-process queue is acceptable only for a single instance *and* only if pending work is
  rebuilt from the database on startup. Running more than one API instance requires a durable queue.
- **Claim jobs atomically** (`FOR UPDATE SKIP LOCKED`, or the queue library), with a visibility
  timeout/heartbeat so a crashed worker's job is picked up again.
- **One queued and one running job per `dedupe_key`** (e.g. `pipeline:<submissionId>`), enforced by a
  partial unique index; a re-run requested mid-run waits behind the running one instead of running
  concurrently or being dropped.
- **Handlers are idempotent:** running a job twice produces the same end state. Use natural keys
  (`ON CONFLICT DO NOTHING` on Gmail message id), check-before-act on stage status, and deterministic ids
  for created rows.
- **Pipeline stages are explicit and persisted:** each submission records per-stage state (here the
  `submissions.pipeline_progress` jsonb; a stage table also works) with `pending | running | done | failed | skipped`, timestamps, attempt count,
  error code and safe message. The UI reads this for progress; "retry from failed step" restarts at that
  stage without redoing earlier ones.
- **Each stage is a pure-ish function of persisted inputs:** it reads what earlier stages stored and writes
  its own output. It doesn't depend on in-memory state from a previous stage, so it can rerun alone.
- **Retries use exponential backoff with jitter and a cap** (e.g. 3–5 attempts), and only for transient
  errors (timeouts, 429, 5xx, network). Validation errors, refusals and corrupt files fail immediately
  with a clear code. After the last attempt, the job goes to a failed/dead state that is visible and
  retryable by an admin, never silently dropped.
- **Side effects that must happen exactly once** (sending email, submitting to IMS, creating a Drive file)
  use an idempotency key recorded *before* the call and an outbox row written in the same transaction as
  the business change; a worker delivers the outbox and records the external id.
- **Bound concurrency** per job type (LLM, OCR, Drive) to respect rate limits and memory; one huge
  submission must not block all others (fair scheduling or per-submission limits).
- **Timeouts on every job step** and cancellation support (AbortSignal) for long LLM/OCR work.
- **Recurring tasks** (Gmail polling, watch renewal, orphan sweeps) run on a scheduler with a lock (an
  advisory lock or the queue's singleton feature) so two instances don't run them simultaneously; interval
  settings come from runtime settings and apply without restart.
- **Push notifications only trigger work.** A Gmail Pub/Sub push enqueues a history sync; the job fetches
  the truth from the source and never trusts the payload.
- **Observability:** every job logs with `{ jobId, type, submissionId, stage, attempt }`, emits duration
  and outcome, and queue depth/oldest-job age are visible on the monitoring page.
- **Graceful shutdown:** stop claiming new jobs, let the current step finish or release it, then exit.

## Patterns

```ts
// jobs/pipeline.ts: stage runner with persisted state and retry-from-failed
const STAGES = ['dedup', 'classify', 'extract', 'npi', 'synthesis', 'analysis'] as const satisfies readonly PipelineStage[];

export async function runPipeline(submissionId: string, deps: Deps, { fromStage }: { fromStage?: PipelineStage } = {}) {
  const startIndex = fromStage ? STAGES.indexOf(fromStage) : 0;
  for (const stage of STAGES.slice(startIndex)) {
    const state = await stageRepo.get(deps.db, submissionId, stage);
    if (state?.status === 'done') continue;                      // idempotent rerun
    await stageRepo.markRunning(deps.db, submissionId, stage);
    try {
      const outcome = await STAGE_HANDLERS[stage](submissionId, deps);
      await stageRepo.markDone(deps.db, submissionId, stage, outcome);
      if (outcome.halt) return;                                   // e.g. held for classification, duplicate
    } catch (error) {
      const failure = classifyFailure(error);                      // { code, message, retryable }
      await stageRepo.markFailed(deps.db, submissionId, stage, failure);
      if (failure.retryable) throw error;                          // the queue retries with backoff
      return;                                                      // permanent: visible, retryable by a user
    }
  }
}
```

```sql
-- Claiming work safely across workers (simplified from services/jobQueue.ts, which also keeps one
-- running job per dedupe_key). Also reclaims jobs whose worker died: their lease expired.
UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = $1,
  locked_until = now() + make_interval(secs => $2), updated_at = now()   -- workers renew the lease while running
WHERE id = (
  SELECT id FROM jobs
  WHERE (status = 'queued' AND run_after <= now())
     OR (status = 'running' AND locked_until < now())
  ORDER BY run_after, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, kind, dedupe_key, payload, attempts, max_attempts;
```

```ts
// Backoff with jitter
export const backoffMs = (attempt: number, baseMs = 2_000, capMs = 5 * 60_000) =>
  Math.min(capMs, baseMs * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
```

## Review checklist

- [ ] Slow/external work runs as a job; the API returns 202
- [ ] Job state is durable and recovered after restart
- [ ] Handlers are idempotent; exactly-once side effects use idempotency keys/outbox
- [ ] Stage status persisted with error codes; retry-from-failed works
- [ ] Retries only for transient errors, with backoff + jitter + cap; dead jobs are visible
- [ ] Concurrency bounded per job type; timeouts on every step
- [ ] Recurring tasks hold a lock; push notifications only trigger fetches
