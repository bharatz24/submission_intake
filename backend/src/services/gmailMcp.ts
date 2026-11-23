import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { config } from '../config.js';
import { GMAIL_MCP_STDERR_LINES_PER_MINUTE } from '../constants.js';
import { logger } from '../logger.js';
import { messageSignals } from './classificationRules.js';
import { limits } from './limitsSettings.js';
import type { AttachmentGap, IncomingAttachment, IncomingEmail } from './pipeline.js';

/**
 * Gmail access through an MCP server (Streamable HTTP via GMAIL_MCP_URL, or a local stdio
 * process via GMAIL_MCP_COMMAND). Tool names are configurable; results are parsed from
 * structuredContent, JSON text, or the common "Key: value" text layout.
 */

let client: Client | null = null;
let connecting: Promise<Client> | null = null;
/** `paused`: an admin pressed Disconnect; polling and sending stay off until resumeMcp() (a manual "Check now"). */
export const mcpState = { lastPollAt: null as Date | null, lastError: null as string | null, paused: false };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** GMAIL_MCP_URL as a URL; plain http is refused except to this machine (the bearer token and mail would travel in clear). */
export function mcpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return url;
  throw new Error('GMAIL_MCP_URL must use https:// (plain http:// is only allowed for localhost)');
}

// The child's stderr is logged (it is where MCP servers report auth and quota problems), but at most this many
// lines a minute (GMAIL_MCP_STDERR_LINES_PER_MINUTE) so a chatty or crash-looping server cannot flood the logs.
let stderrWindow = { start: 0, lines: 0, dropped: 0 };

function logChildStderr(chunk: Buffer | string) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const now = Date.now();
    if (now - stderrWindow.start >= 60_000) {
      if (stderrWindow.dropped) logger.warn({ dropped: stderrWindow.dropped }, 'gmail mcp stderr: lines suppressed');
      stderrWindow = { start: now, lines: 0, dropped: 0 };
    }
    if (stderrWindow.lines >= GMAIL_MCP_STDERR_LINES_PER_MINUTE) {
      stderrWindow.dropped++;
      continue;
    }
    stderrWindow.lines++;
    logger.warn({ line: line.slice(0, 1000) }, 'gmail mcp stderr');
  }
}

function transport() {
  if (config.GMAIL_MCP_URL) {
    const headers: Record<string, string> = config.GMAIL_MCP_TOKEN
      ? { Authorization: `Bearer ${config.GMAIL_MCP_TOKEN}` }
      : {};
    return new StreamableHTTPClientTransport(mcpUrl(config.GMAIL_MCP_URL), { requestInit: { headers } });
  }
  if (config.GMAIL_MCP_COMMAND) {
    const args = config.GMAIL_MCP_ARGS.split(/\s+/).filter(Boolean);
    const t = new StdioClientTransport({ command: config.GMAIL_MCP_COMMAND, args, stderr: 'pipe' });
    t.stderr?.on('data', logChildStderr);
    return t;
  }
  throw new Error('Gmail MCP is not configured: set GMAIL_MCP_URL or GMAIL_MCP_COMMAND');
}

