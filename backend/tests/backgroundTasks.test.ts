/** Post-response work (services/backgroundTasks.ts): in the background on a server; never after the answer on Netlify. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ netlify: false, triggerWorker: vi.fn(async () => undefined) }));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  isNetlifyRuntime: () => h.netlify,
}));
vi.mock('../src/runtime/workerTrigger.js', () => ({ triggerWorker: h.triggerWorker }));

const { runInBackground, start, taskSnapshot, drainBackground } = await import('../src/services/backgroundTasks.js');

/** A task that finishes only when released, to tell "returned at once" from "awaited". */
function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const fn = vi.fn(async () => {
    await gate;
    return 'done';
  });
  return { fn, release };
}

beforeEach(() => {
  h.netlify = false;
  h.triggerWorker.mockClear();
});

describe('server runtime', () => {
  it('server runtime: runInBackground unchanged', async () => {
    const { fn, release } = gated();
    let returned = false;
    await runInBackground('t', fn, { worker: { task: 'gmail-poll' } }).then(() => {
      returned = true;
    });
    expect(returned).toBe(true); // before the work finished
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.triggerWorker).not.toHaveBeenCalled();
    release();
    expect(await drainBackground(1000)).toBe(0);
  });

  it('start is single-flight per key and keeps the outcome', async () => {
    const { fn, release } = gated();
    expect(await start('srv:key', fn)).toBe(true);
    expect(await start('srv:key', fn)).toBe(false);
    expect(taskSnapshot('srv:key').running).toBe(true);
    release();
    await drainBackground(1000);
    expect(taskSnapshot('srv:key')).toMatchObject({ running: false, result: 'done', error: null });
  });
});

describe('netlify runtime', () => {
  beforeEach(() => {
    h.netlify = true;
  });

  it('netlify runtime: runInBackground for a worker-class task calls triggerWorker and not fn', async () => {
    const fn = vi.fn(async () => undefined);
    await runInBackground('gmail:push', fn, { worker: { task: 'gmail-poll' } });
    expect(h.triggerWorker).toHaveBeenCalledWith('gmail-poll', undefined);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runInBackground without a worker awaits the work before returning, and logs a failure', async () => {
    const order: string[] = [];
    await runInBackground('short', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('work');
    });
    order.push('returned');
    expect(order).toEqual(['work', 'returned']);
    await expect(
      runInBackground('short-fail', async () => {
        throw new Error('boom');
      }),
    ).resolves.toBeUndefined();
  });

  it('start with a worker triggers it with the payload', async () => {
    const fn = vi.fn(async () => 1);
    const actor = { id: 'u1', name: 'Ann' };
    expect(await start('ims2', fn, undefined, { worker: { task: 'ims2-sync', payload: { actor } } })).toBe(true);
    expect(h.triggerWorker).toHaveBeenCalledWith('ims2-sync', { actor });
    expect(fn).not.toHaveBeenCalled();
  });

  it('start without a worker awaits the work and throws its failure after onError', async () => {
    const onError = vi.fn();
    await expect(
      start(
        'nf:fail',
        async () => {
          throw new Error('gone');
        },
        onError,
      ),
    ).rejects.toThrow('gone');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(taskSnapshot('nf:fail')).toMatchObject({ running: false, error: 'gone' });
    expect(await start('nf:ok', async () => 'x')).toBe(true);
    expect(taskSnapshot('nf:ok')).toMatchObject({ running: false, result: 'x' });
  });
});
