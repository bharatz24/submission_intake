/** External alerting of system errors (MON-01, services/alerts.ts). No database; the webhook is a fake fetch. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.test/services/T000/B000/secret';

const { ALERT_DEDUPE_MS, ALERT_MAX_PER_HOUR, onSystemError, resetAlerts } = await import('../src/services/alerts.js');

const ok = () =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }));
const sentText = (f: ReturnType<typeof ok>, i = 0) =>
  (JSON.parse(String(f.mock.calls[i]![1]!.body)) as { text: string }).text;

describe('system error alerts', () => {
  beforeEach(() => resetAlerts());

  it('posts a Slack-compatible {text} with personal data scrubbed', async () => {
    const fetchImpl = ok();
    await onSystemError('gmail:poll', 'Failed for jane.doe@example.com, NPI 1234567893', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(process.env.ALERT_WEBHOOK_URL);
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const text = sentText(fetchImpl);
    expect(text).toContain('gmail:poll');
    expect(text).not.toContain('jane.doe@example.com');
    expect(text).not.toContain('1234567893');
  });

  it('sends one alert per scope (ids masked) per window, then counts the suppressed ones', async () => {
    const fetchImpl = ok() as unknown as typeof fetch;
    const now = Date.parse('2026-11-18T10:00:00Z');
    await onSystemError('job:process:6f1c2b9e-1111-4222-8333-944455556666', 'boom', { fetchImpl, now });
    await onSystemError('job:process:0a0b0c0d-1111-4222-8333-944455556666', 'boom', { fetchImpl, now: now + 1000 });
    await onSystemError('gmail:poll', 'other', { fetchImpl, now: now + 2000 });
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
    await onSystemError('job:process:11111111-1111-4222-8333-944455556666', 'boom', {
      fetchImpl,
      now: now + ALERT_DEDUPE_MS + 1,
    });
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(3);
    expect(sentText(vi.mocked(fetchImpl) as never, 2)).toContain('1 similar alert suppressed');
  });

  it('caps alerts per hour across scopes', async () => {
    const fetchImpl = ok() as unknown as typeof fetch;
    const now = Date.parse('2026-11-18T12:00:00Z');
    for (let i = 0; i < ALERT_MAX_PER_HOUR + 5; i++)
      await onSystemError(`scope-${'x'.repeat(i + 1)}`, 'e', { fetchImpl, now });
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(ALERT_MAX_PER_HOUR);
  });

  it('never throws: a webhook that is down or refuses is logged and ignored', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(onSystemError('a', 'x', { fetchImpl: down })).resolves.toBeUndefined();
    const refused = vi.fn(async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(onSystemError('b', 'x', { fetchImpl: refused })).resolves.toBeUndefined();
  });
});