async function getClient(): Promise<Client> {
  if (mcpState.paused) throw new Error('Gmail MCP is disconnected; use "Check now" in Settings to resume');
  if (client) return client;
  connecting ??= (async () => {
    const c = new Client({ name: 'submission-intake-backend', version: '1.0.0' });
    c.onclose = () => {
      client = null;
    };
    await c.connect(transport());
    client = c;
    return c;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

export async function closeMcp(): Promise<void> {
  const c = client;
  client = null;
  await c?.close().catch(() => {
    /* already closed */
  });
}

/** Disconnect: close the session and keep it closed (no polling, no sends) until resumeMcp(). Per process. */
export async function disconnectMcp(): Promise<void> {
  mcpState.paused = true;
  await closeMcp();
}

export function resumeMcp(): void {
  mcpState.paused = false;
}

export async function mcpConnected(): Promise<boolean> {
  if (mcpState.paused) return false;
  try {
    await getClient();
    mcpState.lastError = null;
    return true;
  } catch (err) {
    mcpState.lastError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'gmail mcp connect failed');
    return false;
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ structured: unknown; text: string }> {
  const c = await getClient();
  // Per-request timeout from Settings → Limits (the SDK's default is 60 s, the setting's default too).
  const res = await c.callTool({ name, arguments: args }, undefined, { timeout: limits().gmailTimeoutSeconds * 1000 });
  const text = ((res.content ?? []) as { type: string; text?: string }[])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
  if (res.isError) throw new Error(`MCP tool ${name} failed: ${text.slice(0, 500)}`);
  return { structured: res.structuredContent ?? tryJson(text), text };
}

/** The MCP server says the message does not exist (deleted, or a bad id): the ingest queue drops it as GONE. */
export class McpMessageNotFound extends Error {}

const NOT_FOUND = /\b(not found|no such message|does not exist|404)\b/i;

function tryJson(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export async function searchMessageIds(query: string, maxResults = 50): Promise<string[]> {
  const { structured, text } = await callTool(config.GMAIL_MCP_SEARCH_TOOL, { query, maxResults });
  return parseSearchResult(structured, text);
}

/** Throws McpMessageNotFound when the server reports the message missing, a plain Error for any other failure. */
export async function fetchMessage(id: string): Promise<IncomingEmail> {
  let res: { structured: unknown; text: string };
  try {
    res = await callTool(config.GMAIL_MCP_READ_TOOL, { messageId: id });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('MCP tool ') && NOT_FOUND.test(err.message))
      throw new McpMessageNotFound(err.message);
    throw err;
  }
  return parseMessageResult(id, res.structured, res.text);
}

/** Send a plain-text message through the MCP server's send tool; replies pass the thread and Message-ID. */
export async function sendMessage(msg: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  threadId: string | null;
  inReplyTo?: string | null;
}): Promise<{ messageId: string | null; threadId: string | null }> {
  const { structured, text } = await callTool(config.GMAIL_MCP_SEND_TOOL, {
    to: msg.to,
    cc: msg.cc ?? [],
    bcc: msg.bcc ?? [],
    subject: msg.subject,
    body: msg.body,
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
  });
  return parseSendResult(structured, text);
}

export function parseSendResult(
  structured: unknown,
  text: string,
): { messageId: string | null; threadId: string | null } {
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const s = structured as any;
    return { messageId: s.id ?? s.messageId ?? null, threadId: s.threadId ?? null };
  }
  return {
    // "Email sent successfully with ID: …" or "Message ID: …", but not "Thread ID: …".
    messageId: /(?<!Thread )\bID:\s*(\S+)/i.exec(text)?.[1] ?? null,
    threadId: /Thread ID:\s*(\S+)/i.exec(text)?.[1] ?? null,
  };
}

export function parseSearchResult(structured: unknown, text: string): string[] {
  if (structured !== undefined) {
    const s = structured as any;
    const list: any[] = Array.isArray(s) ? s : (s.messages ?? s.emails ?? s.results ?? s.threads ?? []);
    const ids = list
      .map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.messageId)))
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (ids.length || list.length === 0) return [...new Set(ids)];
  }
  return [...new Set([...text.matchAll(/^\s*(?:Message )?ID:\s*(\S+)/gim)].map((m) => m[1]!))];
}

/**
 * The read tool's reply as an email. A reply that is not one (no sender, subject, body or headers: e.g. a plain
 * "Message not found" or an error sentence) is never stored as an email: McpMessageNotFound or an Error is thrown.
 */
