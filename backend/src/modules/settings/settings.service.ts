import { AppError } from '../../http.js';
import { logger } from '../../logger.js';
import {
  anthropicSettingsView,
  reloadAnthropicSettings,
  saveAnthropicSettings,
  testAnthropicSettings,
} from '../../services/anthropicSettings.js';
import {
  AUTOMATION_STEPS,
  automationSettings,
  type AutomationStep,
  saveAutomationSettings,
} from '../../services/appSettings.js';
import { audit } from '../../services/audit.js';
import { queueProbe } from '../../services/ims2IntakeQueue.js';
import {
  ims2QueueBase,
  ims2QueueSettingsView,
  ims2QueueToken,
  saveIms2QueueSettings,
} from '../../services/ims2QueueSettings.js';
import {
  type LimitKey,
  limitsSettingsView,
  LimitsValidationError,
  reloadLimitsSettings,
  saveLimitsSettings,
} from '../../services/limitsSettings.js';
import {
  type RetentionKey,
  retentionSettingsView,
  RetentionValidationError,
  saveRetentionSettings,
} from '../../services/retentionSettings.js';
import {
  connectionList,
  invalidateSystemStatus,
  systemStatus,
  type TestableService,
  testConnection,
} from '../../services/systemStatus.js';

/**
 * Admin-tunable runtime settings (environment-config skill): stored in the database by the services under
 * services/*Settings.ts, which also keep every instance's copy in sync. This layer adds the audit trail and maps the
 * services' own refusals to API errors.
 */
export function createSettingsService() {
  return {
    /** Re-read first (RUNTIME=netlify): this instance may not have seen a save made on another one. */
    async anthropic() {
      await reloadAnthropicSettings();
      return anthropicSettingsView();
    },

    async saveAnthropic(body: { model: string; apiKey?: string | null }, actorId: string) {
      await saveAnthropicSettings(body, actorId);
      // The cached LLM status was checked with the old key/model: the next status check runs live.
      invalidateSystemStatus();
      return anthropicSettingsView();
    },

    testAnthropic: (body: { model?: string; apiKey?: string }) => testAnthropicSettings(body),

    ims2Queue: () => ims2QueueSettingsView(),

    async saveIms2Queue(
      body: { baseUrl: string | null; token?: string | null; imsUrl?: string | null },
      actorId: string,
    ) {
      await saveIms2QueueSettings(body, actorId);
      return ims2QueueSettingsView();
    },

    /** A live lookup with the given URL and token, or the saved ones for whatever is omitted. Never throws. */
    async testIms2Queue(body: { baseUrl?: string; token?: string }): Promise<{ ok: boolean; detail: string }> {
      const baseUrl = body.baseUrl || ims2QueueBase();
      const token = body.token || ims2QueueToken();
      if (!baseUrl) return { ok: false, detail: 'No queue URL entered or saved' };
      if (!token) return { ok: false, detail: 'No token entered or saved' };
      try {
        return { ok: true, detail: await queueProbe({ baseUrl, token }) };
      } catch (err) {
        // An admin asked for the test: show the underlying reason (IMS 2's own message, never the token), trimmed.
        logger.warn({ err }, 'IMS 2 intake queue test failed');
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: msg.replace(/\s+/g, ' ').slice(0, 300) || 'Failed' };
      }
    },

    systemStatus: () => systemStatus(),

    automation: () => automationSettings(),

    /** Audited step by step: only the steps whose mode changed. */
    async saveAutomation(body: Partial<Record<AutomationStep, 'AUTO' | 'MANUAL'>>, actorId: string) {
      const { previous, next } = await saveAutomationSettings(body, actorId);
      const changed = AUTOMATION_STEPS.filter((k) => previous[k] !== next[k]);
      if (changed.length) {
        await audit({
          action: 'AUTOMATION_SETTINGS_CHANGED',
          entityType: 'app_setting',
          actorId,
          details: Object.fromEntries(changed.map((k) => [k, { from: previous[k], to: next[k] }])),
        });
      }
      return next;
    },

    async limits() {
      await reloadLimitsSettings();
      return limitsSettingsView();
    },

    async saveLimits(body: Partial<Record<LimitKey, number | null>>, actorId: string) {
      try {
        await saveLimitsSettings(body, actorId);
      } catch (err) {
        // A key or value the service refuses is a 400 like the schema's own errors.
        if (err instanceof LimitsValidationError) {
          throw new AppError('VALIDATION_ERROR', 400, err.message, {
            formErrors: [],
            fieldErrors: { [err.field]: [err.message] },
          });
        }
        throw err;
      }
      return limitsSettingsView();
    },

    retention: () => retentionSettingsView(),

    /** Audited by the settings service with the periods that changed. */
    async saveRetention(body: Partial<Record<RetentionKey, number | null>>, actorId: string) {
      try {
        return await saveRetentionSettings(body, actorId);
      } catch (err) {
        if (err instanceof RetentionValidationError) {
          throw new AppError('VALIDATION_ERROR', 400, err.message, {
            formErrors: [],
            fieldErrors: { [err.field]: [err.message] },
          });
        }
        throw err;
      }
    },

    async connections() {
      await reloadAnthropicSettings(); // whether Claude counts as configured depends on the saved key
      return connectionList();
    },

    testConnection: (service: TestableService) => testConnection(service),
  };
}
