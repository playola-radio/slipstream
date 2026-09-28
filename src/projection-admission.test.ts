import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectionAdmission,
  type AdmitOutcome,
  type ComputeHandle,
} from './projection-admission.ts';
import type { ProjectionTraceEvent } from './projection-trace.ts';

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

test('trace records distinct overload, dispatch, queue expiry and one terminal transition', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const events: ProjectionTraceEvent[] = [];
  const budget = createProjectionAdmission({ C: 1, Q: 1, W: 0, D: 40 }, event => events.push(event));
  const held = gate();
  const run = () => ({ promise: held.promise, cancel: () => {} });
  const first = budget.admit({ workload: 'interface', localConcurrency: 1, traceRouteKey: '/same', run });
  const queued = budget.admit({ workload: 'interface', localConcurrency: 1, traceRouteKey: '/queued', run });
  assert.deepEqual(await budget.admit({ workload: 'interface', localConcurrency: 1, traceRouteKey: '/same', run }),
    { kind: 'overloaded' });
  t.mock.timers.tick(41);
  assert.deepEqual(await first, { kind: 'timeout' });
  assert.deepEqual(await queued, { kind: 'timeout' });
  held.resolve('late');
  await Promise.resolve();
  const admissions = events.filter(e => e.kind === 'admission');
  assert.deepEqual(admissions.map(e => e.disposition), ['running', 'queued', 'overloaded']);
  assert.equal(new Set(admissions.map(e => e.unitId)).size, 3);
  const dispatches = events.filter(e => e.kind === 'dispatch');
  assert.deepEqual(dispatches.map(e => e.unitId), [admissions[0]!.unitId]);
  const settles = events.filter(e => e.kind === 'settle');
  assert.equal(settles.length, 3);
  assert.deepEqual(settles.map(e => [e.priorState, e.outcome]),
    [['overloaded', 'overloaded'], ['running', 'timeout'], ['queued', 'timeout']]);
  for (const admission of admissions) {
    const terminal = settles.find(e => e.unitId === admission.unitId)!;
    assert.ok(terminal.atNs >= admission.atNs);
  }
  await budget.close();
});

test('trace records waiter cancellation and close without changing admission results', async () => {
  const events: ProjectionTraceEvent[] = [];
  const budget = createProjectionAdmission({ C: 1, Q: 2, W: 1, D: 1000 }, event => events.push(event));
  const held = gate();
  const run = () => ({ promise: held.promise, cancel: () => {} });
  const leader = budget.admit({ workload: 'interface', localConcurrency: 1, key: 'K', traceRouteKey: '/leader', run });
  const controller = new AbortController();
  const waiter = budget.admit({ workload: 'interface', localConcurrency: 1, key: 'K',
    traceRouteKey: '/waiter', signal: controller.signal, run });
  controller.abort();
  assert.deepEqual(await waiter, { kind: 'cancelled' });
  await budget.close();
  assert.deepEqual(await leader, { kind: 'closed' });
  assert.deepEqual(events.filter(e => e.kind === 'settle').map(e => [e.priorState, e.outcome]),
    [['waiting', 'cancelled'], ['running', 'closed']]);
  held.resolve('late');
  await Promise.resolve();
  assert.equal(events.filter(e => e.kind === 'settle').length, 2);
});

test('throwing trace observer cannot change admission outcome or release', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 0, W: 0, D: 1000 }, () => { throw new Error('collector'); });
  const outcome = await budget.admit({ workload: 'interface', localConcurrency: 1,
    traceRouteKey: '/x', run: () => ({ promise: Promise.resolve('ok'), cancel: () => {} }) });
  assert.deepEqual(outcome, { kind: 'ok', value: 'ok' });
  assert.deepEqual(budget.snapshot(), { running: 0, queued: 0, waiters: 0 });
  await budget.close();
});

test('pre-aborted and post-close calls remain unclassified by the frozen trace union', async () => {
  const events: ProjectionTraceEvent[] = [];
  const budget = createProjectionAdmission({ C: 1, Q: 0, W: 0, D: 1000 }, event => events.push(event));
  const controller = new AbortController();
  controller.abort();
  const run = () => ({ promise: Promise.resolve('never'), cancel: () => {} });
  assert.deepEqual(await budget.admit({ workload: 'interface', localConcurrency: 1,
    traceRouteKey: '/aborted', signal: controller.signal, run }), { kind: 'cancelled' });
  await budget.close();
  assert.deepEqual(await budget.admit({ workload: 'interface', localConcurrency: 1,
    traceRouteKey: '/closed', run }), { kind: 'closed' });
  assert.deepEqual(events, []);
});

