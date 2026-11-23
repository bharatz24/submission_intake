import Anthropic from '@anthropic-ai/sdk';

import { config, gmailConfigured, gmailSource } from '../config.js';
import { NPI_API_VERSION, NPI_PROBE_NUMBER, SYSTEM_STATUS_TTL_MS } from '../constants.js';
import { pool } from '../db/pool.js';
import { integrations } from '../integrations/index.js';
import { logger } from '../logger.js';
import { anthropicModel } from './anthropicSettings.js';
import { claudeAvailable, claudePing } from './claude.js';
import { queueStats } from './ingestQueue.js';
import { limits } from './limitsSettings.js';

export interface ServiceStatus {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

// The menu shows a short, user-facing reason; the raw error (status codes, request ids) goes to the log.
function failed(service: string, err: unknown, detail: string): string {
  logger.warn({ err, service }, 'system status check failed');
  return detail;
}

function llmReason(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid API key';
  if (err instanceof Anthropic.PermissionDeniedError) return 'API key lacks access';
  if (err instanceof Anthropic.NotFoundError) return `Model ${anthropicModel()} not available`;
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited, try again shortly';
  if (err instanceof Anthropic.APIConnectionError) return 'Unable to reach Anthropic';
  return 'Service unavailable';
}

async function database(): Promise<ServiceStatus> {
  const base = { key: 'database', label: 'Database (PostgreSQL)' };
  try {
    await pool.query('SELECT 1');
    return { ...base, ok: true, detail: 'Connected' };
  } catch (err) {
    return { ...base, ok: false, detail: failed(base.key, err, 'Unable to connect') };
  }
}

async function llm(): Promise<ServiceStatus> {
  const base = { key: 'llm', label: 'LLM (Anthropic Claude)' };
  if (!claudeAvailable()) return { ...base, ok: false, detail: 'Not configured' };
  try {
    await claudePing();
    return { ...base, ok: true, detail: anthropicModel() };
  } catch (err) {
    return { ...base, ok: false, detail: failed(base.key, err, llmReason(err)) };
  }
}

async function google(): Promise<ServiceStatus> {
  const base = { key: 'google', label: gmailSource === 'MCP' ? 'Gmail (MCP)' : 'Google Cloud (Gmail)' };
  try {
    const st = await integrations().gmail.status();
    if (!st.configured) return { ...base, ok: false, detail: 'Not configured' };
    if (!st.connected) {
      if (st.error) logger.warn({ service: base.key, error: st.error }, 'system status check failed');
      return { ...base, ok: false, detail: 'Not connected' };
    }
    // Connected on paper, but Google rejected the refresh token (revoked/expired): no mail arrives until a reconnect.
    if (st.needsReconnect) {
      logger.warn({ service: base.key, error: st.error }, 'system status check failed');
      return {
        ...base,
        ok: false,
        detail: [st.email, 'authorization rejected: reconnect Gmail'].filter(Boolean).join(' · '),
      };
    }
    const mode = st.mode === 'PUSH' ? 'Pub/Sub push' : st.mode === 'POLLING' ? 'polling' : 'monitoring off';
    return { ...base, ok: true, detail: [st.email, mode].filter(Boolean).join(' · ') };
  } catch (err) {
    return { ...base, ok: false, detail: failed(base.key, err, 'Not connected') };
  }
}

/** Where attachments are stored, plus how many Gmail messages are waiting to be ingested. */
async function storage(): Promise<ServiceStatus> {
  const base = { key: 'storage', label: 'Google Drive (attachments)' };
  const queue = await queueStats().catch((err) => {
    logger.warn({ err }, 'ingest queue stats failed');
    return null;
  });
  const waiting = queue
    ? `${queue.waiting} waiting${queue.alerted ? `, ${queue.alerted} delayed` : ''}`
    : 'queue unknown';
  try {
    await integrations().drive.probe();
    return { ...base, ok: Boolean(queue) && !queue!.alerted, detail: `Google Drive · ${waiting}` };
  } catch (err) {
    return { ...base, ok: false, detail: failed(base.key, err, `Unreachable · ${waiting}`) };
  }
}

class NpiHttpError extends Error {}

/** Looks up a known-valid NPI; throws NpiHttpError for an error answer, anything else when unreachable. Returns the host. */
async function pingNpiRegistry(): Promise<string> {
  const url = new URL(config.NPI_API_BASE);
  url.searchParams.set('version', NPI_API_VERSION);
  url.searchParams.set('number', NPI_PROBE_NUMBER);
  const res = await fetch(url, { signal: AbortSignal.timeout(limits().npiTimeoutSeconds * 1000) });
  if (!res.ok) throw new NpiHttpError(`Registry answered HTTP ${res.status}`);
  await res.json();
  return url.host;
}

async function npiRegistry(): Promise<ServiceStatus> {
  const base = { key: 'npi', label: 'NPI Registry' };
  try {
    await pingNpiRegistry();
    return { ...base, ok: true, detail: 'Reachable' };
  } catch (err) {
    return {
      ...base,
      ok: false,
      detail: failed(base.key, err, err instanceof NpiHttpError ? 'Service unavailable' : 'Unreachable'),
    };
  }
}

let cache: { at: number; result: Promise<{ checkedAt: string; services: ServiceStatus[] }> } | null = null;

/** Drops the cached status so the next check runs live (after a setting it depends on, such as the API key, changed). */
export function invalidateSystemStatus(): void {
  cache = null;
}

export function systemStatus() {
  if (!cache || Date.now() - cache.at > SYSTEM_STATUS_TTL_MS) {
    cache = {
      at: Date.now(),
      result: Promise.all([database(), llm(), google(), storage(), npiRegistry()]).then((services) => ({
        checkedAt: new Date().toISOString(),
        services,
      })),
    };
  }
  return cache.result;
}

// ------------------------------------------------------------------ On-demand tests (Settings → Connections)

export const TESTABLE_SERVICES = ['database', 'llm', 'gmail', 'drive', 'npi', 'ims2Queue'] as const;
export type TestableService = (typeof TESTABLE_SERVICES)[number];

export interface ConnectionTest extends ServiceStatus {
  configured: boolean;
  latencyMs: number;
  testedAt: string;
}

const LABELS: Record<TestableService, string> = {
  database: 'Database (PostgreSQL)',
  llm: 'Claude API (Anthropic)',
  gmail: gmailSource === 'MCP' ? 'Gmail (MCP)' : 'Gmail (Google OAuth)',
  drive: 'Google Drive (attachments)',
  npi: 'NPI Registry (NPPES)',
  ims2Queue: 'IMS 2 Submission Intake queue',
};

/** Admins asked for the test, so the failure message is the underlying reason, trimmed; the full error goes to the log. */
function reason(service: string, err: unknown): string {
  logger.warn({ err, service }, 'connection test failed');
  if (err instanceof Anthropic.APIError) return llmReason(err);
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 300) || 'Failed';
}

