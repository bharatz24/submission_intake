import type { OutgoingMessage, SentMessage } from '../../services/gmail.js';
import * as gmail from '../../services/gmail.js';

/**
 * The team's Gmail mailbox (OAuth or MCP), as the rest of the app sees it (external-integrations skill). The real
 * client is services/gmail.ts: history sync, the ingest queue, sending with MIME threading, the OAuth flow. Tests
 * give a fake through setIntegrations({ gmail }) or createApp({ gmail }) instead of mocking the module.
 */
export interface GmailClient {
  /** Which source is configured (OAuth or MCP), whether it is connected, the mailbox and the last poll. */
  status(): ReturnType<typeof gmail.status>;
  /** Google's consent URL for a sign-in started by `userId`. */
  authUrl(userId: string): string;
  /** Completes the OAuth sign-in; the connected mailbox address. */
  handleOAuthCallback(code: string, state: string): Promise<string>;
  /** Imports what is new (and what the ingest queue holds); the number of messages processed. */
  pollOnce(opts?: { manual?: boolean }): Promise<number>;
  /** Forgets the OAuth connection. */
  disconnect(actorId: string): Promise<void>;
  /** Re-imports an email skipped at intake as a submission; null when the message is gone from the mailbox. */
  importSkippedMessage(id: string, actor: { id: string; name: string }): Promise<string | null>;
  /** Ids of inbox messages from the last `days` days (and from `after` on, when given). */
  listRecentMessageIds(days: number, opts?: { automatic?: boolean; after?: Date }): Promise<string[]>;
  /** Sends a reply or forward from the mailbox. */
  send(msg: OutgoingMessage): Promise<SentMessage>;
  /** A live check of the connection, for Settings → Connections. */
  probe(): Promise<string>;
  /** Applies a changed poll interval to the running monitor. */
  rescheduleMonitor(): void;
}

export function createGmailClient(): GmailClient {
  return {
    status: () => gmail.status(),
    authUrl: (userId) => gmail.authUrl(userId),
    handleOAuthCallback: (code, state) => gmail.handleOAuthCallback(code, state),
    pollOnce: (opts) => gmail.pollOnce(opts),
    disconnect: async (actorId) => {
      await gmail.disconnect(actorId);
    },
    importSkippedMessage: (id, actor) => gmail.importSkippedMessage(id, actor),
    listRecentMessageIds: (days, opts) => gmail.listRecentMessageIds(days, opts),
    send: (msg) => gmail.sendMessage(msg),
    probe: () => gmail.gmailProbe(),
    rescheduleMonitor: () => gmail.rescheduleGmailMonitor(),
  };
}