test('leader settle is traced before a released waiter can dispatch queued work', async () => {
  const events: ProjectionTraceEvent[] = [];
  const budget = createProjectionAdmission({ C: 1, Q: 2, W: 1, D: 1000 }, event => events.push(event));
  const held = gate();
  const run = () => ({ promise: held.promise, cancel: () => {} });
  const leader = budget.admit({ workload: 'interface', localConcurrency: 1, key: 'same',
    traceRouteKey: '/leader', run });
  const waiter = budget.admit({ workload: 'interface', localConcurrency: 1, key: 'same',
    traceRouteKey: '/waiter', run });
  const queued = budget.admit({ workload: 'interface', localConcurrency: 1,
    traceRouteKey: '/queued', run: () => ({ promise: Promise.resolve('queued'), cancel: () => {} }) });
  held.resolve('done');
  await Promise.all([leader, waiter, queued]);
  const leaderId = events.find(e => e.kind === 'admission' && e.routeKey === '/leader')!;
  const queuedId = events.find(e => e.kind === 'admission' && e.routeKey === '/queued')!;
  assert.ok(leaderId.kind === 'admission' && queuedId.kind === 'admission');
  const leaderSettle = events.findIndex(e => e.kind === 'settle' && e.unitId === leaderId.unitId);
  const queuedDispatch = events.findIndex(e => e.kind === 'dispatch' && e.unitId === queuedId.unitId);
  assert.ok(leaderSettle >= 0 && queuedDispatch > leaderSettle);
  await budget.close();
});

test('a rejected async trace observer cannot produce an unhandled rejection', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 0, W: 0, D: 1000 },
    async () => { throw new Error('async collector'); });
  assert.deepEqual(await budget.admit({ workload: 'interface', localConcurrency: 1,
    traceRouteKey: '/async', run: () => ({ promise: Promise.resolve('ok'), cancel: () => {} }) }),
  { kind: 'ok', value: 'ok' });
  await new Promise(resolve => setImmediate(resolve));
  await budget.close();
});

test('trace dispatches a promoted leader once before its compute starts', async () => {
  const events: ProjectionTraceEvent[] = [];
  const budget = createProjectionAdmission({ C: 1, Q: 1, W: 0, D: 1000 }, event => events.push(event));
  const held = gate();
  const first = budget.admit({ workload: 'interface', localConcurrency: 1,
    traceRouteKey: '/first', run: () => ({ promise: held.promise, cancel: () => {} }) });
  const second = budget.admit({ workload: 'interface', localConcurrency: 1,
    traceRouteKey: '/second', run: () => ({ promise: Promise.resolve('second'), cancel: () => {} }) });
  held.resolve('first');
  assert.deepEqual(await Promise.all([first, second]), [{ kind: 'ok', value: 'first' }, { kind: 'ok', value: 'second' }]);
  const queued = events.find((e): e is Extract<ProjectionTraceEvent, { kind: 'admission' }> =>
    e.kind === 'admission' && e.routeKey === '/second')!;
  const sequence = events.filter(e => 'unitId' in e && e.unitId === queued.unitId);
  assert.deepEqual(sequence.map(e => e.kind), ['admission', 'dispatch', 'settle']);
  assert.ok(sequence[0]!.atNs <= sequence[1]!.atNs && sequence[1]!.atNs <= sequence[2]!.atNs);
  await budget.close();
});

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

test('a disconnected queued request releases its admission slot immediately', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 1, W: 0, D: 1000 });
  const held = gate();
  const first = budget.admit({ workload: 'clip', localConcurrency: 1,
    run: () => ({ promise: held.promise, cancel: () => {} }) });
  const controller = new AbortController();
  let ran = false;
  const queued = budget.admit({ workload: 'interface', localConcurrency: 1, signal: controller.signal,
    run: () => { ran = true; return { promise: Promise.resolve('queued'), cancel: () => {} }; } });
  assert.deepEqual(budget.snapshot(), { running: 1, queued: 1, waiters: 0 });
  controller.abort();
  assert.deepEqual(await queued, { kind: 'cancelled' });
  assert.deepEqual(budget.snapshot(), { running: 1, queued: 0, waiters: 0 });
  assert.equal(ran, false);
  held.resolve('done');
  await first;
  await budget.close();
});

