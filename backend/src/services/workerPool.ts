import { type ResourceLimits, Worker } from 'node:worker_threads';

/**
 * A fixed-size pool of worker threads for CPU- and memory-heavy work that must not block the event loop or take the
 * process down with it (document parsing, OCR). Each worker handles one task at a time; a worker that times out, runs
 * out of memory or crashes is terminated and replaced, and only its own task fails.
 *
 * Protocol: the pool posts the task input; the worker answers each task with `{ ok: true, value }` or
 * `{ ok: false, error }` (see `serveTasks`).
 */

/** Byte arrays at least this large are moved to the worker (transferred) rather than cloned. */
const TRANSFER_MIN_BYTES = 64 * 1024;

/**
 * The message to post for `input`, and what to transfer with it (PERF-05). Posting a Buffer clones it: serialized on
 * this thread and copied again in the worker, so a 50 MB document briefly costs three copies. Each large top-level
 * byte array is instead copied once into a fresh ArrayBuffer of its own and that copy is transferred (moved, not
 * cloned). The copy is required: the caller's Buffer may be a slice of Node's shared pool, a file-cache entry or
 * still in use, and transferring its ArrayBuffer would detach it under the caller.
 */
export function transferable<I>(input: I): { message: I; transfer: ArrayBuffer[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { message: input, transfer: [] };
  const transfer: ArrayBuffer[] = [];
  let message: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(input)) {
    if (!(value instanceof Uint8Array) || value.byteLength < TRANSFER_MIN_BYTES) continue;
    const own = new Uint8Array(value); // a copy with an ArrayBuffer of exactly its size
    message ??= { ...(input as Record<string, unknown>) };
    message[key] = own;
    transfer.push(own.buffer);
  }
  return { message: (message ?? input) as I, transfer };
}

export type WorkerFailure = 'timeout' | 'out-of-memory' | 'crashed' | 'stopped' | 'aborted';

export class WorkerTaskError extends Error {
  constructor(
    message: string,
    readonly reason: WorkerFailure,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkerTaskError';
  }
}

export type WorkerReply<O> = { ok: true; value: O } | { ok: false; error: string };

export interface WorkerPoolOptions {
  /** The worker's entry module. */
  url: URL;
  size: number;
  /** A task still running after this long has its worker terminated. */
  timeoutMs: number;
  resourceLimits?: ResourceLimits;
  /** Names the pool in error messages. */
  name: string;
}

interface Task<I, O> {
  input: I;
  resolve: (value: O) => void;
  reject: (err: Error) => void;
}
interface Slot<I, O> {
  worker: Worker;
  task: Task<I, O> | null;
  timer: NodeJS.Timeout | null;
}

export class WorkerPool<I, O> {
  private readonly slots = new Set<Slot<I, O>>();
  private readonly queue: Task<I, O>[] = [];
  private stopped = false;

  constructor(private readonly options: WorkerPoolOptions) {}

  /**
   * Run one task. When `signal` aborts (e.g. the job's lease was lost), a queued task is dropped and a running one has
   * its worker terminated, so the work stops at once; the task fails with reason 'aborted'.
   */
  run(input: I, signal?: AbortSignal): Promise<O> {
    if (this.stopped) return Promise.reject(new WorkerTaskError(`${this.options.name} is stopped`, 'stopped'));
    if (signal?.aborted) return Promise.reject(new WorkerTaskError(`${this.options.name} task was aborted`, 'aborted'));
    return new Promise<O>((resolve, reject) => {
      const onAbort = () => this.abort(task);
      const detach = () => signal?.removeEventListener('abort', onAbort);
      const task: Task<I, O> = {
        input,
        resolve: (value) => {
          detach();
          resolve(value);
        },
        reject: (err) => {
          detach();
          reject(err);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(task);
      this.drain();
    });
  }

  /** An aborted task: removed from the queue, or its worker terminated if it is running. */
  private abort(task: Task<I, O>): void {
    const error = new WorkerTaskError(`${this.options.name} task was aborted`, 'aborted');
    const queued = this.queue.indexOf(task);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      task.reject(error);
      return;
    }
    const slot = [...this.slots].find((s) => s.task === task);
    if (slot) void this.discard(slot, error);
  }

  /** Workers alive (busy or idle), for tests and diagnostics. */
  get size(): number {
    return this.slots.size;
  }

  /** Rejects queued tasks and terminates every worker; running tasks fail with reason 'stopped'. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const task of this.queue.splice(0))
      task.reject(new WorkerTaskError(`${this.options.name} is stopped`, 'stopped'));
    await Promise.all(
      [...this.slots].map((slot) =>
        this.discard(slot, new WorkerTaskError(`${this.options.name} is stopped`, 'stopped')),
      ),
    );
  }

  private drain(): void {
    while (this.queue.length && !this.stopped) {
      const slot = [...this.slots].find((s) => !s.task) ?? (this.slots.size < this.options.size ? this.spawn() : null);
      if (!slot) return;
      this.start(slot, this.queue.shift()!);
    }
  }

  private spawn(): Slot<I, O> {
    const worker = new Worker(this.options.url, { resourceLimits: this.options.resourceLimits });
    const slot: Slot<I, O> = { worker, task: null, timer: null };
    worker.unref(); // An idle worker never keeps the process alive.
    worker.on('message', (reply: WorkerReply<O>) => {
      const task = this.finish(slot);
      if (!task) return;
      if (reply.ok) task.resolve(reply.value);
      else task.reject(new Error(reply.error));
      this.drain();
    });
    worker.on('error', (err: Error & { code?: string }) => {
      const reason: WorkerFailure = err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out-of-memory' : 'crashed';
      void this.discard(
        slot,
        new WorkerTaskError(
          `${this.options.name} worker ${reason === 'out-of-memory' ? 'ran out of memory' : 'crashed'}: ${err.message}`,
          reason,
          { cause: err },
        ),
      );
    });
    worker.on('exit', (code) => {
      void this.discard(slot, new WorkerTaskError(`${this.options.name} worker exited (code ${code})`, 'crashed'));
    });
    this.slots.add(slot);
    return slot;
  }

  private start(slot: Slot<I, O>, task: Task<I, O>): void {
    slot.task = task;
    slot.worker.ref(); // A running task keeps the process alive until it settles.
    slot.timer = setTimeout(() => {
      void this.discard(
        slot,
        new WorkerTaskError(`${this.options.name} timed out after ${this.options.timeoutMs} ms`, 'timeout'),
      );
    }, this.options.timeoutMs);
    const { message, transfer } = transferable(task.input);
    slot.worker.postMessage(message, transfer);
  }

  /** Clears the slot's task and timer; returns the task that was running, if any. */
  private finish(slot: Slot<I, O>): Task<I, O> | null {
    const task = slot.task;
    slot.task = null;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.worker.unref();
    return task;
  }

  /** Fails the slot's task (if any) with `error`, terminates its worker and starts queued tasks on a fresh one. */
  private async discard(slot: Slot<I, O>, error: WorkerTaskError): Promise<void> {
    if (!this.slots.delete(slot)) return;
    this.finish(slot)?.reject(error);
    this.drain();
    await slot.worker.terminate().catch(() => undefined);
  }
}

/** Worker side: answers each posted task with `handler`'s result (see the protocol above). */
export function serveTasks<I, O>(
  port: { on(event: 'message', listener: (input: I) => void): unknown; postMessage(reply: WorkerReply<O>): void },
  handler: (input: I) => Promise<O>,
): void {
  port.on('message', (input) => {
    handler(input).then(
      (value) => port.postMessage({ ok: true, value }),
      (err: unknown) => port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  });
}
