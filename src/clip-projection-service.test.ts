import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createCas } from './cas.ts';
import { createClipProjectionService, type ClipRequest } from './clip-projection-service.ts';
import { CLIP_PROJECTION_VERSION, type ClipProjection } from './clip-projection.ts';
import type { ClipCompute } from './clip-worker-pool.ts';
import type { ClipSnapshot } from './clip-blob-reader.ts';
import { withFakeSession, changesFor } from './test/helpers.ts';
import { computeClipProjection } from './clip-blob-reader.ts';
import type { ProjectionTraceEvent } from './projection-trace.ts';

const sha = (i: number): string => String(i).padStart(64, '0');
const contentReq = (seq: string, id: number): ClipRequest => ({
  changeSeq: seq,
  before: { kind: 'absent' },
  after: { kind: 'content', sha256: sha(id), size: 3 },
});
const fallback = (changeSeq: string): ClipProjection => ({
  change_seq: changeSeq,
  projection_version: CLIP_PROJECTION_VERSION,
  status: 'fallback',
  fallback_reason: 'function-extraction-unavailable',
  clips: [],
});
const alwaysPresent = async (): Promise<boolean> => true;
const STORE = '/nonexistent-store';

test('identical blobs under different languages do not share a cached extraction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-language-cache-'));
  const cas = await createCas(join(dir, 'blobs'));
  const before = await cas.put(Buffer.from('function f(n: string) {\n  return 1;\n}\n'));
  const after = await cas.put(Buffer.from('function f(n: string) {\n  return 2;\n}\n'));
  let computes = 0;
  const svc = createClipProjectionService({ storeDir: dir, compute: job => {
    computes++;
    return { promise: computeClipProjection(job), cancel: () => {} };
  } });
  const req: ClipRequest = { changeSeq: '2', before: { kind: 'content', ...before }, after: { kind: 'content', ...after } };
  try {
    const js = await svc.get({ ...req, language: 'javascript' });
    const ts = await svc.get({ ...req, language: 'typescript' });
    assert.equal(js.status, 'fallback');
    assert.equal(ts.status, 'ready');
    assert.equal((await svc.get({ ...req, language: 'typescript' })).status, 'ready');
    assert.equal(computes, 2);
  } finally { await svc.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a version upgrade recomputes the same blobs after discarding the old process cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-version-cache-'));
  const cas = await createCas(join(dir, 'blobs'));
  const after = await cas.put(Buffer.from('function f() {\n  return 1;\n}\n'));
  const req: ClipRequest = { changeSeq: '2', language: 'javascript', before: { kind: 'absent' }, after: { kind: 'content', ...after } };
  // Model the prior deployment's warm in-memory cache. There is deliberately
  // no persisted cache to migrate and no runtime algorithm-version switch.
  const old = createClipProjectionService({ storeDir: dir, compute: job => ({
    promise: Promise.resolve({ ...fallback(job.opts.changeSeq), projection_version: 'clip.v1' }), cancel: () => {},
  }) });
  assert.equal((await old.get(req)).projection_version, 'clip.v1');
  await old.close();
  // This tests cache/version behavior, not cold worker startup speed. The real
  // I/O computation remains intact; worker/deadline behavior has separate tests.
  let recomputes = 0;
  const current = createClipProjectionService({ storeDir: dir, compute: job => {
    recomputes++;
    return { promise: computeClipProjection(job), cancel: () => {} };
  } });
  try {
    const result = await current.get(req);
    assert.equal(result.projection_version, 'clip.v3');
    assert.equal(result.status, 'ready');
    assert.equal(result.clips[0]!.after.method, 'function');
    assert.equal(recomputes, 1);
  } finally { await current.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a soft parser timeout with prepared fallback is never cached', async () => {
  let calls = 0;
  const svc = createClipProjectionService({ storeDir: STORE, hasBlob: alwaysPresent,
    compute: job => ({ promise: Promise.resolve({ ...fallback(job.opts.changeSeq),
      fallback_reason: ++calls === 1 ? 'timeout' : 'no-enclosing-function' }), cancel: () => {} }) });
  try {
    assert.equal((await svc.get(contentReq('1', 1))).fallback_reason, 'timeout');
    assert.equal((await svc.get(contentReq('1', 1))).fallback_reason, 'no-enclosing-function');
    assert.equal(calls, 2);
  } finally { await svc.close(); }
});