test('a disconnected running request cancels compute and frees capacity', async () => {
  const budget = createProjectionAdmission({ C: 1, Q: 0, W: 0, D: 1000 });
  const controller = new AbortController();
  let cancelled = 0;
  const pending = budget.admit({ workload: 'interface', localConcurrency: 1, signal: controller.signal,
    run: () => ({ promise: new Promise<string>(() => {}), cancel: () => { cancelled++; } }) });
  controller.abort();
  assert.deepEqual(await pending, { kind: 'cancelled' });
  assert.equal(cancelled, 1);
  assert.deepEqual(budget.snapshot(), { running: 0, queued: 0, waiters: 0 });
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

test('a request that expires while queued settles timeout and never runs', async (t) => {
  // Mock both setTimeout AND Date so the deadline timer and the absolute-deadline
  // check advance in lockstep: with real clocks the running unit's timer and the
  // queued unit's timer are due within microseconds and the dispatch/expiry order
  // races. A single deterministic tick past the shared deadline removes the flake.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const budget = createProjectionAdmission({ C: 1, Q: 4, W: 4, D: 40 });
  const g = gate();
  let queuedRan = false;
  const running = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'run',
    run: () => ({ promise: g.promise, cancel: () => {} }),
  });
  const queued = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'wait',
    run: () => { queuedRan = true; return { promise: Promise.resolve('v'), cancel: () => {} }; },
  });
  t.mock.timers.tick(41); // past the shared deadline: running frees its slot, queued expires unrun
  assert.deepEqual(await queued, { kind: 'timeout' });
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

test('the deadline timer grants the full duration when the wall clock ticks during admission', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clockReads = 0;
  t.mock.method(Date, 'now', () => (++clockReads === 1 ? 1000 : 1001));
  const budget = createProjectionAdmission({ C: 1, Q: 0, W: 0, D: 100 });
  let settled = false;
  const outcome = budget.admit<string>({
    workload: 'clip', localConcurrency: 1,
    run: () => ({ promise: new Promise<string>(() => {}), cancel: () => {} }),
  }).then((value) => { settled = true; return value; });
  t.mock.timers.tick(99);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await outcome, { kind: 'timeout' });
  await budget.close();
});

test('an internal interface deadline does not extend clip running or queue wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const budget = createProjectionAdmission({ C: 1, Q: 2, W: 0, D: 100 });
  const interfaceGate = gate();
  let interfaceCancelled = false;
  let queuedClipRan = false;
  const interfaceWork = budget.admit<string>({ workload: 'interface', localConcurrency: 1,
    deadlineMs: 250,
    run: () => ({ promise: interfaceGate.promise, cancel: () => { interfaceCancelled = true; } }) });
  const queuedClip = budget.admit<string>({ workload: 'clip', localConcurrency: 1,
    run: () => { queuedClipRan = true; return { promise: Promise.resolve('clip'), cancel: () => {} }; } });
  t.mock.timers.tick(101);
  assert.deepEqual(await queuedClip, { kind: 'timeout' });
  assert.equal(queuedClipRan, false);
  assert.equal(interfaceCancelled, false);
  assert.deepEqual(budget.snapshot(), { running: 1, queued: 0, waiters: 0 });
  interfaceGate.resolve('interface');
  assert.deepEqual(await interfaceWork, { kind: 'ok', value: 'interface' });
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

test('a throwing cancel does not strand the leader or its waiters on close', async () => {
  // Regression: settle cancels before releasing the flight and resolving. A cancel
  // that throws must not skip that cleanup, or the leader hangs forever.
  const budget = createProjectionAdmission({ C: 1, Q: 8, W: 8, D: 60_000 });
  const leader = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'K',
    run: () => ({ promise: new Promise<string>(() => {}), cancel: () => { throw new Error('cancel blew up'); } }),
  });
  const waiter = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'K',
    run: () => ({ promise: new Promise<string>(() => {}), cancel: () => {} }),
  });
  await budget.close();
  assert.deepEqual(await leader, { kind: 'closed' });
  assert.deepEqual(await waiter, { kind: 'closed' });
  assert.deepEqual(budget.snapshot(), { running: 0, queued: 0, waiters: 0 });
});

test('identical keys across different workloads never coalesce', async () => {
  // Regression: a key-only flight map would hand the interface waiter the clip
  // leader's result, despite their different declared result types.
  const budget = createProjectionAdmission({ C: 2, Q: 8, W: 8, D: 60_000 });
  let ifaceRan = false;
  const clip = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'K',
    run: () => ({ promise: Promise.resolve('clip-value'), cancel: () => {} }),
  });
  const iface = budget.admit<string>({
    workload: 'iface', localConcurrency: 1, key: 'K',
    run: () => { ifaceRan = true; return { promise: Promise.resolve('iface-value'), cancel: () => {} }; },
  });
  assert.deepEqual(await clip, { kind: 'ok', value: 'clip-value' });
  assert.deepEqual(await iface, { kind: 'ok', value: 'iface-value' });
  assert.equal(ifaceRan, true);
  await budget.close();
});

