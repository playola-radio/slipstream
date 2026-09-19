import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreCaptureArm } from './clip-bench.ts';

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