test('cold request computes on demand, then serves from cache', async () => {
  let calls = 0;
  const compute: ClipCompute = (job) => {
    calls++;
    return { promise: Promise.resolve(fallback(job.opts.changeSeq)), cancel: () => {} };
  };
  const svc = createClipProjectionService({ storeDir: STORE, compute, hasBlob: alwaysPresent });
  const first = await svc.get(contentReq('1', 1));
  const second = await svc.get(contentReq('2', 1)); // same blobs, different change_seq
  assert.equal(calls, 1);
  assert.equal(first.status, 'fallback');
  assert.equal(first.change_seq, '1');
  assert.equal(second.change_seq, '2'); // change_seq is stamped per request, not cached
  assert.equal(second.projection_version, CLIP_PROJECTION_VERSION);
  await svc.close();
});

test('dropped cache entry recomputes an identical result', async () => {
  let calls = 0;
  const compute: ClipCompute = (job) => {
    calls++;
    return { promise: Promise.resolve(fallback(job.opts.changeSeq)), cancel: () => {} };
  };
  const svc = createClipProjectionService({
    storeDir: STORE, compute, hasBlob: alwaysPresent, cacheEntries: 1,
  });
  const a1 = await svc.get(contentReq('1', 1));
  await svc.get(contentReq('2', 2)); // evicts entry for blob 1 (cacheEntries: 1)
  const a2 = await svc.get(contentReq('3', 1)); // recompute blob 1
  assert.equal(calls, 3);
  assert.equal(a1.status, a2.status);
  assert.equal(a1.projection_version, a2.projection_version);
  assert.deepEqual(a1.clips, a2.clips);
  await svc.close();
});

test('identical concurrent requests coalesce onto one compute', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const compute: ClipCompute = (job) => {
    calls++;
    return { promise: gate.then(() => fallback(job.opts.changeSeq)), cancel: () => {} };
  };
  const svc = createClipProjectionService({ storeDir: STORE, compute, hasBlob: alwaysPresent });
  const p1 = svc.get(contentReq('1', 1));
  const p2 = svc.get(contentReq('2', 1));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(calls, 1);
  assert.equal(r1.change_seq, '1');
  assert.equal(r2.change_seq, '2'); // coalesced waiter still gets its own change_seq
  await svc.close();
});

test('coalesced clip waiters consume W and trace separately from their running leader', async () => {
  const events: ProjectionTraceEvent[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const svc = createClipProjectionService({ storeDir: STORE, hasBlob: alwaysPresent,
    queueLimit: 1, projectionTrace: event => events.push(event),
    compute: job => ({ promise: gate.then(() => fallback(job.opts.changeSeq)), cancel: () => {} }) });
  const req = { ...contentReq('1', 1), traceRouteKey: '/same-clips' };
  try {
    const leader = svc.get(req);
    const waiter = svc.get({ ...req, changeSeq: '2' });
    const rejected = await svc.get({ ...req, changeSeq: '3' });
    assert.equal(rejected.fallback_reason, 'overloaded');
    release();
    await Promise.all([leader, waiter]);
    assert.deepEqual(events.filter(e => e.kind === 'admission').map(e => e.disposition),
      ['running', 'waiting', 'overloaded']);
    assert.equal(events.filter(e => e.kind === 'dispatch').length, 1);
    assert.equal(events.filter(e => e.kind === 'task-finished').length, 1);
  } finally { release(); await svc.close(); }
});

test('optional dispatch barrier holds one admitted clip leader while same-key waiters consume W', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let computes = 0;
  const svc = createClipProjectionService({ storeDir: STORE, hasBlob: alwaysPresent,
    queueLimit: 2, deadlineMs: 1_000, dispatchBarrier: () => held,
    compute: job => { computes++; return { promise: Promise.resolve(fallback(job.opts.changeSeq)), cancel: () => {} }; } });
  const req = contentReq('1', 1);
  try {
    const leader = svc.get(req);
    const waiterA = svc.get({ ...req, changeSeq: '2' });
    const waiterB = svc.get({ ...req, changeSeq: '3' });
    const rejected = await svc.get({ ...req, changeSeq: '4' });
    assert.equal(rejected.fallback_reason, 'overloaded');
    assert.equal(computes, 0, 'barrier must hold the actual worker dispatch');
    release();
    assert.deepEqual((await Promise.all([leader, waiterA, waiterB])).map(v => v.change_seq), ['1', '2', '3']);
    assert.equal(computes, 1);
  } finally { release(); await svc.close(); }
});

