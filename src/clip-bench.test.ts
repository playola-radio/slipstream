import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWriter, scoreCaptureArm, waitForQuietCapture } from './clip-bench.ts';
import type { CaptureSession } from './session.ts';
import type { ClipResponse } from './clip-bench.ts';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ns = (ms: number) => BigInt(ms) * 1_000_000n;

test('diagnostic quiet drain aborts without leaving a health subscriber', async () => {
  const controller = new AbortController();
  let active = 0;
  const session = { health: { subscribe: () => { active++; return () => { active--; }; } } } as unknown as CaptureSession;
  const waiting = waitForQuietCapture(session, controller.signal);
  controller.abort();
  assert.equal(await waiting, false);
  assert.equal(active, 0);
});

test('writer streams each completed write and abort retains its partial evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-writer-abort-'));
  const controller = new AbortController();
  const observed: string[] = [];
  try {
    await assert.rejects(runWriter(root, 0, { repetitions: 1, scheduledWrites: 5,
      scheduledIntervalMs: 100, burstWrites: 0, concurrentClipRequests: 0, corpusChanges: 1 },
    { signal: controller.signal, onWrite: write => {
      observed.push(write.path);
      if (observed.length === 1) controller.abort();
    } }), /aborted/);
    assert.deepEqual(observed, ['scheduled-0-0.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('writer abort waits for the worker to exit and stops scheduled writes promptly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-writer-exit-'));
  const controller = new AbortController();
  const observed: string[] = [];
  const abortAt = Date.now();
  try {
    await assert.rejects(runWriter(root, 0, { repetitions: 1, scheduledWrites: 20,
      scheduledIntervalMs: 50, burstWrites: 0, concurrentClipRequests: 0, corpusChanges: 1 },
    { signal: controller.signal, requireExit: true, onWrite: write => {
      observed.push(write.path);
      if (observed.length === 1) controller.abort();
    } }), /aborted/);
    assert.ok(Date.now() - abortAt < 1_000);
    assert.deepEqual(await readdir(root), ['scheduled-0-0.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
function loadScenario(responses: ClipResponse[], durableMs = 3_000) {
  const keyed = responses.map((r, i) => ({ ...r, key: r.key ?? `key-${i}` }));
  return scoreCaptureArm({
    name: 'saturation',
    writes: [{ path: 'one.ts', sha256: 'a', startedAtNs: ns(1_000), phase: 'scheduled' }],
    records: [{ type: 'slipstream.file.changed.v1', seq: '1', data: { path: 'one.ts', after: { kind: 'content', sha256: 'a' } } }],
    durableAtNsBySeq: new Map([['1', ns(durableMs)]]),
    clipResponses: keyed,
    requestedClipKeys: keyed.map(r => r.key),
    concurrentClipRequests: 16, maxConcurrentRequests: 16, coldCacheServerFresh: true,
    loadStartedAtNs: ns(0), loadStoppedAtNs: ns(4_000),
  });
}
const continuousResponses = (): ClipResponse[] => Array.from({ length: 40 }, (_, i) => [
  { httpStatus: 200, status: 'ready', latencyMs: 100, startedAtNs: ns(i * 100), completedAtNs: ns((i + 1) * 100) },
  { httpStatus: 200, status: 'skipped', reason: 'overloaded', latencyMs: 100, startedAtNs: ns(i * 100), completedAtNs: ns((i + 1) * 100) },
]).flat();

test('accepts continuous requests with completed cold parses and overload in every time window', () => {
  assert.equal(loadScenario(continuousResponses()).load.sufficient, true);
});

test('sequential retries stay cold only after an explicit uncached overload', () => {
  const responses = continuousResponses();
  responses[0] = { ...responses[0]!, key: 'retry', status: 'skipped', reason: 'overloaded' };
  responses[2] = { ...responses[2]!, key: 'retry' };
  assert.equal(loadScenario(responses).load.sufficient, true);
  // A previous successful response might be cached; any other prior outcome is
  // retired too. An overlap could coalesce with an admitted request instead.
  for (const previous of [
    { status: 'ready', reason: undefined },
    { status: 'skipped', reason: 'timeout' },
  ]) {
    const changed = [...responses];
    changed[0] = { ...responses[0]!, ...previous };
    assert.equal(loadScenario(changed).load.sufficient, false);
  }
  responses[2] = { ...responses[2]!, startedAtNs: ns(50) };
  assert.equal(loadScenario(responses).load.sufficient, false);
});

test('rejects idle gaps even when load lifecycle, peak concurrency and one parse look sufficient', () => {
  const report = loadScenario(continuousResponses().filter(r => r.completedAtNs! <= ns(1_100)));
  assert.equal(report.load.sufficient, false);
  assert.match(report.load.reasons.join(' '), /continuous|window/);
});

test('late durable samples remain in the percentiles and invalidate load ending before drain', () => {
  const report = loadScenario(continuousResponses(), 5_000);
  assert.equal(report.captured, 1);
  assert.equal(report.latency.p99, 4_000);
  assert.equal(report.load.sufficient, false);
  assert.equal(report.load.overlap, false);
});

test('scores latency at the durable-sequence boundary and discloses a missing write', () => {
  const report = scoreCaptureArm({
    name: 'saturation',
    writes: [
      { path: 'one.ts', sha256: 'a'.repeat(64), startedAtNs: 1_000_000n, phase: 'scheduled' },
      { path: 'missing.ts', sha256: 'b'.repeat(64), startedAtNs: 2_000_000n, phase: 'burst' },
    ],
    records: [
      {
        type: 'slipstream.file.changed.v1',
        data: { path: 'one.ts', after: { kind: 'content', sha256: 'a'.repeat(64) } },
        seq: '7',
        // Event time is deliberately implausible: scoring must not read it.
        time: '1970-01-01T00:00:00.000Z',
      },
    ],
    durableAtNsBySeq: new Map([['7', 6_000_000n]]),
    clipResponses: [
      { httpStatus: 200, status: 'skipped', reason: 'overloaded', latencyMs: 12 },
      { httpStatus: 200, status: 'skipped', reason: 'overloaded', latencyMs: 3 },
    ],
    requestedClipKeys: ['historic/1', 'historic/2'],
    concurrentClipRequests: 16,
    coldCacheServerFresh: true,
  });

  assert.equal(report.captured, 1);
  assert.equal(report.missing, 1);
  assert.equal(report.latency.p50, 5);
  assert.equal(report.latency.p99, 5);
  assert.equal(report.clipResponses.byStatus['200 skipped'], 2);
  assert.equal(report.clipResponses.byReason.overloaded, 2);
  assert.equal(report.load.sufficient, false);
  assert.match(report.load.reasons.join(' '), /non-skipped/);
});

test('rejects duplicated clip keys as a cold-cache protocol failure', () => {
  const report = scoreCaptureArm({
    name: 'saturation',
    writes: [],
    records: [],
    durableAtNsBySeq: new Map(),
    clipResponses: Array.from({ length: 16 }, () => ({ httpStatus: 200, status: 'ready', latencyMs: 1 })),
    requestedClipKeys: Array.from({ length: 16 }, () => 'historic/1'),
    concurrentClipRequests: 16,
    coldCacheServerFresh: true,
  });

  assert.equal(report.load.sufficient, false);
  assert.match(report.load.reasons.join(' '), /repeated a content key/);
});

test('reports isolated scheduled and burst capture latency separately', () => {
  const report = scoreCaptureArm({
    name: 'baseline',
    writes: [
      { path: 'scheduled.ts', sha256: 'c'.repeat(64), startedAtNs: 0n, phase: 'scheduled' },
      { path: 'burst.ts', sha256: 'd'.repeat(64), startedAtNs: 0n, phase: 'burst' },
    ],
    records: [
      { type: 'slipstream.file.changed.v1', seq: '1', data: { path: 'scheduled.ts', after: { kind: 'content', sha256: 'c'.repeat(64) } } },
      { type: 'slipstream.file.changed.v1', seq: '2', data: { path: 'burst.ts', after: { kind: 'content', sha256: 'd'.repeat(64) } } },
    ],
    durableAtNsBySeq: new Map([['1', 20_000_000n], ['2', 100_000_000n]]),
    clipResponses: [],
    requestedClipKeys: [],
    concurrentClipRequests: 0,
  });

  assert.equal(report.scheduledLatency.p50, 20);
  assert.equal(report.burstLatency.p99, 100);
});
