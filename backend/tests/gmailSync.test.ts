/**
 * Gmail history sync and watch renewal (TEST-04), against services/gmail.ts itself with Google faked at the
 * googleapis boundary. The database is an in-memory stand-in for the one gmail_accounts row, the ingest queue only
 * records what was enqueued, and the advisory lock runs its callback: no Postgres is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  // services/gmail.ts reads the Pub/Sub topic from config at import time; a watch is only registered with one.
  process.env.GMAIL_PUBSUB_TOPIC = 'projects/test/topics/gmail';
  process.env.GMAIL_ENABLE_VIA_MCP = 'false';

  type Account = {
    id: string;
    email: string;
    refresh_token_enc: string;
    history_id: string | null;
    watch_expires_at: Date | null;
  };
  const state = {
    account: null as Account | null,
    enqueued: [] as string[][],
    historyPages: new Map<string | undefined, { history?: unknown[]; historyId?: string; nextPageToken?: string }>(),
    historyError: null as null | { code: number; message: string },
    profileHistoryId: '900',
    recentMessages: [] as string[],
    watchExpiration: String(Date.now() + 7 * 24 * 3600_000),
  };
  const gmail = {
    users: {
      history: {
        list: vi.fn(async (params: { startHistoryId: string; pageToken?: string }) => {
          if (state.historyError) throw Object.assign(new Error(state.historyError.message), state.historyError);
          return { data: state.historyPages.get(params.pageToken) ?? {} };
        }),
      },
      getProfile: vi.fn(async () => ({ data: { historyId: state.profileHistoryId } })),
      messages: {
        list: vi.fn(async () => ({ data: { messages: state.recentMessages.map((id) => ({ id })) } })),
      },
      watch: vi.fn(async () => ({ data: { expiration: state.watchExpiration, historyId: '1' } })),
      stop: vi.fn(async () => ({})),
    },
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/SELECT \* FROM gmail_accounts/.test(sql)) return { rows: state.account ? [state.account] : [] };
    if (state.account && /UPDATE gmail_accounts SET watch_expires_at/.test(sql))
      state.account.watch_expires_at = params[1] as Date;
    if (state.account && /UPDATE gmail_accounts SET history_id/.test(sql))
      state.account.history_id = params[1] as string | null;
    return { rows: [], rowCount: 0 };
  });
  return { state, gmail, query };
});

vi.mock('googleapis', () => {
  class OAuth2 {
    setCredentials() {}
    generateAuthUrl() {
      return 'https://accounts.example/auth';
    }
  }
  return { google: { auth: { OAuth2 }, gmail: () => h.gmail } };
});

vi.mock('../src/db/pool.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pool: { query: h.query },
  withTransaction: async <T>(fn: (db: { query: typeof h.query }) => Promise<T>) => fn({ query: h.query }),
}));

vi.mock('../src/services/pgListen.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withAdvisoryLock: async <T>(_name: string, fn: () => Promise<T>) => fn(),
}));

vi.mock('../src/services/ingestQueue.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueMessages: vi.fn(async (_db: unknown, ids: string[]) => {
    h.state.enqueued.push([...ids]);
  }),
  drainQueue: vi.fn(async () => 0),
}));

vi.mock('../src/services/crypto.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decryptSecret: () => ({ value: 'refresh-token', stale: false }),
}));

vi.mock('../src/services/appSettings.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  gmailAutoImportSince: async () => new Date('2026-01-01T00:00:00Z'),
  gmailPollIntervalSeconds: async () => 60,
}));

vi.mock('../src/services/audit.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  audit: vi.fn(async () => undefined),
  recordSystemError: vi.fn(async () => undefined),
}));

const gmailService = await import('../src/services/gmail.js');

/** The stored account row (always set by beforeEach). */
const acc = () => {
  if (!h.state.account) throw new Error('no account');
  return h.state.account;
};
const added = (...ids: string[]) => ({ messagesAdded: ids.map((id) => ({ message: { id } })) });

beforeEach(() => {
  h.state.account = {
    id: 'acc-1',
    email: 'intake@example.com',
    refresh_token_enc: 'enc',
    history_id: '100',
    watch_expires_at: null,
  };
  h.state.enqueued = [];
  h.state.historyPages = new Map();
  h.state.historyError = null;
  h.state.profileHistoryId = '900';
  h.state.recentMessages = [];
  vi.clearAllMocks();
  gmailService.forgetGmailClient();
});

afterEach(() => {
  gmailService.stopGmailMonitor();
  vi.useRealTimers();
});

