/** WorkerPool: isolation of document parsing in worker threads. No database; uses a plain-JS fixture worker. */
import { afterEach, describe, expect, it } from 'vitest';

import { transferable, WorkerPool, WorkerTaskError } from '../src/services/workerPool.js';

type Task = {
  kind: 'echo' | 'slow' | 'fail' | 'hang' | 'oom' | 'exit' | 'bytes';
  value?: string;
  ms?: number;
  data?: Uint8Array;
};
type Reply = { value: string };

const pools: WorkerPool<Task, Reply>[] = [];
function makePool(over: { size?: number; timeoutMs?: number } = {}) {
  const pool = new WorkerPool<Task, Reply>({
    url: new URL('./fixtures/poolWorker.mjs', import.meta.url),
    size: over.size ?? 1,
    timeoutMs: over.timeoutMs ?? 5000,
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    name: 'Test pool',
  });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.stop()));
});

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );

describe('WorkerPool', () => {
  it('runs tasks and reuses its worker', async () => {
    const pool = makePool();
    expect(await pool.run({ kind: 'echo', value: 'a' })).toEqual({ value: 'a' });
    expect(await pool.run({ kind: 'echo', value: 'b' })).toEqual({ value: 'b' });
    expect(pool.size).toBe(1);
  });

  it('queues tasks beyond its size and runs them in parallel up to it', async () => {
    const pool = makePool({ size: 2 });
    const started = Date.now();
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((value) => pool.run({ kind: 'slow', value, ms: 300 })));
    expect(results.map((r) => r.value)).toEqual(['a', 'b', 'c', 'd']);
    expect(pool.size).toBe(2);
    expect(Date.now() - started).toBeLessThan(1100); // Two rounds of two, not four in a row.
  });

  it('passes a handler error back without losing the worker', async () => {
    const pool = makePool();
    await expect(pool.run({ kind: 'fail' })).rejects.toThrow('bad input');
    expect(await pool.run({ kind: 'echo', value: 'still here' })).toEqual({ value: 'still here' });
  });

  it('terminates a running task when its signal aborts, and drops a queued one', async () => {
    const pool = makePool({ timeoutMs: 20_000 });
    const controller = new AbortController();
    const running = failure(pool.run({ kind: 'hang' }, controller.signal));
    const queued = failure(pool.run({ kind: 'echo', value: 'never' }, controller.signal));
    const other = pool.run({ kind: 'echo', value: 'other' });
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    controller.abort();
    const [runErr, queuedErr] = await Promise.all([running, queued]);
    expect(Date.now() - started).toBeLessThan(2000); // not the 20 s timeout
    expect((runErr as WorkerTaskError).reason).toBe('aborted');
    expect((queuedErr as WorkerTaskError).reason).toBe('aborted');
    expect(await other).toEqual({ value: 'other' }); // a task without the signal still runs, on a fresh worker
    expect(((await failure(pool.run({ kind: 'echo' }, controller.signal))) as WorkerTaskError).reason).toBe('aborted');
  });

  it('terminates a worker stuck past the timeout and replaces it', async () => {
    const pool = makePool({ timeoutMs: 500 });
    const err = await failure(pool.run({ kind: 'hang' }));
    expect(err).toBeInstanceOf(WorkerTaskError);
    expect((err as WorkerTaskError).reason).toBe('timeout');
    expect(await pool.run({ kind: 'echo', value: 'after' })).toEqual({ value: 'after' });
  });

  it('fails only the task whose worker runs out of memory', async () => {
    const pool = makePool({ size: 2, timeoutMs: 20_000 });
    const [oom, ok] = await Promise.allSettled([
      pool.run({ kind: 'oom' }),
      pool.run({ kind: 'slow', value: 'ok', ms: 200 }),
    ]);
    expect(oom.status).toBe('rejected');
    expect(((oom as PromiseRejectedResult).reason as WorkerTaskError).reason).toBe('out-of-memory');
    expect(ok).toEqual({ status: 'fulfilled', value: { value: 'ok' } });
    expect(await pool.run({ kind: 'echo', value: 'after' })).toEqual({ value: 'after' });
  }, 30_000);

  it('reports a worker that exits mid-task as crashed', async () => {
    const pool = makePool();
    const err = await failure(pool.run({ kind: 'exit' }));
    expect((err as WorkerTaskError).reason).toBe('crashed');
    expect(await pool.run({ kind: 'echo', value: 'after' })).toEqual({ value: 'after' });
  });

  it('rejects running and queued tasks on stop, and new ones after', async () => {
    const pool = makePool();
    const running = failure(pool.run({ kind: 'slow', value: 'a', ms: 5000 }));
    const queued = failure(pool.run({ kind: 'echo', value: 'b' }));
    await new Promise((r) => setTimeout(r, 100));
    await pool.stop();
    expect(((await running) as WorkerTaskError).reason).toBe('stopped');
    expect(((await queued) as WorkerTaskError).reason).toBe('stopped');
    expect(((await failure(pool.run({ kind: 'echo' }))) as WorkerTaskError).reason).toBe('stopped');
    expect(pool.size).toBe(0);
  });
});

describe('WorkerPool buffer transfer (PERF-05)', () => {
  const checksum = (b: Uint8Array) => {
    let sum = 0;
    for (const x of b) sum = (sum + x) % 65521;
    return sum;
  };

  it('moves a large buffer to the worker as its own copy and leaves the caller buffer intact', async () => {
    const pool = makePool();
    // A slice of a bigger buffer, as Node's pool or a cache would hand out.
    const backing = Buffer.alloc(300 * 1024, 7);
    const data = backing.subarray(1024, 1024 + 200 * 1024);
    data[0] = 42;
    const reply = await pool.run({ kind: 'bytes', data });
    expect(reply.value).toBe(`${data.byteLength}:${checksum(data)}:true`);
    // Still readable here: the caller's memory was copied, never detached.
    expect(data.byteLength).toBe(200 * 1024);
    expect(data[0]).toBe(42);
    expect(backing.buffer.byteLength).toBeGreaterThan(0);
  });

  it('clones small buffers and leaves other fields as they are', () => {
    const small = Buffer.from('tiny');
    expect(transferable({ data: small, n: 1 })).toEqual({ message: { data: small, n: 1 }, transfer: [] });
    const big = Buffer.alloc(100 * 1024, 1);
    const { message, transfer } = transferable({ data: big, name: 'x' });
    expect(transfer).toHaveLength(1);
    expect(message.name).toBe('x');
    expect(message.data).not.toBe(big);
    expect(Buffer.compare(Buffer.from(message.data), big)).toBe(0);
  });
});
