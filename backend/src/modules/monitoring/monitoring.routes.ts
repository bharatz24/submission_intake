import { Router } from 'express';
import { z } from 'zod';

import { gmailSource } from '../../config.js';
import type { AppDeps } from '../../deps.js';
import { currentUser, notFound, parseBody, requirePermission } from '../../http.js';
import { audit } from '../../services/audit.js';
import { mcpState } from '../../services/gmailMcp.js';
import { queueStats } from '../../services/ingestQueue.js';
import { jobs } from '../../services/jobQueue.js';
import {
  rangeStart,
  USAGE_RANGES,
  USAGE_SORT,
  type UsageRange,
  usageReport,
  type UsageSort,
} from '../../services/llmUsage.js';
import { pageQuery } from '../shared/schemas.js';
import * as repo from './monitoring.repository.js';

const Range = z.enum(Object.keys(USAGE_RANGES) as [UsageRange]).default('today');
const StatsQuery = z.object({ range: Range, tz: z.string().max(64).optional() });
const UsageQuery = z.object({
  range: Range,
  tz: z.string().max(64).optional(),
  ...pageQuery(25, 200).shape,
  sort: z.enum(Object.keys(USAGE_SORT) as [UsageSort]).default('at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Pipeline health and LLM usage. They show raw errors, applicant names and email recipients: admins only. Mounted
 * behind requireAuth (app.ts).
 */
export function monitoringRouter({ db }: AppDeps): Router {
  const router = Router();

  /** Counts cover `range` (same periods as token usage); queue depth, the ingest queue and the last poll are live. */
  router.get('/monitoring/stats', requirePermission('monitoring:view'), async (req, res) => {
    const { range, tz } = parseBody(StatsQuery, req.query);
    const [{ oauthLastPollAt, ...counts }, ingestQueue, queueDepth] = await Promise.all([
      repo.pipelineCounts(db, await rangeStart(range, tz)),
      queueStats(),
      jobs.depth(),
    ]);
    const { recentErrors, ...totals } = counts;
    res.json({
      range,
      ...totals,
      queueDepth,
      ingestQueue,
      lastPollAt: gmailSource === 'MCP' ? mcpState.lastPollAt : oauthLastPollAt,
      recentErrors,
    });
  });

  router.post('/monitoring/errors/clear', requirePermission('monitoring:manage'), async (req, res) => {
    const cleared = await repo.clearErrors(db, currentUser(req).id);
    if (cleared)
      await audit({
        action: 'SYSTEM_ERRORS_CLEARED',
        entityType: 'system_error',
        actorId: currentUser(req).id,
        details: { cleared },
      });
    res.json({ cleared });
  });

  router.get('/monitoring/llm-usage', requirePermission('monitoring:view'), async (req, res) => {
    res.json(await usageReport(parseBody(UsageQuery, req.query)));
  });

  /**
   * What one Claude call sent and received (llm_transcripts): hashes always, the redacted prompt and raw output when
   * LLM_STORE_TRANSCRIPTS kept them. Holds submission content, so it needs monitoring:manage and every view is audited.
   */
  router.get('/monitoring/llm-calls/:id/transcript', requirePermission('monitoring:manage'), async (req, res) => {
    const id = String(req.params.id);
    // llm_calls.id is a bigint: anything else is no call (and never reaches the query as a cast error).
    if (!/^\d{1,18}$/.test(id)) throw notFound('Transcript');
    const transcript = await repo.llmTranscript(db, id);
    if (!transcript) throw notFound('Transcript');
    const { submissionId, ...body } = transcript;
    await audit({
      action: 'LLM_TRANSCRIPT_VIEWED',
      entityType: 'llm_call',
      entityId: id,
      submissionId,
      actorId: currentUser(req).id,
      details: { task: body.task, stored: body.prompt !== null },
    });
    res.json(body);
  });

  return router;
}