test('close does not dispatch a queued compute', async () => {
  // Regression: pump() must refuse to run while closed, or shutdown starts (and
  // then immediately cancels) queued work.
  const budget = createProjectionAdmission({ C: 1, Q: 4, W: 4, D: 60_000 });
  const g = gate();
  let queuedRan = false;
  const active = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'a',
    run: () => ({ promise: g.promise, cancel: () => {} }),
  });
  const queued = budget.admit<string>({
    workload: 'clip', localConcurrency: 1, key: 'b',
    run: () => { queuedRan = true; return { promise: Promise.resolve('v'), cancel: () => {} }; },
  });
  await budget.close();
  assert.deepEqual(await active, { kind: 'closed' });
  assert.deepEqual(await queued, { kind: 'closed' });
  assert.equal(queuedRan, false);
});

test('a compute that rejects after its deadline settles timeout, not error', async () => {
  // Regression: only the success path checked the absolute deadline. A rejection
  // whose microtask beats the overdue timer must still settle timeout.
  const budget = createProjectionAdmission({ C: 1, Q: 1, W: 1, D: 20 });
  const g = gate();
  const p = budget.admit<string>({
    workload: 'clip', localConcurrency: 1,
    run: () => ({ promise: g.promise, cancel: () => {} }),
  });
  // Spin past the deadline WITHOUT yielding, so the deadline timer (a macrotask)
  // has not fired; then reject synchronously so its microtask runs first.
  const until = Date.now() + 40;
  while (Date.now() < until) { /* busy-wait */ }
  g.reject(new Error('worker died'));
  assert.deepEqual(await p, { kind: 'timeout' });
  await budget.close();
});

test('flight keys are injective across delimiter-bearing workloads and keys', async () => {
  // Regression: a bare delimiter join collides (a, "b\0c") with ("a\0b", c); the
  // length-prefixed key must keep them as two separate computes.
  const budget = createProjectionAdmission({ C: 2, Q: 8, W: 8, D: 60_000 });
  let bothRan = 0;
  const first = budget.admit<string>({
    workload: 'a', localConcurrency: 2, key: 'b\u0000c',
    run: () => { bothRan++; return { promise: Promise.resolve('first'), cancel: () => {} }; },
  });
  const second = budget.admit<string>({
    workload: 'a\u0000b', localConcurrency: 2, key: 'c',
    run: () => { bothRan++; return { promise: Promise.resolve('second'), cancel: () => {} }; },
  });
  assert.deepEqual(await first, { kind: 'ok', value: 'first' });
  assert.deepEqual(await second, { kind: 'ok', value: 'second' });
  assert.equal(bothRan, 2); // neither coalesced onto the other
  await budget.close();
});

test('a reentrant close inside run() does not leak an unhandled rejection', async () => {
  // Regression: on reentrant settle the returned handle is untracked; its late
  // rejection must be absorbed, not escape as an unhandledRejection that crashes.
  const caught: unknown[] = [];
  const onUnhandled = (e: unknown): void => { caught.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const budget = createProjectionAdmission({ C: 1, Q: 4, W: 4, D: 60_000 });
    const outcome = await budget.admit<string>({
      workload: 'clip', localConcurrency: 1,
      run: () => {
        void budget.close(); // settles this very unit reentrantly, mid-run
        return { promise: Promise.reject(new Error('worker died after close')), cancel: () => {} };
      },
    });
    assert.deepEqual(outcome, { kind: 'closed' });
    await later(10); // let any stray rejection surface
    assert.deepEqual(caught, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a synchronous throw after the deadline settles timeout, not error', async () => {
  // Regression: run()'s catch unconditionally settled error; a throw after the
  // deadline must settle timeout, mirroring the async rejection path.
  const budget = createProjectionAdmission({ C: 1, Q: 1, W: 1, D: 20 });
  const outcome = await budget.admit<string>({
    workload: 'clip', localConcurrency: 1,
    run: () => {
      const until = Date.now() + 40;
      while (Date.now() < until) { /* spin past the deadline before throwing */ }
      throw new Error('worker died synchronously');
    },
  });
  assert.deepEqual(outcome, { kind: 'timeout' });
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