test('clip deadline includes the optional barrier and prevents late compute', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let computes = 0;
  const svc = createClipProjectionService({ storeDir: STORE, hasBlob: alwaysPresent,
    deadlineMs: 10, dispatchBarrier: () => held,
    compute: job => { computes++; return { promise: Promise.resolve(fallback(job.opts.changeSeq)), cancel: () => {} }; } });
  try {
    const result = await svc.get(contentReq('1', 1));
    assert.equal(result.fallback_reason, 'timeout');
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(computes, 0);
  } finally { release(); await svc.close(); }
});

test('a coalesced waiter does not redundantly re-write the leader\'s cache entry', async (t) => {
  // LruCache.set() is the only caller of JSON.stringify in this module's hot
  // path, so counting calls to it is a precise proxy for "how many times was
  // this key written to the cache" without reaching into cache internals.
  const stringifyCalls: unknown[] = [];
  const realStringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (v: unknown) => { stringifyCalls.push(v); return realStringify(v); });

  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const compute: ClipCompute = (job) => {
    calls++;
    return { promise: gate.then(() => fallback(job.opts.changeSeq)), cancel: () => {} };
  };
  const svc = createClipProjectionService({ storeDir: STORE, compute, hasBlob: alwaysPresent });
  const p1 = svc.get(contentReq('1', 1));
  const p2 = svc.get(contentReq('2', 1));
  const p3 = svc.get(contentReq('3', 1)); // three coalesced callers, one compute
  release();
  await Promise.all([p1, p2, p3]);
  assert.equal(calls, 1);
  assert.equal(stringifyCalls.length, 1, 'the cache entry for the shared key must be written exactly once, not once per coalesced waiter');
  await svc.close();
});

test('burst beyond admission is skipped as overloaded, not stalled', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const compute: ClipCompute = (job) => {
    calls++;
    return { promise: gate.then(() => fallback(job.opts.changeSeq)), cancel: () => {} };
  };
  const svc = createClipProjectionService({
    storeDir: STORE, compute, hasBlob: alwaysPresent, queueLimit: 1,
  });
  const pA = svc.get(contentReq('A', 1)); // runs
  const pB = svc.get(contentReq('B', 2)); // queued
  const rC = await svc.get(contentReq('C', 3)); // no slot, no queue -> overloaded immediately
  assert.equal(rC.status, 'skipped');
  assert.equal(rC.fallback_reason, 'overloaded');
  assert.equal(calls, 1); // C never computed
  release();
  const [rA, rB] = await Promise.all([pA, pB]);
  assert.equal(rA.status, 'fallback');
  assert.equal(rB.status, 'fallback');
  assert.equal(calls, 2);
  await svc.close();
});

