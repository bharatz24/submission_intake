import { config } from '../config.js';
import {
  CLASSIFICATION_BODY_CHARS,
  CLAUDE_RESPONSE_TIMEOUT_MS,
  CONNECTION_TEST_TIMEOUT_MS,
  DRIVE_REQUEST_TIMEOUT_MS,
  EXTRACTION_PER_SOURCE_CHARS,
  GMAIL_REQUEST_TIMEOUT_MS,
  LIMITS_SETTINGS_RESYNC_MS,
  LLM_MAX_TOKENS,
  MAX_ATTACHMENT_BYTES,
  NPI_TIMEOUT_MS,
  PDF_OCR_PAGES,
  RATE_WORKBOOK_MAX_BYTES,
  REPORT_MAX_TOKENS,
  REPORT_PER_DOC_CHARS,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILES,
} from '../constants.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { audit } from './audit.js';
import { notify } from './pgListen.js';
import { createSyncedSetting } from './syncedSetting.js';

/**
 * Settings → Limits & timeouts: output caps of the Claude calls, upload sizes, request timeouts, OCR pages, the
 * per-document report and extraction budgets and the email text read for classification. The constants are the defaults; app_settings holds only what an admin overrode, as one
 * JSON object. Held in memory so every caller reads limits() synchronously (defaults until loaded, e.g. unit tests).
 * A save NOTIFYs every instance; a periodic re-read covers a missed NOTIFY. Env settings (ATTACHMENT_MAX_BYTES,
 * UPLOAD_MAX_TOTAL_MB, LLM_PROMPT_MAX_CHARS) are ceilings no saved value can exceed.
 */

const SETTING = 'limits_settings';
const CHANNEL = 'limits_settings';
const MiB = 1024 * 1024;

const uploadMaxFileMbCeiling = Math.max(
  1,
  Math.floor(Math.min(config.ATTACHMENT_MAX_BYTES / MiB, config.UPLOAD_MAX_TOTAL_MB)),
);

/** Code default and allowed range of each value; a default above an env ceiling is clamped to it. */
const FIELDS = {
  synthesisMaxTokens: { default: REPORT_MAX_TOKENS.default, min: REPORT_MAX_TOKENS.min, max: REPORT_MAX_TOKENS.max },
  analysisMaxTokens: { default: REPORT_MAX_TOKENS.default, min: REPORT_MAX_TOKENS.min, max: REPORT_MAX_TOKENS.max },
  comparisonMaxTokens: { default: REPORT_MAX_TOKENS.default, min: REPORT_MAX_TOKENS.min, max: REPORT_MAX_TOKENS.max },
  classificationMaxTokens: { default: LLM_MAX_TOKENS.classification, min: 1000, max: 64_000 },
  extractionMaxTokens: { default: LLM_MAX_TOKENS.extraction, min: 8000, max: 64_000 },
  chatMaxTokens: { default: LLM_MAX_TOKENS.chat, min: 4000, max: 64_000 },
  emailDraftMaxTokens: { default: LLM_MAX_TOKENS.emailDraft, min: 4000, max: 64_000 },
  autoQuoteMaxTokens: { default: LLM_MAX_TOKENS.autoQuote, min: 4000, max: 64_000 },
  claudeResponseTimeoutMinutes: { default: CLAUDE_RESPONSE_TIMEOUT_MS / 60_000, min: 5, max: 60 },
  uploadMaxFileMb: { default: UPLOAD_MAX_FILE_BYTES / MiB, min: 1, max: uploadMaxFileMbCeiling },
  uploadMaxFiles: { default: UPLOAD_MAX_FILES, min: 1, max: 50 },
  rateWorkbookMaxMb: { default: RATE_WORKBOOK_MAX_BYTES / MiB, min: 1, max: 50 },
  npiTimeoutSeconds: { default: NPI_TIMEOUT_MS / 1000, min: 5, max: 60 },
  driveTimeoutSeconds: { default: DRIVE_REQUEST_TIMEOUT_MS / 1000, min: 30, max: 600 },
  gmailTimeoutSeconds: { default: GMAIL_REQUEST_TIMEOUT_MS / 1000, min: 10, max: 300 },
  connectionTestTimeoutSeconds: { default: CONNECTION_TEST_TIMEOUT_MS / 1000, min: 10, max: 120 },
  ocrMaxPages: { default: PDF_OCR_PAGES, min: 1, max: 50 },
  reportPerDocChars: { default: REPORT_PER_DOC_CHARS, min: 10_000, max: config.LLM_PROMPT_MAX_CHARS },
  extractionPerDocChars: { default: EXTRACTION_PER_SOURCE_CHARS, min: 10_000, max: config.LLM_PROMPT_MAX_CHARS },
  classificationBodyChars: { default: CLASSIFICATION_BODY_CHARS, min: 1000, max: 50_000 },
} as const;

export type LimitKey = keyof typeof FIELDS;
export type Limits = Record<LimitKey, number>;
export const LIMIT_KEYS = Object.keys(FIELDS) as LimitKey[];

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
export const LIMIT_DEFAULTS = Object.fromEntries(
  LIMIT_KEYS.map((k) => [k, clamp(FIELDS[k].default, FIELDS[k].min, FIELDS[k].max)]),
) as Limits;
export const LIMIT_BOUNDS = Object.fromEntries(
  LIMIT_KEYS.map((k) => [k, { min: FIELDS[k].min, max: FIELDS[k].max }]),
) as Record<LimitKey, { min: number; max: number }>;

