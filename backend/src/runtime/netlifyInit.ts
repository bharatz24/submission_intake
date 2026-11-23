// Job handlers register themselves when their module loads: import every module that registers a kind, so a worker
// instance can run any job it claims (claim() only takes kinds with a handler).
import '../services/pipeline.js';
import '../services/reports.js';
import '../services/comparisons.js';
import '../services/rating/autoQuote.js';
import '../services/chat.js';
import '../services/emailDraft.js';

import { logger } from '../logger.js';
import { ensureAnthropicSettingsFresh, startAnthropicSettings } from '../services/anthropicSettings.js';
import { ensureIms2QueueSettingsFresh, startIms2QueueSettings } from '../services/ims2QueueSettings.js';
import { ensureLimitsSettingsFresh, startLimitsSettings } from '../services/limitsSettings.js';
import { ensureSkillOverridesFresh, refreshSkillOverrides, startSkillOverrideSync } from '../services/skillEditor.js';

let initialized: Promise<void> | null = null;

/**
 * RUNTIME=netlify: what server.ts does at startup, minus the timers, LISTEN and the job loop (functions have none).
 * Once per function instance; a failed attempt is retried by the next call. Migrations are a build step there.
 */
export function initNetlifyRuntime(): Promise<void> {
  initialized ??= (async () => {
    await refreshSkillOverrides();
    await startSkillOverrideSync();
    await startAnthropicSettings();
    await startIms2QueueSettings();
    await startLimitsSettings();
    logger.info('netlify runtime initialized');
  })().catch((err: unknown) => {
    initialized = null;
    throw err;
  });
  return initialized;
}

/**
 * RUNTIME=netlify: bring the settings other instances may have saved up to date before a request or worker task runs
 * (each is re-read only when older than SYNCED_SETTING_MAX_AGE_MS; no LISTEN/NOTIFY between function instances).
 */
export async function ensureAllSettingsFresh(): Promise<void> {
  await Promise.all([
    ensureAnthropicSettingsFresh(),
    ensureIms2QueueSettingsFresh(),
    ensureLimitsSettingsFresh(),
    ensureSkillOverridesFresh(),
  ]);
}