test('the default deadline cancels at 100 ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let canceled = false;
  let settled = false;
  const svc = createClipProjectionService({ storeDir: STORE, compute: () => ({
    promise: new Promise<ClipProjection>(() => {}),
    cancel: () => { canceled = true; },
  }) });
  t.after(() => svc.close());
  const result = svc.get(contentReq('1', 1)).then(value => { settled = true; return value; });
  t.mock.timers.tick(99);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(canceled, false);
  t.mock.timers.tick(1);
  const value = await result;
  assert.equal(value.status, 'skipped');
  assert.equal(value.fallback_reason, 'timeout');
  assert.equal(canceled, true);
});

test('a wall-clock overrun yields skipped/timeout and cancels the compute', async () => {
  let canceled = false;
  const compute: ClipCompute = () => ({
    promise: new Promise<ClipProjection>(() => {}), // never resolves
    cancel: () => { canceled = true; },
  });
  const svc = createClipProjectionService({
    storeDir: STORE, compute, hasBlob: alwaysPresent, deadlineMs: 10,
  });
  const r = await svc.get(contentReq('1', 1));
  assert.equal(r.status, 'skipped');
  assert.equal(r.fallback_reason, 'timeout');
  assert.equal(canceled, true);
  await svc.close();
});

test('a hit whose blob is gone is dropped and recomputed, never served stale', async () => {
  let calls = 0;
  let present = true;
  const compute: ClipCompute = (job) => {
    calls++;
    return { promise: Promise.resolve(fallback(job.opts.changeSeq)), cancel: () => {} };
  };
  const svc = createClipProjectionService({
    storeDir: STORE, compute, hasBlob: async () => present,
  });
  await svc.get(contentReq('1', 1)); // compute + cache
  await svc.get(contentReq('2', 1)); // hit, blob present -> served from cache
  assert.equal(calls, 1);
  present = false;
  await svc.get(contentReq('3', 1)); // hit, blob gone -> drop + recompute
  assert.equal(calls, 2);
  await svc.close();
});

test('transient outcomes (timeout/overloaded) are never cached', async () => {
  let calls = 0;
  const compute: ClipCompute = () => {
    calls++;
    return { promise: new Promise<ClipProjection>(() => {}), cancel: () => {} };
  };
  const svc = createClipProjectionService({
    storeDir: STORE, compute, hasBlob: alwaysPresent, deadlineMs: 5,
  });
  const r1 = await svc.get(contentReq('1', 1));
  const r2 = await svc.get(contentReq('2', 1));
  assert.equal(r1.fallback_reason, 'timeout');
  assert.equal(r2.fallback_reason, 'timeout');
  // Two computes prove the first timeout was NOT cached and reused — the only
  // way to tell caching from recomputation when both outcomes read 'timeout'.
  assert.equal(calls, 2);
  await svc.close();
});

test('a per-side unavailable fallback is not cached, so a restored blob recomputes', async () => {
  // The before blob is missing at compute time (per-side method 'unavailable');
  // when it is later restored the request must recompute, not serve the stale
  // "before-missing" result — revalidate-on-hit can't catch this because the
  // snapshot still names a content sha whose blob is back.
  let calls = 0;
  const unavailableSide: ClipProjection = {
    change_seq: '',
    projection_version: CLIP_PROJECTION_VERSION,
    status: 'fallback',
    fallback_reason: 'function-extraction-unavailable',
    clips: [{
      before: { span: null, method: 'unavailable', reason: 'before-missing' },
      after: { span: null, method: 'whole-file' },
    }],
  };
  const compute: ClipCompute = (job) => {
    calls++;
    return { promise: Promise.resolve({ ...unavailableSide, change_seq: job.opts.changeSeq }), cancel: () => {} };
  };
  const svc = createClipProjectionService({ storeDir: STORE, compute, hasBlob: alwaysPresent });
  const r1 = await svc.get(contentReq('1', 1));
  const r2 = await svc.get(contentReq('2', 1));
  assert.equal(r1.clips[0]!.before.method, 'unavailable');
  assert.equal(calls, 2); // recomputed, not served from cache
  assert.equal(r2.change_seq, '2');
  await svc.close();
});

