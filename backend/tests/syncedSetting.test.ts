/** Synced settings (services/syncedSetting.ts): LISTEN + resync on a server, max-age polling on Netlify. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listen = vi.fn(async () => () => undefined);
vi.mock('../src/services/pgListen.js', () => ({ listen }));

const { createSyncedSetting } = await import('../src/services/syncedSetting.js');
const { SYNCED_SETTING_MAX_AGE_MS } = await import('../src/constants.js');

beforeEach(() => {
  vi.useFakeTimers();
  listen.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

function setting(mode: 'listen' | 'poll') {
  const refresh = vi.fn(async () => undefined);
  const sync = createSyncedSetting({ channel: 'test_channel', refresh, resyncMs: 60_000, name: 'test', mode });
  return { refresh, sync };
}

describe('synced setting', () => {
  it('server mode listens and resyncs as before', async () => {
    const { refresh, sync } = setting('listen');
    await sync.start();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith('test_channel', expect.any(Function));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await sync.ensureFresh(); // no-op: LISTEN and the resync keep it current
    expect(refresh).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it('poll mode does not open a LISTEN client', async () => {
    const { refresh, sync } = setting('poll');
    await sync.start();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(listen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1); // no timer either
  });

  it('poll mode refreshes after max age', async () => {
    const { refresh, sync } = setting('poll');
    await sync.start();
    await vi.advanceTimersByTimeAsync(SYNCED_SETTING_MAX_AGE_MS - 1000);
    await sync.ensureFresh();
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await sync.ensureFresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    await sync.ensureFresh();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('poll mode: maxAgeMs 0 re-reads now (a Settings GET after a save on another instance); listen mode does not', async () => {
    const poll = setting('poll');
    await poll.sync.start();
    await poll.sync.ensureFresh({ maxAgeMs: 0 });
    expect(poll.refresh).toHaveBeenCalledTimes(2);
    const server = setting('listen');
    await server.sync.start();
    await server.sync.ensureFresh({ maxAgeMs: 0 });
    expect(server.refresh).toHaveBeenCalledTimes(1);
    server.sync.stop();
  });

  it('poll mode: concurrent ensureFresh calls share one refresh, and a failed refresh is not thrown', async () => {
    const { refresh, sync } = setting('poll');
    await sync.start({ initial: false });
    expect(refresh).not.toHaveBeenCalled(); // the caller loaded it; counted as fresh
    await vi.advanceTimersByTimeAsync(SYNCED_SETTING_MAX_AGE_MS);
    refresh.mockRejectedValueOnce(new Error('db down'));
    await expect(Promise.all([sync.ensureFresh(), sync.ensureFresh()])).resolves.toBeDefined();
    expect(refresh).toHaveBeenCalledTimes(1);
    await sync.ensureFresh(); // the failure did not count as fresh
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
