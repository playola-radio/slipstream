import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectionAdmission,
  type AdmitOutcome,
  type ComputeHandle,
} from './projection-admission.ts';

// A test-only synthetic workload: a fake compute with a controllable resolution
// and a cancel spy. It stands in for the future interface-projection service so
// the shared budget is exercised by more than one workload. No interface code.
interface Gate {
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e: unknown) => void;
}
function gate(): Gate {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function later(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('an immediately runnable leader is admitted even when Q is 0', async () => {
  // Regression: a design that reserves a queue slot first would reject the very
  // first request despite an idle worker.
  const budget = createProjectionAdmission({ C: 1, Q: 0, W: 0, D: 1000 });
  let ran = false;
  const outcome = await budget.admit<string>({
    workload: 'clip', localConcurrency: 1,
    run: () => { ran = true; return { promise: Promise.resolve('v'), cancel: () => {} }; },
  });
  assert.equal(ran, true);
  assert.deepEqual(outcome, { kind: 'ok', value: 'v' });
  await budget.close();
});

test('combined demand across two workloads over the bound is rejected as overloaded', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 1, W: 1, D: 1000 });
  const g = gate();
  const held = (): ComputeHandle<string> => ({ promise: g.promise, cancel: () => {} });
  // C=1 running + Q=1 queued = 2 admitted. The 3rd (from either workload) is over.
  const a = budget.admit<string>({ workload: 'clip', localConcurrency: 1, key: 'a', run: held });
  const b = budget.admit<string>({ workload: 'iface', localConcurrency: 4, key: 'b', run: held });
  const c = await budget.admit<string>({ workload: 'iface', localConcurrency: 4, key: 'c', run: held });
  assert.deepEqual(c, { kind: 'overloaded' });
  g.resolve('done');
  assert.deepEqual(await a, { kind: 'ok', value: 'done' });
  assert.deepEqual(await b, { kind: 'ok', value: 'done' });
  await budget.close();
});

test('active work across both workloads never exceeds C', async () => {
  const budget = createProjectionAdmission({ C: 2, Q: 8, W: 8, D: 1000 });
  let active = 0;
  let maxActive = 0;
  const g = gate();
  const run = (): ComputeHandle<string> => {
    active++;
    if (active > maxActive) maxActive = active;
    return { promise: g.promise.then((v) => { active--; return v; }), cancel: () => {} };
  };
  const admits: Promise<AdmitOutcome<string>>[] = [];
  for (let i = 0; i < 6; i++) {
    admits.push(budget.admit<string>({
      workload: i % 2 === 0 ? 'clip' : 'iface', localConcurrency: 4, key: `k${i}`, run,
    }));
  }
  await later(5);
  assert.ok(maxActive <= 2, `maxActive=${maxActive}`);
  g.resolve('done');
  await Promise.all(admits);
  assert.ok(maxActive <= 2, `after drain maxActive=${maxActive}`);
  assert.deepEqual(budget.snapshot(), { running: 0, queued: 0, waiters: 0 });
  await budget.close();
});

test('a per-workload concurrency cap holds under a shared C greater than one', async () => {
  const budget = createProjectionAdmission({ C: 2, Q: 8, W: 8, D: 1000 });
  let clipActive = 0;
  let clipMax = 0;
  const g = gate();
  const clipRun = (): ComputeHandle<string> => {
    clipActive++;
    if (clipActive > clipMax) clipMax = clipActive;
    return { promise: g.promise.then((v) => { clipActive--; return v; }), cancel: () => {} };
  };
  const ifaceRun = (): ComputeHandle<string> => ({ promise: g.promise, cancel: () => {} });
  const clipAdmits = [
    budget.admit<string>({ workload: 'clip', localConcurrency: 1, key: 'c1', run: clipRun }),
    budget.admit<string>({ workload: 'clip', localConcurrency: 1, key: 'c2', run: clipRun }),
  ];
  const iface = budget.admit<string>({ workload: 'iface', localConcurrency: 2, key: 'i1', run: ifaceRun });
  await later(5);
  // Even with a free global slot, clip may run only one compute at a time.
  assert.equal(clipMax, 1);
  g.resolve('done');
  await Promise.all([...clipAdmits, iface]);
  assert.equal(clipMax, 1);
  await budget.close();
});

test('a request that expires while queued settles timeout and never runs', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 4, W: 4, D: 40 });
  const g = gate();
  let queuedRan = false;
  const running = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'run',
    run: () => ({ promise: g.promise, cancel: () => {} }),
  });
  const queued = await budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'wait',
    run: () => { queuedRan = true; return { promise: Promise.resolve('v'), cancel: () => {} }; },
  });
  assert.deepEqual(queued, { kind: 'timeout' });
  assert.equal(queuedRan, false);
  g.resolve('done');
  await running;
  await budget.close();
});

test('a request that expires while running is cancelled and settles timeout', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 4, W: 4, D: 30 });
  let cancelled = false;
  const outcome = await budget.admit<string>({
    workload: 'clip', localConcurrency: 1,
    run: () => ({ promise: new Promise<string>(() => {}), cancel: () => { cancelled = true; } }),
  });
  assert.deepEqual(outcome, { kind: 'timeout' });
  assert.equal(cancelled, true);
  await budget.close();
});