test('coalesced waiters beyond admission are bounded, not accumulated', async () => {
  // Hold one compute pending and pile identical requests onto it. Only
  // maxPending (CONCURRENCY 1 + queueLimit) may wait; the rest are overloaded
  // immediately rather than attaching unbounded waiters.
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const compute: ClipCompute = (job) => {
    calls++;
    return { promise: gate.then(() => fallback(job.opts.changeSeq)), cancel: () => {} };
  };
  const svc = createClipProjectionService({
    storeDir: STORE, compute, hasBlob: alwaysPresent, queueLimit: 2,
  });
  const admitted = [svc.get(contentReq('1', 1)), svc.get(contentReq('2', 1)), svc.get(contentReq('3', 1))];
  const overloaded = await svc.get(contentReq('4', 1)); // maxPending is 3 -> the 4th is rejected
  assert.equal(overloaded.fallback_reason, 'overloaded');
  release();
  const results = await Promise.all(admitted);
  assert.equal(calls, 1); // all admitted waiters coalesced onto one compute
  assert.deepEqual(results.map((r) => r.change_seq), ['1', '2', '3']);
  await svc.close();
});

test('close settles queued work and rejects new requests', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const compute: ClipCompute = (job) => ({
    promise: gate.then(() => fallback(job.opts.changeSeq)),
    cancel: () => {},
  });
  const svc = createClipProjectionService({
    storeDir: STORE, compute, hasBlob: alwaysPresent, queueLimit: 2,
  });
  const pRun = svc.get(contentReq('A', 1)); // running
  const pQueued = svc.get(contentReq('B', 2)); // queued (distinct blob)
  await svc.close(); // must settle both without hanging
  const rQueued = await pQueued;
  assert.equal(rQueued.fallback_reason, 'worker-error'); // drained, not stalled
  const rAfter = await svc.get(contentReq('C', 3)); // rejected after close
  assert.equal(rAfter.fallback_reason, 'worker-error');
  release();
  await pRun; // running task settles too, no dangling promise
});

test('default worker pool computes a real projection from on-disk blobs', { timeout: 15_000 }, async t => {
  // Verify the result before its deadline, independently of host startup speed.
  // Real-clock cancellation tests and the live benchmark cover the time budget.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storeDir = await mkdtemp(join(tmpdir(), 'slip-clipsvc-'));
  const svc = createClipProjectionService({ storeDir });
  t.after(async () => { await svc.close(); await rm(storeDir, { recursive: true, force: true }); });
  const cas = await createCas(join(storeDir, 'blobs'));
  const beforeRef = await cas.put(Buffer.from('a\nb\nc\n', 'utf8'));
  const afterRef = await cas.put(Buffer.from('a\nB\nc\n', 'utf8'));
  const before: ClipSnapshot = { kind: 'content', sha256: beforeRef.sha256, size: beforeRef.size };
  const after: ClipSnapshot = { kind: 'content', sha256: afterRef.sha256, size: afterRef.size };
  const r = await svc.get({ changeSeq: '5', before, after });
  assert.equal(r.status, 'fallback');
  assert.equal(r.change_seq, '5');
  assert.ok(r.clips.length >= 1);
  // second identical request is a cache hit (revalidated against the real store)
  const r2 = await svc.get({ changeSeq: '6', before, after });
  assert.equal(r2.change_seq, '6');
  assert.equal(r2.status, 'fallback');
});