export function parseMessageResult(id: string, structured: unknown, text: string): IncomingEmail {
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const m = structured as any;
    if (
      ![m.from, m.subject, m.body, m.bodyText, m.text, m.headers].some((v) => v !== undefined && v !== null && v !== '')
    ) {
      const said = String(m.error?.message ?? m.error ?? m.message ?? text ?? '');
      if (NOT_FOUND.test(said)) throw new McpMessageNotFound(`MCP read ${id}: ${said.slice(0, 200)}`);
      throw new Error(
        `MCP read ${id}: the reply is not an email (${said.slice(0, 200) || 'no sender, subject or body'})`,
      );
    }
    const date = m.date ?? m.receivedAt ?? m.internalDate;
    const list = (Array.isArray(m.attachments) ? m.attachments : []) as any[];
    return {
      gmailMessageId: m.id ?? m.messageId ?? id,
      rfcMessageId: m.rfcMessageId ?? m.headers?.['message-id'] ?? m.headers?.['Message-ID'] ?? null,
      signals: messageSignals(
        Object.fromEntries(
          Object.entries((m.headers ?? {}) as Record<string, unknown>).map(([k, v]) => [
            k.toLowerCase(),
            String(v ?? ''),
          ]),
        ),
        Array.isArray(m.labelIds) ? m.labelIds : Array.isArray(m.labels) ? m.labels : [],
      ),
      threadId: m.threadId ?? null,
      fromAddress: m.from ?? '',
      toAddress: Array.isArray(m.to) ? m.to.join(', ') : (m.to ?? ''),
      ccAddress: (Array.isArray(m.cc) ? m.cc.join(', ') : (m.cc ?? m.headers?.cc ?? m.headers?.Cc ?? '')) || null,
      subject: m.subject || '(no subject)',
      bodyText: m.body ?? m.bodyText ?? m.text ?? m.snippet ?? '',
      receivedAt: toDate(date),
      attachments: list
        .filter((a) => typeof a?.data === 'string')
        .map(
          (a): IncomingAttachment => ({
            filename: a.filename ?? a.name ?? 'attachment',
            mimeType: a.mimeType ?? 'application/octet-stream',
            data: Buffer.from(a.data, 'base64'),
          }),
        ),
      // Listed without content: recorded on the submission instead of being dropped.
      gaps: list
        .filter((a) => typeof a?.data !== 'string')
        .map((a) => noContentGap(a?.filename ?? a?.name ?? 'attachment', a?.mimeType ?? null, a?.size)),
    };
  }
  // "Key: value" header block, blank line, then body (optionally followed by an Attachments list).
  const [head = '', ...rest] = text.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const headers: Record<string, string> = {};
  for (const line of head.split('\n')) {
    const kv = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (kv) headers[kv[1]!.trim().toLowerCase()] = kv[2]!.trim();
  }
  // A real message always has a sender; anything else is an error or status sentence, not mail.
  if (!headers.from) {
    const said = text.trim().slice(0, 200);
    if (NOT_FOUND.test(said)) throw new McpMessageNotFound(`MCP read ${id}: ${said}`);
    throw new Error(`MCP read ${id}: the reply is not an email (${said || 'empty'})`);
  }
  const joined = rest.join('\n\n');
  const body = joined.replace(/\n*Attachments \(\d+\):[\s\S]*$/, '').trim();
  return {
    gmailMessageId: id,
    rfcMessageId: headers['message-id'] ?? null,
    threadId: headers['thread id'] ?? null,
    fromAddress: headers.from ?? '',
    toAddress: headers.to ?? '',
    ccAddress: headers.cc || null,
    subject: headers.subject || '(no subject)',
    bodyText: body,
    receivedAt: toDate(headers.date),
    attachments: [],
    // The text layout never carries attachment content, only names.
    gaps: listedAttachments(joined).map((name) => noContentGap(name, null, null)),
  };
}

/** Names under an "Attachments (n):" heading, one per line, e.g. "- loss_runs.pdf (application/pdf, 120 KB)". */
export function listedAttachments(text: string): string[] {
  const m = /Attachments \(\d+\):[ \t]*\n([\s\S]*)$/.exec(text);
  if (!m) return [];
  return m[1]!
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim(),
    )
    .filter(Boolean);
}

function noContentGap(filename: string, mimeType: string | null, size: unknown): AttachmentGap {
  return {
    filename: String(filename).slice(0, 500),
    mimeType,
    sizeBytes: typeof size === 'number' ? size : null,
    reason: 'NO_CONTENT',
    detail: 'The Gmail MCP server listed this attachment without its content',
  };
}

function toDate(v: unknown): Date {
  if (v === undefined || v === null || v === '') return new Date();
  const d = typeof v === 'number' || /^\d+$/.test(String(v)) ? new Date(Number(v)) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