export const validLimit = (key: LimitKey, n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= FIELDS[key].min && (n as number) <= FIELDS[key].max;

interface Current {
  overrides: Partial<Limits>;
  values: Limits;
  updatedAt: string | null;
  updatedBy: string | null;
}
let current: Current = { overrides: {}, values: { ...LIMIT_DEFAULTS }, updatedAt: null, updatedBy: null };

/** The effective values; the defaults until the saved ones are loaded. */
export const limits = (): Limits => current.values;

/**
 * Limits that are not settings (Gmail's own), sent with the editable ones so the browser checks against the same
 * value instead of keeping its own copy.
 */
export const FIXED_LIMITS = { outboundAttachmentMaxBytes: MAX_ATTACHMENT_BYTES } as const;

/** What Settings shows and edits, plus the fixed limits the screens pre-check against. */
export function limitsSettingsView() {
  return {
    values: { ...current.values },
    defaults: { ...LIMIT_DEFAULTS },
    bounds: LIMIT_BOUNDS,
    fixed: FIXED_LIMITS,
    updatedAt: current.updatedAt,
    updatedBy: current.updatedBy,
  };
}

/** Saved overrides as stored, keeping only valid ones: bad data (hand-edited, a lowered ceiling) falls back to the default. */
function readOverrides(stored: unknown): Partial<Limits> {
  if (stored === undefined || stored === null) return {};
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    logger.warn({ stored }, 'Limits settings are not an object; using the defaults');
    return {};
  }
  const overrides: Partial<Limits> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in FIELDS)) {
      logger.warn({ key }, 'Unknown saved limit ignored');
      continue;
    }
    if (!validLimit(key as LimitKey, value)) {
      logger.warn({ key, value, bounds: LIMIT_BOUNDS[key as LimitKey] }, 'Saved limit out of range; using the default');
      continue;
    }
    overrides[key as LimitKey] = value;
  }
  return overrides;
}

const effective = (overrides: Partial<Limits>): Limits => ({ ...LIMIT_DEFAULTS, ...overrides });

export async function refreshLimitsSettings(): Promise<void> {
  const {
    rows: [row],
  } = await pool.query(
    `SELECT s.value, s.updated_at, u.name AS updated_by_name FROM app_settings s LEFT JOIN users u ON u.id=s.updated_by WHERE s.key=$1`,
    [SETTING],
  );
  const overrides = readOverrides(row?.value);
  current = {
    overrides,
    values: effective(overrides),
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row?.updated_by_name ?? null,
  };
}

/** Startup: load the saved values and keep them in sync with saves on any instance. */
const sync = createSyncedSetting({
  channel: CHANNEL,
  refresh: refreshLimitsSettings,
  resyncMs: LIMITS_SETTINGS_RESYNC_MS,
  name: 'Limits settings',
});
export const startLimitsSettings = (): Promise<void> => sync.start();
export const stopLimitsSettingsSync = (): void => sync.stop();
/** RUNTIME=netlify: re-read when older than SYNCED_SETTING_MAX_AGE_MS (no LISTEN there). */
export const ensureLimitsSettingsFresh = (): Promise<void> => sync.ensureFresh();
/** RUNTIME=netlify: re-read now, for Settings to show what another instance just saved. Listen mode: no-op. */
export const reloadLimitsSettings = (): Promise<void> => sync.ensureFresh({ maxAgeMs: 0 });

export class LimitsValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

/**
 * `input`: a number sets that value, null resets it to the default, a key left out is kept. Validated (range) before
 * anything is written; throws LimitsValidationError otherwise.
 */
export async function saveLimitsSettings(
  input: Partial<Record<LimitKey, number | null>>,
  actorId: string,
): Promise<void> {
  // Re-read first so a save on another instance since the last NOTIFY is not overwritten.
  await refreshLimitsSettings();
  const overrides: Partial<Limits> = { ...current.overrides };
  for (const [key, value] of Object.entries(input) as [LimitKey, number | null | undefined][]) {
    if (!(key in FIELDS)) throw new LimitsValidationError(`Unknown limit "${key}"`, key);
    if (value === undefined) continue;
    if (value === null) {
      delete overrides[key];
      continue;
    }
    if (!validLimit(key, value))
      throw new LimitsValidationError(
        `${key} must be a whole number from ${FIELDS[key].min} to ${FIELDS[key].max}`,
        key,
      );
    // A value equal to the default is stored as "no override", so a later change of the default applies to it.
    if (value === LIMIT_DEFAULTS[key]) delete overrides[key];
    else overrides[key] = value;
  }
  const previous = current.values;
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [SETTING, JSON.stringify(overrides), actorId],
  );
  await refreshLimitsSettings();
  await notify(CHANNEL).catch((err) =>
    logger.warn({ err }, 'Limits settings NOTIFY failed; other instances resync within minutes'),
  );
  const changed = Object.fromEntries(
    LIMIT_KEYS.filter((k) => previous[k] !== current.values[k]).map((k) => [
      k,
      { from: previous[k], to: current.values[k] },
    ]),
  );
  await audit({ action: 'LIMITS_SETTINGS_UPDATED', entityType: 'settings', actorId, details: { changed } });
}