test('close awaits the busy worker terminated by admission cancellation, not just its replacement', async (t) => {
  // Reproduces: close() amid a running compute cancels the busy worker via
  // budget.close() (fire-and-forget), which spawns a replacement synchronously.
  // If close() then awaits only the CURRENT worker (the untouched replacement),
  // it resolves before the original worker's real termination completes.
  const terminated: Array<() => void> = [];
  const realTerminate = Worker.prototype.terminate;
  let calls = 0;
  t.mock.method(Worker.prototype, 'terminate', function (this: Worker) {
    calls++;
    const isFirst = calls === 1;
    return new Promise((resolve) => {
      const finish = () => resolve(realTerminate.call(this));
      if (isFirst) terminated.push(finish); else finish();
    });
  });

  const storeDir = await mkdtemp(join(tmpdir(), 'slip-clipsvc-close-'));
  const events: ProjectionTraceEvent[] = [];
  const svc = createClipProjectionService({ storeDir, deadlineMs: 60_000,
    projectionTrace: event => events.push(event) });
  const cas = await createCas(join(storeDir, 'blobs'));
  const beforeRef = await cas.put(Buffer.from('a\nb\nc\n', 'utf8'));
  const afterRef = await cas.put(Buffer.from('a\nB\nc\n', 'utf8'));
  const before: ClipSnapshot = { kind: 'content', sha256: beforeRef.sha256, size: beforeRef.size };
  const after: ClipSnapshot = { kind: 'content', sha256: afterRef.sha256, size: afterRef.size };

  let closePromise: Promise<void> | undefined;
  try {
    const pending = svc.get({ changeSeq: '1', before, after, traceRouteKey: '/closed-clips' }); // admitted, running
    // Give the job a tick to actually reach the worker before closing.
    await new Promise((r) => setTimeout(r, 0));

    let closed = false;
    closePromise = svc.close().then(() => { closed = true; });
    // The original worker's terminate() is held open; close() must not have
    // resolved yet — it may only resolve once that termination completes.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closed, false, 'close() resolved before the busy worker actually terminated');
    assert.equal(terminated.length, 1);
    const retired = events.find(event => event.kind === 'process-retire');
    assert.ok(retired);
    assert.equal(events.some(event => event.kind === 'process-exit' && event.processId === retired.processId), false);

    terminated[0]!(); // let the original worker's termination complete
    await closePromise;
    assert.equal(closed, true);
    await pending;
    assert.ok(events.some(event => event.kind === 'process-exit' && event.processId === retired.processId));
    assert.equal(events.filter(event => event.kind === 'task-finished').length, 1);
  } finally {
    terminated[0]?.(); // always release the held termination so the real worker actually exits
    await closePromise?.catch(() => {});
    await rm(storeDir, { recursive: true, force: true });
  }
});

test('capture proceeds while projection admission is saturated', async () => {
  // Codex D2: hold projection work pending (stuck workers) and prove a real
  // filesystem change still commits — capture never waits on projection.
  const compute: ClipCompute = () => ({
    promise: new Promise<ClipProjection>(() => {}), // never resolves (worker "busy")
    cancel: () => {},
  });
  await withFakeSession(
    async (root) => { await writeFile(join(root, 'seed.txt'), 'seed\n'); },
    async ({ root, observe, waitFor }) => {
      const svc = createClipProjectionService({
        storeDir: STORE, compute, hasBlob: alwaysPresent,
        queueLimit: 1, deadlineMs: 60_000,
      });
      try {
        // Saturate admission: one running, one queued, one overloaded.
        const pRun = svc.get(contentReq('A', 1));
        const pQueued = svc.get(contentReq('B', 2));
        const overloaded = await svc.get(contentReq('C', 3));
        assert.equal(overloaded.fallback_reason, 'overloaded');

        // Capture a real change while projections stay stuck.
        await writeFile(join(root, 'live.txt'), 'hello from capture\n');
        observe('live.txt');
        const recs = await waitFor((rs) => changesFor(rs, 'live.txt').length >= 1);
        assert.ok(changesFor(recs, 'live.txt').length >= 1); // capture unaffected

        void pRun; void pQueued;
      } finally {
        await svc.close();
      }
    },
  );
});
