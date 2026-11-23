// Test worker for tests/workerPool.test.ts: speaks the WorkerPool protocol and misbehaves on request.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (task) => {
  switch (task.kind) {
    case 'echo':
      parentPort.postMessage({ ok: true, value: { value: task.value } });
      break;
    case 'slow':
      setTimeout(() => parentPort.postMessage({ ok: true, value: { value: task.value } }), task.ms);
      break;
    case 'bytes': {
      // The byte array's length and checksum, and whether it arrived as its own (transferred) buffer.
      let sum = 0;
      for (const b of task.data) sum = (sum + b) % 65521;
      const own = task.data.byteOffset === 0 && task.data.buffer.byteLength === task.data.byteLength;
      parentPort.postMessage({ ok: true, value: { value: `${task.data.byteLength}:${sum}:${own}` } });
      break;
    }
    case 'fail':
      parentPort.postMessage({ ok: false, error: 'bad input' });
      break;
    case 'hang':
      for (;;) {
        /* a parser stuck in a loop */
      }
    case 'oom': {
      const hoard = [];
      for (;;) hoard.push(new Array(1_000_000).fill(Math.random()));
    }
    case 'exit':
      process.exit(3);
  }
});