test('coalesced waiters are bounded by W independently of Q', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 8, W: 2, D: 1000 });
  const g = gate();
  let computes = 0;
  const run = (): ComputeHandle<string> => {
    computes++;
    return { promise: g.promise, cancel: () => {} };
  };
  const leader = budget.admit<string>({ workload: 'clip', localConcurrency: 1, key: 'K', run });
  const w1 = budget.admit<string>({ workload: 'clip', localConcurrency: 1, key: 'K', run });
  const w2 = budget.admit<string>({ workload: 'clip', localConcurrency: 1, key: 'K', run });
  const w3 = await budget.admit<string>({ workload: 'clip', localConcurrency: 1, key: 'K', run });
  assert.deepEqual(w3, { kind: 'overloaded' }); // waiters would exceed W=2
  g.resolve('shared');
  const results = await Promise.all([leader, w1, w2]);
  assert.equal(computes, 1); // all coalesced onto one compute
  assert.deepEqual(results, [
    { kind: 'ok', value: 'shared' },
    { kind: 'ok', value: 'shared' },
    { kind: 'ok', value: 'shared' },
  ]);
  await budget.close();
});

test('a leader timeout settles its coalesced waiters too', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 8, W: 8, D: 30 });
  const leader = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'K',
    run: () => ({ promise: new Promise<string>(() => {}), cancel: () => {} }),
  });
  const waiter = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'K',
    run: () => ({ promise: new Promise<string>(() => {}), cancel: () => {} }),
  });
  assert.deepEqual(await leader, { kind: 'timeout' });
  assert.deepEqual(await waiter, { kind: 'timeout' });
  await budget.close();
});

test('close settles active and queued work and leaves no slots held', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 4, W: 4, D: 60_000 });
  const g = gate();
  const active = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'a',
    run: () => ({ promise: g.promise, cancel: () => {} }),
  });
  const queued = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'b',
    run: () => ({ promise: g.promise, cancel: () => {} }),
  });
  await budget.close();
  assert.deepEqual(await active, { kind: 'closed' });
  assert.deepEqual(await queued, { kind: 'closed' });
  assert.deepEqual(budget.snapshot(), { running: 0, queued: 0, waiters: 0 });
  // admission after close is refused, never left hanging
  assert.deepEqual(
    await budget.admit<string>({ workload: 'clip', localConcurrency: 1, run: () => ({ promise: Promise.resolve('v'), cancel: () => {} }) }),
    { kind: 'closed' },
  );
});

test('no slot leaks after a randomized mix of settlements', async () => {
  const budget = createProjectionAdmission({ C: 2, Q: 6, W: 6, D: 25 });
  const admits: Promise<AdmitOutcome<string>>[] = [];
  for (let i = 0; i < 200; i++) {
    const roll = i % 4;
    admits.push(budget.admit<string>({
      workload: i % 2 === 0 ? 'clip' : 'iface',
      localConcurrency: i % 2 === 0 ? 1 : 2,
      key: `k${i % 7}`,
      run: () => {
        if (roll === 0) return { promise: Promise.resolve(`v${i}`), cancel: () => {} };
        if (roll === 1) return { promise: Promise.reject(new Error('boom')), cancel: () => {} };
        return { promise: new Promise<string>(() => {}), cancel: () => {} }; // times out
      },
    }));
    if (i % 10 === 0) await later(1);
  }
  await Promise.all(admits);
  await later(40); // let every deadline fire
  assert.deepEqual(budget.snapshot(), { running: 0, queued: 0, waiters: 0 });
  // budget is still usable
  assert.deepEqual(
    await budget.admit<string>({ workload: 'clip', localConcurrency: 1, run: () => ({ promise: Promise.resolve('ok'), cancel: () => {} }) }),
    { kind: 'ok', value: 'ok' },
  );
  await budget.close();
});

test('a queued burst is promoted first-in-first-out', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 8, W: 8, D: 60_000 });
  const g = gate();
  const order: string[] = [];
  const admits: Promise<AdmitOutcome<string>>[] = [];
  // First one runs (holds the single slot); the rest queue behind it.
  admits.push(budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'lead',
    run: () => { order.push('lead'); return { promise: g.promise, cancel: () => {} }; },
  }));
  for (const id of ['b', 'c', 'd']) {
    admits.push(budget.admit<string>({
      workload: 'clip', localConcurrency: 1, key: id,
      run: () => { order.push(id); return { promise: Promise.resolve(id), cancel: () => {} }; },
    }));
  }
  g.resolve('lead-done');
  await Promise.all(admits);
  assert.deepEqual(order, ['lead', 'b', 'c', 'd']);
  await budget.close();
});

test('a rejected compute promise settles error, releasing the slot', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 1, W: 1, D: 1000 });
  const first = await budget.admit<string>({
    workload: 'clip', localConcurrency: 1,
    run: () => ({ promise: Promise.reject(new Error('nope')), cancel: () => {} }),
  });
  assert.equal(first.kind, 'error');
  // slot released -> the next request runs, not overloaded
  const second = await budget.admit<string>({
    workload: 'clip', localConcurrency: 1,
    run: () => ({ promise: Promise.resolve('v'), cancel: () => {} }),
  });
  assert.deepEqual(second, { kind: 'ok', value: 'v' });
  assert.deepEqual(budget.snapshot(), { running: 0, queued: 0, waiters: 0 });
  await budget.close();
});
