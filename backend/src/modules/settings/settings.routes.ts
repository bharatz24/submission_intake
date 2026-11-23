import { Router } from 'express';
import { z } from 'zod';

import { isValidModelId } from '../../config.js';
import type { AppDeps } from '../../deps.js';
import { can, currentUser, notFound, parseBody, requirePermission } from '../../http.js';
import { AUTOMATION_STEPS, type AutomationStep } from '../../services/appSettings.js';
import { LIMIT_BOUNDS, LIMIT_KEYS, type LimitKey } from '../../services/limitsSettings.js';
import { RETENTION_BOUNDS, RETENTION_KEYS, type RetentionKey } from '../../services/retentionSettings.js';
import { TESTABLE_SERVICES, type TestableService } from '../../services/systemStatus.js';
import { createSettingsService } from './settings.service.js';

const anthropicKey = z.string().trim().min(20, 'That does not look like an Anthropic API key').max(400);
const anthropicModelId = z.string().trim().refine(isValidModelId, 'Use an Anthropic model ID such as claude-opus-5-5');
/** `apiKey`: a new key, null to remove the saved one, omitted to keep it. */
const AnthropicBody = z.object({ model: anthropicModelId, apiKey: anthropicKey.nullable().optional() });
const AnthropicTestBody = z.object({ model: anthropicModelId.optional(), apiKey: anthropicKey.optional() });

const ims2QueueBaseUrl = z
  .url({ protocol: /^https?$/, error: "Use the http(s) URL of IMS 2's /api/submission-intake" })
  .max(500);
const ims2QueueToken = z.string().trim().min(16, 'The token must be at least 16 characters').max(400);
/** Where the top bar's IMS button goes: any http(s) application or website. */
const imsUrl = z.url({ protocol: /^https?$/, error: 'Use an http(s) URL for the IMS button' }).max(500);
/**
 * `baseUrl`: null removes it. `token`: a new token, null to remove the saved one, omitted to keep it.
 * `imsUrl`: null removes it, omitted keeps it.
 */
const Ims2QueueBody = z.object({
  baseUrl: ims2QueueBaseUrl.nullable(),
  token: ims2QueueToken.nullable().optional(),
  imsUrl: imsUrl.nullable().optional(),
});
/** Whatever is omitted comes from the saved settings. */
const Ims2QueueTestBody = z.object({ baseUrl: ims2QueueBaseUrl.optional(), token: ims2QueueToken.optional() });

const automationMode = z.enum(['AUTO', 'MANUAL']);
const AutomationBody = z
  .object(
    Object.fromEntries(AUTOMATION_STEPS.map((k) => [k, automationMode.optional()])) as Record<
      AutomationStep,
      z.ZodOptional<typeof automationMode>
    >,
  )
  .strict()
  .refine((b) => Object.values(b).some(Boolean), 'Nothing to change');

/** A number sets a value, null resets it to the default, a key left out is kept; unknown keys are refused. */
const LimitsBody = z
  .object(
    Object.fromEntries(
      LIMIT_KEYS.map((k) => [
        k,
        z.number().int().min(LIMIT_BOUNDS[k].min).max(LIMIT_BOUNDS[k].max).nullable().optional(),
      ]),
    ) as Record<LimitKey, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>,
  )
  .strict();

/** Days to keep each kind of data: a number sets it, null keeps it forever, a key left out is kept as saved. */
const RetentionBody = z
  .object(
    Object.fromEntries(
      RETENTION_KEYS.map((k) => [
        k,
        z
          .number()
          .int('Use a whole number of days')
          .min(RETENTION_BOUNDS.min, `Minimum ${RETENTION_BOUNDS.min} days`)
          .max(RETENTION_BOUNDS.max, `Maximum ${RETENTION_BOUNDS.max} days`)
          .nullable()
          .optional(),
      ]),
    ) as Record<RetentionKey, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>,
  )
  .strict();

/**
 * Settings → Claude API, IMS 2 intake queue, Automation, Limits & timeouts, Retention, Connections, and the header's
 * system status. Any signed-in user reads them; only settings managers change them. Mounted behind requireAuth (app.ts).
 */
export function settingsRouter(_deps: AppDeps): Router {
  const router = Router();
  const service = createSettingsService();

  /**
   * The key itself is never returned, only whether one is set, and its last characters to settings managers (who use
   * them to tell keys apart); other roles get no hint (SEC-10).
   */
  router.get('/settings/anthropic', async (req, res) => {
    const view = await service.anthropic();
    res.json(can(req, 'settings:manage') ? view : { ...view, keyHint: null });
  });

  router.put('/settings/anthropic', requirePermission('settings:manage'), async (req, res) => {
    res.json(await service.saveAnthropic(parseBody(AnthropicBody, req.body), currentUser(req).id));
  });

  /** Checks a key and model before (or after) saving; whatever is omitted comes from the saved settings. */
  router.post('/settings/anthropic/test', requirePermission('settings:manage'), async (req, res) => {
    res.json(await service.testAnthropic(parseBody(AnthropicTestBody, req.body)));
  });

  /**
   * The IMS 2 intake queue URL and token, and the IMS button URL. Any signed-in user may read them (the top bar's IMS
   * button needs its URL). The token is never returned; only settings managers get its hint.
   */
  router.get('/settings/ims2-queue', (req, res) => {
    const view = service.ims2Queue();
    res.json(can(req, 'settings:manage') ? view : { ...view, tokenHint: null });
  });

  router.put('/settings/ims2-queue', requirePermission('settings:manage'), async (req, res) => {
    res.json(await service.saveIms2Queue(parseBody(Ims2QueueBody, req.body), currentUser(req).id));
  });

  /** Checks a URL and token against IMS 2 before (or after) saving. */
  router.post('/settings/ims2-queue/test', requirePermission('settings:manage'), async (req, res) => {
    res.json(await service.testIms2Queue(parseBody(Ims2QueueTestBody, req.body)));
  });

  router.get('/system/status', async (_req, res) => res.json(await service.systemStatus()));

  /** Whether each pipeline step runs on its own (AUTO) or waits for a person (MANUAL). */
  router.get('/settings/automation', async (_req, res) => res.json(await service.automation()));

  router.put('/settings/automation', requirePermission('settings:manage'), async (req, res) => {
    res.json(await service.saveAutomation(parseBody(AutomationBody, req.body), currentUser(req).id));
  });

  /** Any signed-in user may read them (the upload screens show the size limits). */
  router.get('/settings/limits', async (_req, res) => res.json(await service.limits()));

  router.put('/settings/limits', requirePermission('settings:manage'), async (req, res) => {
    res.json(await service.saveLimits(parseBody(LimitsBody, req.body), currentUser(req).id));
  });

  /** Settings → Retention: how long transcripts, LLM call rows, chat and deleted submissions are kept. */
  router.get('/settings/retention', async (_req, res) => res.json(await service.retention()));

  router.put('/settings/retention', requirePermission('settings:manage'), async (req, res) => {
    res.json(await service.saveRetention(parseBody(RetentionBody, req.body), currentUser(req).id));
  });

  /** The services that can be tested, and whether each is configured. */
  router.get('/settings/connections', async (_req, res) => res.json(await service.connections()));

  /** Runs one live connection test now (not the cached header status). */
  router.post('/settings/connections/:service/test', requirePermission('settings:manage'), async (req, res) => {
    const name = String(req.params.service);
    if (!(TESTABLE_SERVICES as readonly string[]).includes(name)) throw notFound('Service');
    res.json(await service.testConnection(name as TestableService));
  });

  return router;
}
