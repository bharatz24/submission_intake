import { RETENTION_DAYS } from '../constants.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { audit } from './audit.js';

/**
 * Settings → Retention (spec §5): how many days transcripts, LLM call rows, chat messages and deleted submissions are
 * kept before the daily purge (services/retention.ts) removes or scrubs them. Each period is null (keep forever, the
 * default) or a whole number of days in RETENTION_DAYS. app_settings holds only the periods an admin set, as one JSON
 * object. Read from the database on use: the purge runs once a day, so no in-memory copy has to be kept in sync.
 */

const SETTING = 'retention';

export interface RetentionSettings {
  llmTranscriptsDays: number | null;
  llmCallsDays: number | null;
  chatDays: number | null;
  deletedSubmissionsDays: number | null;
  /** Emails skipped at intake (Ignored tab): sender, subject and reasons are erased after this many days. */
  skippedEmailsDays: number | null;
}
export type RetentionKey = keyof RetentionSettings;
export const RETENTION_KEYS: RetentionKey[] = [
  'llmTranscriptsDays',
  'llmCallsDays',
  'chatDays',
  'deletedSubmissionsDays',
  'skippedEmailsDays',
];
export const RETENTION_DEFAULTS: RetentionSettings = {
  llmTranscriptsDays: null,
  llmCallsDays: null,
  chatDays: null,
  deletedSubmissionsDays: null,
  skippedEmailsDays: null,
};
export const RETENTION_BOUNDS = { min: RETENTION_DAYS.min, max: RETENTION_DAYS.max };

export const validRetentionDays = (n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= RETENTION_DAYS.min && (n as number) <= RETENTION_DAYS.max;

/** Saved periods as stored, keeping only valid ones: bad data (hand-edited) falls back to keep forever. */
function readSaved(stored: unknown): RetentionSettings {
  const values = { ...RETENTION_DEFAULTS };
  if (stored === undefined || stored === null) return values;
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    logger.warn('Retention settings are not an object; keeping everything');
    return values;
  }
  for (const [key, value] of Object.entries(stored)) {
    if (!RETENTION_KEYS.includes(key as RetentionKey)) {
      logger.warn({ key }, 'Unknown saved retention period ignored');
      continue;
    }
    if (value === null) continue;
    if (!validRetentionDays(value)) {
      logger.warn({ key, value }, 'Saved retention period out of range; keeping everything for it');
      continue;
    }
    values[key as RetentionKey] = value;
  }
  return values;
}

export interface RetentionSettingsView {
  values: RetentionSettings;
  bounds: { min: number; max: number };
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The saved periods (defaults when none are saved) and who changed them last. */
export async function retentionSettingsView(): Promise<RetentionSettingsView> {
  const {
    rows: [row],
  } = await pool.query(
    `SELECT s.value, s.updated_at, u.name AS updated_by_name FROM app_settings s LEFT JOIN users u ON u.id=s.updated_by WHERE s.key=$1`,
    [SETTING],
  );
  return {
    values: readSaved(row?.value),
    bounds: { ...RETENTION_BOUNDS },
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row?.updated_by_name ?? null,
  };
}

/** The periods the purge applies now. */
export const retentionSettings = async (): Promise<RetentionSettings> => (await retentionSettingsView()).values;

export class RetentionValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

/**
 * `input`: a number sets that period, null keeps that data forever, a key left out is kept as saved. Validated before
 * anything is written (RetentionValidationError otherwise); audited with the periods that changed.
 */
export async function saveRetentionSettings(
  input: Partial<Record<RetentionKey, number | null>>,
  actorId: string,
): Promise<RetentionSettingsView> {
  const previous = await retentionSettings();
  const next = { ...previous };
  for (const [key, value] of Object.entries(input) as [RetentionKey, number | null | undefined][]) {
    if (!RETENTION_KEYS.includes(key)) throw new RetentionValidationError(`Unknown retention period "${key}"`, key);
    if (value === undefined) continue;
    if (value !== null && !validRetentionDays(value))
      throw new RetentionValidationError(
        `${key} must be empty (keep forever) or a whole number of days from ${RETENTION_DAYS.min} to ${RETENTION_DAYS.max}`,
        key,
      );
    next[key] = value;
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [SETTING, JSON.stringify(next), actorId],
  );
  const changed = Object.fromEntries(
    RETENTION_KEYS.filter((k) => previous[k] !== next[k]).map((k) => [k, { from: previous[k], to: next[k] }]),
  );
  if (Object.keys(changed).length)
    await audit({ action: 'RETENTION_SETTINGS_UPDATED', entityType: 'settings', actorId, details: { changed } });
  return retentionSettingsView();
}
