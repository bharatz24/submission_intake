import { IMS2_QUEUE_SETTINGS_RESYNC_MS } from '../constants.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { audit } from './audit.js';
import { decryptSecret, encrypt } from './crypto.js';
import { notify } from './pgListen.js';
import { createSyncedSetting } from './syncedSetting.js';

/**
 * The IMS 2 Submission Intake queue URL and its bearer token (IMS 2's SUBMISSION_INTAKE_TOKEN), set in Settings → IMS 2
 * intake instead of the environment. Both live in app_settings (the token AES-256-GCM encrypted with ENCRYPTION_KEY,
 * never sent back to the browser) and are held in memory so every queue call reads them synchronously. A save NOTIFYs
 * every instance; a periodic re-read covers a missed NOTIFY. Sending to IMS 2 is off until both are set.
 * The same section keeps the IMS URL: the application or website the top bar's IMS button opens in a new tab.
 */

const BASE_SETTING = 'ims2_intake_queue_base';
const TOKEN_SETTING = 'submission_intake_token';
const IMS_URL_SETTING = 'ims_redirect_url';
const CHANNEL = 'ims2_queue_settings';

interface Current {
  baseUrl: string | null;
  token: string | null;
  tokenError: string | null;
  imsUrl: string | null;
}
let current: Current = { baseUrl: null, token: null, tokenError: null, imsUrl: null };

export const ims2QueueBase = () => current.baseUrl;
export const ims2QueueToken = () => current.token;

/** What Settings shows: the URL, and for the token only whether one is set and its last characters. */
export function ims2QueueSettingsView() {
  return {
    baseUrl: current.baseUrl,
    tokenSet: Boolean(current.token),
    tokenHint: current.token ? `…${current.token.slice(-4)}` : null,
    tokenError: current.tokenError,
    configured: Boolean(current.baseUrl && current.token),
    imsUrl: current.imsUrl,
  };
}

export async function refreshIms2QueueSettings(): Promise<void> {
  const { rows } = await pool.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [
    [BASE_SETTING, TOKEN_SETTING, IMS_URL_SETTING],
  ]);
  const value = (k: string) => rows.find((r) => r.key === k)?.value as string | undefined;
  let token: string | null = null;
  let tokenError: string | null = null;
  const stored = value(TOKEN_SETTING);
  if (stored) {
    try {
      const t = decryptSecret(stored);
      token = t.value;
      // Under an old key or format (ENCRYPTION_KEY rotation): store it under the current key, unless it was replaced.
      if (t.stale) {
        await pool
          .query('UPDATE app_settings SET value=$2 WHERE key=$1 AND value=$3::jsonb', [
            TOKEN_SETTING,
            JSON.stringify(encrypt(t.value)),
            JSON.stringify(stored),
          ])
          .catch((rewriteErr) => logger.warn({ err: rewriteErr }, 'IMS 2 intake token re-encryption failed'));
      }
    } catch (err) {
      tokenError =
        'The saved IMS 2 intake token cannot be decrypted (ENCRYPTION_KEY changed without the old value in ENCRYPTION_KEYS_PREVIOUS). Enter it again.';
      logger.error({ err }, 'IMS 2 intake token could not be decrypted');
    }
  }
  current = { baseUrl: value(BASE_SETTING) ?? null, token, tokenError, imsUrl: value(IMS_URL_SETTING) ?? null };
}

/** Startup: load the saved values and keep them in sync with saves on any instance. */
const sync = createSyncedSetting({
  channel: CHANNEL,
  refresh: refreshIms2QueueSettings,
  resyncMs: IMS2_QUEUE_SETTINGS_RESYNC_MS,
  name: 'IMS 2 intake queue settings',
});
export const startIms2QueueSettings = (): Promise<void> => sync.start();
export const stopIms2QueueSettingsSync = (): void => sync.stop();
/** RUNTIME=netlify: re-read when older than SYNCED_SETTING_MAX_AGE_MS (no LISTEN there). */
export const ensureIms2QueueSettingsFresh = (): Promise<void> => sync.ensureFresh();

/**
 * `baseUrl`: the queue URL, null to remove it. `token`: a new token, null to remove it, undefined to keep the saved one.
 * `imsUrl`: the IMS button's target, null to remove it, undefined to keep the saved one.
 * Validated by the route (settings.routes.ts).
 */
export async function saveIms2QueueSettings(
  input: { baseUrl: string | null; token?: string | null; imsUrl?: string | null },
  actorId: string,
): Promise<void> {
  const upsert = `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`;
  const previousBaseUrl = current.baseUrl;
  const previousImsUrl = current.imsUrl;
  if (input.baseUrl) await pool.query(upsert, [BASE_SETTING, JSON.stringify(input.baseUrl), actorId]);
  else await pool.query('DELETE FROM app_settings WHERE key=$1', [BASE_SETTING]);
  if (input.token) await pool.query(upsert, [TOKEN_SETTING, JSON.stringify(encrypt(input.token)), actorId]);
  if (input.token === null) await pool.query('DELETE FROM app_settings WHERE key=$1', [TOKEN_SETTING]);
  if (input.imsUrl) await pool.query(upsert, [IMS_URL_SETTING, JSON.stringify(input.imsUrl), actorId]);
  if (input.imsUrl === null) await pool.query('DELETE FROM app_settings WHERE key=$1', [IMS_URL_SETTING]);
  await refreshIms2QueueSettings();
  await notify(CHANNEL).catch((err) =>
    logger.warn({ err }, 'IMS 2 intake queue settings NOTIFY failed; other instances resync within minutes'),
  );
  await audit({
    action: 'IMS2_QUEUE_SETTINGS_CHANGED',
    entityType: 'app_setting',
    actorId,
    details: {
      baseUrl: input.baseUrl,
      previousBaseUrl,
      token: input.token ? 'replaced' : input.token === null ? 'removed' : 'unchanged',
      ...(input.imsUrl !== undefined && { imsUrl: input.imsUrl, previousImsUrl }),
    },
  });
}
