import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createTypeScriptPool } from './interface-ts-pool.ts';
import type { TypeScriptJob } from './interface-ts-worker.ts';

test('cancelled TypeScript work retires its worker and a later comparison still runs', async () => {
  const pool = createTypeScriptPool();
  try {
    const first = pool.run({ language: 'typescript', before: Buffer.from('function f(x: number): void {}'),
      after: Buffer.from('function f(x: string): void {}') });
    first.cancel();
    await assert.rejects(first.promise, /cancelled/);
    const second = pool.run({ language: 'typescript', before: Buffer.from('function f(x: number): void {}'),
      after: Buffer.from('function f(x: string): void {}'),
      limits: { declarations: 4096, syntaxVisits: 100_000 } });
    const result = await second.promise;
    assert.equal(result.comparison?.status, 'ready');
    assert.equal(result.comparison?.changes.length, 1);
  } finally { await pool.close(); }
});

test('a failed parser reply retires its worker before the next comparison', async (t) => {
  const realPost = Worker.prototype.postMessage;
  let poisoned: Worker | undefined;
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, job: TypeScriptJob) {
    poisoned ??= this;
    if (this === poisoned) {
      queueMicrotask(() => this.emit('message', { id: job.id, ok: false }));
      return;
    }
    realPost.call(this, job);
  });
  const pool = createTypeScriptPool();
  try {
    const input = { language: 'typescript' as const,
      before: Buffer.from('function f(x: number): void {}'),
      after: Buffer.from('function f(x: string): void {}') };
    await assert.rejects(pool.run(input).promise, /extraction failed/);
    const replacement = await pool.run(input).promise;
    assert.equal(replacement.comparison?.status, 'ready');
    assert.equal(replacement.comparison?.changes.length, 1);
  } finally { await pool.close(); }
});

test('close awaits actual exit of a cancelled worker after its replacement completes work', async (t) => {
  const realTerminate = Worker.prototype.terminate;
  let calls = 0;
  let firstExited = false;
  let releaseFirst: (() => void) | undefined;
  t.mock.method(Worker.prototype, 'terminate', function (this: Worker) {
    calls++;
    if (calls !== 1) return realTerminate.call(this);
    this.once('exit', () => { firstExited = true; });
    return new Promise<number>((resolve, reject) => {
      let released = false;
      releaseFirst = () => {
        if (released) return;
        released = true;
        void realTerminate.call(this).then(resolve, reject);
      };
    });
  });
  const pool = createTypeScriptPool();
  let closing: Promise<void> | undefined;
  try {
    const first = pool.run({ language: 'typescript', before: Buffer.from('function f(x: number): void {}'),
      after: Buffer.from('function f(x: string): void {}') });
    first.cancel();
    await assert.rejects(first.promise, /cancelled/);
    const second = pool.run({ language: 'typescript', before: Buffer.from('function f(x: number): void {}'),
      after: Buffer.from('function f(x: number): void {}') });
    const replacement = await second.promise;
    assert.equal(replacement.comparison?.status, 'ready');
    assert.deepEqual(replacement.comparison?.changes, []);
    let closed = false;
    closing = pool.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'close resolved while the cancelled worker was still alive');
    assert.equal(firstExited, false);
    assert.ok(releaseFirst);
    releaseFirst();
    await closing;
    assert.equal(firstExited, true);
  } finally {
    releaseFirst?.();
    await closing?.catch(() => {});
    await pool.close();
  }
});