describe('incremental history sync', () => {
  it('follows every history page from the stored historyId and moves the cursor to the last one', async () => {
    h.state.historyPages.set(undefined, { history: [added('m1', 'm2')], historyId: '150', nextPageToken: 'p2' });
    h.state.historyPages.set('p2', { history: [added('m3')], historyId: '160' });

    await gmailService.pollOnce();

    expect(h.gmail.users.history.list).toHaveBeenCalledTimes(2);
    expect(h.gmail.users.history.list.mock.calls.map(([p]) => [p.startHistoryId, p.pageToken])).toEqual([
      ['100', undefined],
      ['100', 'p2'],
    ]);
    expect(h.state.enqueued).toEqual([['m1', 'm2', 'm3']]);
    expect(h.state.account?.history_id).toBe('160');
    expect(h.gmail.users.messages.list).not.toHaveBeenCalled(); // no fallback search
  });

  it('keeps the cursor moving when nothing new arrived (reads it from the profile)', async () => {
    h.state.historyPages.set(undefined, { historyId: '100' });

    await gmailService.pollOnce();

    expect(h.state.enqueued).toEqual([[]]);
    expect(h.state.account?.history_id).toBe('900');
  });

  it('falls back to a recent-mail search with a fresh cursor when the historyId has expired (404)', async () => {
    h.state.historyError = { code: 404, message: 'Requested entity was not found.' };
    h.state.recentMessages = ['r1', 'r2'];
    h.state.profileHistoryId = '5000';

    await gmailService.pollOnce();

    expect(h.gmail.users.messages.list).toHaveBeenCalledTimes(1);
    expect(h.gmail.users.messages.list.mock.calls[0]?.[0]).toMatchObject({ q: expect.stringContaining('in:inbox') });
    expect(h.state.enqueued).toEqual([['r1', 'r2']]);
    expect(h.state.account?.history_id).toBe('5000');
  });

  it('does not swallow other history errors or move the cursor', async () => {
    h.state.historyError = { code: 500, message: 'Backend Error' };

    await expect(gmailService.pollOnce()).rejects.toThrow('Backend Error');

    expect(h.state.enqueued).toEqual([]);
    expect(h.state.account?.history_id).toBe('100');
  });

  it('starts from a recent-mail search when no cursor is stored yet', async () => {
    acc().history_id = null;
    h.state.recentMessages = ['first'];

    await gmailService.pollOnce();

    expect(h.gmail.users.history.list).not.toHaveBeenCalled();
    expect(h.state.enqueued).toEqual([['first']]);
    expect(h.state.account?.history_id).toBe('900');
  });
});

describe('watch renewal', () => {
  it('registers a watch when none is stored and records its expiry', async () => {
    await gmailService.ensureWatch();

    expect(h.gmail.users.watch).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { topicName: 'projects/test/topics/gmail', labelIds: ['INBOX'] },
    });
    expect(h.state.account?.watch_expires_at?.getTime()).toBe(Number(h.state.watchExpiration));
  });

  it('leaves a watch alone while it has more than a day left, and renews it inside the last day', async () => {
    acc().watch_expires_at = new Date(Date.now() + 3 * 24 * 3600_000);
    await gmailService.ensureWatch();
    expect(h.gmail.users.watch).not.toHaveBeenCalled();

    acc().watch_expires_at = new Date(Date.now() + 2 * 3600_000);
    await gmailService.ensureWatch();
    expect(h.gmail.users.watch).toHaveBeenCalledTimes(1);
  });

  it('checks the watch on every monitor tick, renewing only when due', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    h.state.historyPages.set(undefined, { historyId: '100' });

    gmailService.startGmailMonitor();
    await vi.waitFor(() => expect(h.gmail.users.history.list).toHaveBeenCalledTimes(1));
    expect(h.gmail.users.watch).toHaveBeenCalledTimes(1); // first tick: no watch yet

    await vi.advanceTimersByTimeAsync(60_000); // the poll interval (Settings → Monitoring)
    await vi.waitFor(() => expect(h.gmail.users.history.list).toHaveBeenCalledTimes(2));
    expect(h.gmail.users.watch).toHaveBeenCalledTimes(1); // 7 days left: not renewed

    vi.setSystemTime(Date.now() + 6.5 * 24 * 3600_000); // inside the last day of the watch
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(h.gmail.users.history.list).toHaveBeenCalledTimes(3));
    expect(h.gmail.users.watch).toHaveBeenCalledTimes(2);
  });
});