const PROBES: Record<TestableService, { configured: () => boolean; run: () => Promise<string> }> = {
  database: {
    configured: () => true,
    run: async () => {
      const {
        rows: [r],
      } = await pool.query<{ v: string }>("SELECT current_setting('server_version') AS v");
      return `Connected · PostgreSQL ${r?.v ?? 'unknown version'}`;
    },
  },
  llm: {
    configured: claudeAvailable,
    run: async () => {
      await claudePing();
      return `Connected · ${anthropicModel()}`;
    },
  },
  gmail: { configured: () => gmailConfigured, run: () => integrations().gmail.probe() },
  // Drive uses the Google account behind GOOGLE_REFRESH_TOKEN (services/driveStorage.ts).
  drive: {
    configured: () => Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REFRESH_TOKEN),
    run: async () => {
      await integrations().drive.probe();
      return 'Folder reachable and writable';
    },
  },
  npi: { configured: () => true, run: async () => `Reachable · ${await pingNpiRegistry()}` },
  ims2Queue: { configured: () => integrations().ims2.configured(), run: () => integrations().ims2.probe() },
};

/** Runs one check now, bypassing the status cache; never throws. Either way the header status is re-checked next time. */
export async function testConnection(service: TestableService): Promise<ConnectionTest> {
  const probe = PROBES[service];
  const started = Date.now();
  const base = { key: service, label: LABELS[service], testedAt: new Date().toISOString() };
  if (!probe.configured()) return { ...base, configured: false, ok: false, detail: 'Not configured', latencyMs: 0 };
  let timer: NodeJS.Timeout | undefined;
  const seconds = limits().connectionTestTimeoutSeconds;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${seconds} seconds`)), seconds * 1000);
  });
  try {
    const detail = await Promise.race([probe.run(), timeout]);
    return { ...base, configured: true, ok: true, detail, latencyMs: Date.now() - started };
  } catch (err) {
    return { ...base, configured: true, ok: false, detail: reason(service, err), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    cache = null;
  }
}

export function connectionList() {
  return TESTABLE_SERVICES.map((key) => ({ key, label: LABELS[key], configured: PROBES[key].configured() }));
}
