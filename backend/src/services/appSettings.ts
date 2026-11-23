import { config } from '../config.js';
import { POLL_INTERVAL_DEFAULT } from '../constants.js';
import { pool } from '../db/pool.js';
export {
  IMPORT_DAYS_MAX,
  IMPORT_DAYS_MIN,
  POLL_INTERVAL_DEFAULT,
  POLL_INTERVAL_MAX,
  POLL_INTERVAL_MIN,
} from '../constants.js';

const AUTO_SINCE_KEY = 'gmail_auto_import_since';

/**
 * Automatic ingestion (polling, push, the daily reconciliation) only takes mail received from this moment on:
 * the moment the mailbox was connected. Earlier mail, today's included, comes in only through a manual import.
 * Without a stored value it is set on first use, so `create: false` only reads it.
 */
export async function gmailAutoImportSince(opts: { create?: boolean } = { create: true }): Promise<Date | null> {
  if (opts.create !== false) {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [
      AUTO_SINCE_KEY,
      JSON.stringify(new Date().toISOString()),
    ]);
  }
  const {
    rows: [row],
  } = await pool.query('SELECT value FROM app_settings WHERE key=$1', [AUTO_SINCE_KEY]);
  return typeof row?.value === 'string' ? new Date(row.value) : null;
}

/** Connecting a mailbox starts automatic ingestion from that moment: only new mail comes in. */
export async function resetGmailAutoImportSince(actorId: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [AUTO_SINCE_KEY, JSON.stringify(new Date().toISOString()), actorId],
  );
}

const POLL_INTERVAL_KEY = 'gmail_poll_interval_seconds';

/** Seconds between automatic Gmail checks (Settings → Monitoring); 0 = off. Not stored yet: the default. */
export async function gmailPollIntervalSeconds(): Promise<number> {
  const {
    rows: [row],
  } = await pool.query('SELECT value FROM app_settings WHERE key=$1', [POLL_INTERVAL_KEY]);
  return typeof row?.value === 'number' ? row.value : POLL_INTERVAL_DEFAULT;
}

export async function setGmailPollIntervalSeconds(seconds: number, actorId: string): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [POLL_INTERVAL_KEY, JSON.stringify(seconds), actorId],
  );
}

// ------------------------------------------------------------------ Automation (Settings → Automation)

/**
 * AUTO: the step runs by itself when a new email arrives (and steps chained after it). MANUAL: it waits for a person to
 * click its button. A person's click always runs the step in full, whatever is set here.
 */
export type AutomationMode = 'AUTO' | 'MANUAL';
export const AUTOMATION_STEPS = [
  'classification',
  'fieldExtraction',
  'npiVerification',
  'synthesis',
  'analysis',
  'autoQuote',
] as const;
export type AutomationStep = (typeof AUTOMATION_STEPS)[number];
export type AutomationSettings = Record<AutomationStep, AutomationMode>;

const AUTOMATION_KEY = 'automation_modes';

/** Without a stored value: classification, extraction and NPI checks are automatic; the reports follow AUTO_REPORTS. */
function automationDefaults(): AutomationSettings {
  const reports: AutomationMode = config.AUTO_REPORTS ? 'AUTO' : 'MANUAL';
  return {
    classification: 'AUTO',
    fieldExtraction: 'AUTO',
    npiVerification: 'AUTO',
    synthesis: reports,
    analysis: reports,
    autoQuote: reports,
  };
}

/** Steps missing from a stored value (or stored before a step existed) take the default. */
function withDefaults(value: unknown): AutomationSettings {
  const stored = value && typeof value === 'object' ? (value as Partial<AutomationSettings>) : {};
  const out = automationDefaults();
  for (const step of AUTOMATION_STEPS) {
    if (stored[step] === 'AUTO' || stored[step] === 'MANUAL') out[step] = stored[step]!;
  }
  return out;
}

/**
 * The current settings. Each automatic step reads them when it is about to run, so a change applies from then on;
 * nothing already done is re-run, and nothing goes back over older submissions.
 */
export async function automationSettings(): Promise<AutomationSettings> {
  const {
    rows: [row],
  } = await pool.query('SELECT value FROM app_settings WHERE key=$1', [AUTOMATION_KEY]);
  return withDefaults(row?.value);
}

/** Saves the given steps; the rest keep their current mode. Returns the previous and the new settings. */
export async function saveAutomationSettings(patch: Partial<AutomationSettings>, actorId: string) {
  const previous = await automationSettings();
  // Merged in the database (jsonb ||), so two admins saving different steps at once do not undo each other.
  const changes = Object.fromEntries(AUTOMATION_STEPS.filter((k) => patch[k]).map((k) => [k, patch[k]]));
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = CASE WHEN jsonb_typeof(app_settings.value) = 'object' THEN app_settings.value ELSE '{}'::jsonb END || EXCLUDED.value,
       updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [AUTOMATION_KEY, JSON.stringify(changes), actorId],
  );
  return { previous, next: await automationSettings() };
}
