import Anthropic from '@anthropic-ai/sdk';

import { isValidModelId } from '../config.js';
import { ANTHROPIC_SETTINGS_RESYNC_MS, DEFAULT_MODEL, SUGGESTED_MODELS } from '../constants.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { audit } from './audit.js';
import { decryptSecret, encrypt } from './crypto.js';
import { describeError } from './friendlyError.js';
import { limits } from './limitsSettings.js';
import { notify } from './pgListen.js';
import { createSyncedSetting } from './syncedSetting.js';
export { DEFAULT_MODEL, SUGGESTED_MODELS } from '../constants.js';

/**
 * The Anthropic API key and default model, set in Settings → Claude API instead of the environment. All live in
 * app_settings (the key AES-256-GCM encrypted with ENCRYPTION_KEY, never sent back to the browser) and are held in
 * memory so every Claude call reads them synchronously. A save NOTIFYs every instance; a periodic re-read covers a
 * missed NOTIFY. Per-task ANTHROPIC_MODEL_<TASK> env vars and a skill's `model:` still take precedence over the model.
 */

const KEY_SETTING = 'anthropic_api_key';
const MODEL_SETTING = 'anthropic_model';
const CHANNEL = 'anthropic_settings';

interface Current {
  apiKey: string | null;
  model: string;
  keyError: string | null;
}
let current: Current = { apiKey: null, model: DEFAULT_MODEL, keyError: null };

export const anthropicApiKey = () => current.apiKey;
export const anthropicModel = () => current.model;

/** Command-line tools only (`npm run eval`): use this key and model instead of Settings. The server never calls it. */
export function useAnthropicSettingsForScript(apiKey: string, model = DEFAULT_MODEL): void {
  current = { apiKey, model, keyError: null };
}

/** What Settings shows: never the key itself, only whether one is set and its last characters. */
export function anthropicSettingsView() {
  return {
    keySet: Boolean(current.apiKey),
    keyHint: current.apiKey ? `…${current.apiKey.slice(-4)}` : null,
    keyError: current.keyError,
    model: current.model,
    defaultModel: DEFAULT_MODEL,
    suggestedModels: SUGGESTED_MODELS,
  };
}

export async function refreshAnthropicSettings(): Promise<void> {
  const { rows } = await pool.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [
    [KEY_SETTING, MODEL_SETTING],
  ]);
  const value = (k: string) => rows.find((r) => r.key === k)?.value as string | undefined;
  let apiKey: string | null = null;
  let keyError: string | null = null;
  const stored = value(KEY_SETTING);
  if (stored) {
    try {
      const key = decryptSecret(stored);
      apiKey = key.value;
      // Under an old key or format (ENCRYPTION_KEY rotation): store it under the current key, unless it was replaced.
      if (key.stale) {
        await pool
          .query('UPDATE app_settings SET value=$2 WHERE key=$1 AND value=$3::jsonb', [
            KEY_SETTING,
            JSON.stringify(encrypt(key.value)),
            JSON.stringify(stored),
          ])
          .catch((rewriteErr) => logger.warn({ err: rewriteErr }, 'Anthropic API key re-encryption failed'));
      }
    } catch (err) {
      // ENCRYPTION_KEY changed since the key was saved: it cannot be read, so Claude is off until it is entered again.
      keyError =
        'The saved API key cannot be decrypted (ENCRYPTION_KEY changed without the old value in ENCRYPTION_KEYS_PREVIOUS). Enter it again.';
      logger.error({ err }, 'Anthropic API key could not be decrypted');
    }
  }
  current = { apiKey, model: value(MODEL_SETTING) ?? DEFAULT_MODEL, keyError };
}

/** Startup: load the saved values and keep them in sync with saves on any instance. */
const sync = createSyncedSetting({
  channel: CHANNEL,
  refresh: refreshAnthropicSettings,
  resyncMs: ANTHROPIC_SETTINGS_RESYNC_MS,
  name: 'Anthropic settings',
});
export const startAnthropicSettings = (): Promise<void> => sync.start();
export const stopAnthropicSettingsSync = (): void => sync.stop();
/** RUNTIME=netlify: re-read when older than SYNCED_SETTING_MAX_AGE_MS (no LISTEN there). */
export const ensureAnthropicSettingsFresh = (): Promise<void> => sync.ensureFresh();
/** RUNTIME=netlify: re-read now, for Settings to show what another instance just saved. Listen mode: no-op. */
export const reloadAnthropicSettings = (): Promise<void> => sync.ensureFresh({ maxAgeMs: 0 });

/** `apiKey`: a new key, null to remove it, undefined to keep the saved one. */
export async function saveAnthropicSettings(
  input: { apiKey?: string | null; model: string },
  actorId: string,
): Promise<void> {
  if (!isValidModelId(input.model)) throw new Error(`"${input.model}" is not an Anthropic model ID (claude-...)`);
  const upsert = `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`;
  const previousModel = current.model;
  await pool.query(upsert, [MODEL_SETTING, JSON.stringify(input.model), actorId]);
  if (input.apiKey) await pool.query(upsert, [KEY_SETTING, JSON.stringify(encrypt(input.apiKey)), actorId]);
  if (input.apiKey === null) await pool.query('DELETE FROM app_settings WHERE key=$1', [KEY_SETTING]);
  await refreshAnthropicSettings();
  await notify(CHANNEL).catch((err) =>
    logger.warn({ err }, 'Anthropic settings NOTIFY failed; other instances resync within minutes'),
  );
  await audit({
    action: 'ANTHROPIC_SETTINGS_CHANGED',
    entityType: 'app_setting',
    actorId,
    details: {
      model: input.model,
      previousModel,
      key: input.apiKey ? 'replaced' : input.apiKey === null ? 'removed' : 'unchanged',
    },
  });
}

/**
 * Checks a key and model against the API without spending tokens (model metadata). Falls back to the saved key and
 * model for whatever is not given, so the form can test before saving.
 */
export async function testAnthropicSettings(input: {
  apiKey?: string;
  model?: string;
}): Promise<{ ok: boolean; model: string; detail: string }> {
  const apiKey = input.apiKey || current.apiKey;
  const model = input.model || current.model;
  if (!apiKey) return { ok: false, model, detail: 'No API key entered or saved' };
  if (!isValidModelId(model))
    return { ok: false, model, detail: `"${model}" is not an Anthropic model ID (claude-...)` };
  try {
    const info = await new Anthropic({ apiKey }).models.retrieve(
      model,
      {},
      { timeout: limits().connectionTestTimeoutSeconds * 1000, maxRetries: 0 },
    );
    return { ok: true, model, detail: `Connected · ${info.display_name ?? model}` };
  } catch (err) {
    if (err instanceof Anthropic.NotFoundError)
      return { ok: false, model, detail: `The key works, but model ${model} is not available to it` };
    return { ok: false, model, detail: describeError(err).message };
  }
}
