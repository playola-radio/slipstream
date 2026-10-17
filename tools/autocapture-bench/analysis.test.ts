import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coveredFraction, evaluateGate, joinLatencies, latencyStats, latencyVerdict, parseMemSize, parseTopLog, settledVerdict, summarizeTop } from './analysis.ts';

const TOP_LOG = `Processes: 1452 total, 4 running, 1448 sleeping, 8002 threads
2026/10/17 11:00:29
Load Avg: 4.00, 4.69, 4.98

PID    %CPU #TH MEM IDLEW CSW
90371  0.0  7   11M 2     325
Processes: 1452 total, 4 running, 1448 sleeping, 8002 threads
2026/10/17 11:00:30

PID    %CPU #TH MEM IDLEW CSW
90371  1.5  9/1 11M+ 2     395+
Processes: 1452 total, 4 running, 1448 sleeping, 8002 threads

PID    %CPU #TH MEM IDLEW CSW
90371  0.5  9   1.5G- 5+    465+
PID    %CPU #TH MEM IDLEW CSW
`;

test('top log rows parse into samples, ignoring header blocks and empty trailing samples', () => {
  assert.deepEqual(parseTopLog(TOP_LOG, 90371), [
    { cpuPercent: 0, threads: 7, memBytes: 11 * 2 ** 20, idleWakeups: 2, contextSwitches: 325 },
    { cpuPercent: 1.5, threads: 9, memBytes: 11 * 2 ** 20, idleWakeups: 2, contextSwitches: 395 },
    { cpuPercent: 0.5, threads: 9, memBytes: 1.5 * 2 ** 30, idleWakeups: 5, contextSwitches: 465 },
  ]);
});

test('rows for another pid are not counted', () => {
  assert.deepEqual(parseTopLog(TOP_LOG, 1234), []);
});

test('memory sizes carry binary units', () => {
  assert.equal(parseMemSize('512K'), 512 * 1024);
  assert.equal(parseMemSize('13M'), 13 * 2 ** 20);
  assert.equal(parseMemSize('2G'), 2 * 2 ** 30);
  assert.equal(parseMemSize('100B'), 100);
});

test('the first top sample is dropped because its CPU column has no interval behind it', () => {
  const summary = summarizeTop(parseTopLog(TOP_LOG, 90371), 1);
  assert.equal(summary.samples, 2);
  assert.equal(summary.cpuMeanPercent, 1);
  assert.equal(summary.cpuP95Percent, 1.5);
});

test('wakeup rates come from cumulative counter deltas over the sampled interval', () => {
  const summary = summarizeTop(parseTopLog(TOP_LOG, 90371), 1);
  assert.equal(summary.contextSwitchesPerSecond, 70);
  assert.equal(summary.idleWakeupsPerSecond, 1.5);
  assert.equal(summary.maxMemBytes, 1.5 * 2 ** 30);
  assert.equal(summary.maxThreads, 9);
});

test('latency stats use nearest rank and report sample count', () => {
  const s = latencyStats([5, 1, 4, 2, 3]);
  assert.deepEqual(s, { n: 5, p50: 3, p95: 5, p99: 5, max: 5 });
  assert.deepEqual(latencyStats([]), { n: 0, p50: null, p95: null, p99: null, max: null });
});

test('a gate passes at or under its threshold and fails over it', () => {
  assert.equal(evaluateGate({ measured: 1, threshold: 1 }), 'PASS');
  assert.equal(evaluateGate({ measured: 1.01, threshold: 1 }), 'FAIL');
});

test('a bracketed measurement is inconclusive when the threshold sits inside the bracket', () => {
  assert.equal(evaluateGate({ lower: 2, upper: 9, threshold: 10 }), 'PASS');
  assert.equal(evaluateGate({ lower: 11, upper: 90, threshold: 10 }), 'FAIL');
  assert.equal(evaluateGate({ lower: 2, upper: 90, threshold: 10 }), 'INCONCLUSIVE');
});

test('a gate with no measurement is unmeasured, never a pass', () => {
  assert.equal(evaluateGate({ threshold: 10 }), 'UNMEASURED');
});

test('an absent or non-finite measurement is unmeasured, never coerced to a pass', () => {
  assert.equal(evaluateGate({ measured: null, threshold: 10 }), 'UNMEASURED');
  assert.equal(evaluateGate({ measured: Number.NaN, threshold: 10 }), 'UNMEASURED');
});

test('an unsettled window can confirm a pass on a cost gate but not a failure', () => {
  assert.equal(settledVerdict('PASS', { settled: false, costOnly: true }), 'PASS');
  assert.equal(settledVerdict('FAIL', { settled: false, costOnly: true }), 'INCONCLUSIVE');
  assert.equal(settledVerdict('FAIL', { settled: true, costOnly: true }), 'FAIL');
});

test('an unsettled window invalidates a comparison gate either way', () => {
  assert.equal(settledVerdict('PASS', { settled: false, costOnly: false }), 'INCONCLUSIVE');
});

test('baseline coverage counts the writes that landed inside a running baseline', () => {
  const intervals = [{ startNs: 10n, endNs: 20n }, { startNs: 22n, endNs: 40n }];
  assert.equal(coveredFraction([12n, 21n, 30n, 45n], intervals), 0.5);
});

test('coverage of no writes is zero, not a full pass', () => {
  assert.equal(coveredFraction([], [{ startNs: 0n, endNs: 10n }]), 0);
});

test('latency regression is judged only when both arms observed their writes and the baseline covered arm B', () => {
  const ok = { regression: 0.1, missingFractionA: 0, missingFractionB: 0.005, coverage: 0.99 };
  assert.deepEqual(latencyVerdict(ok), { verdict: 'PASS' });
  assert.deepEqual(latencyVerdict({ ...ok, regression: 0.3 }), { verdict: 'FAIL' });
});

test('latency regression with lost writes is inconclusive, however good the surviving p99', () => {
  const r = latencyVerdict({ regression: 0, missingFractionA: 0, missingFractionB: 0.5, coverage: 1 });
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.match(r.note!, /50\.0% of arm B writes/);
});

test('latency regression with arm B only partly under a baseline is inconclusive', () => {
  const r = latencyVerdict({ regression: 0, missingFractionA: 0, missingFractionB: 0, coverage: 0.1 });
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.match(r.note!, /10\.0% of arm B writes/);
});

test('capture latency joins each write to its change record and the first durable advance covering it', () => {
  const r = joinLatencies({
    writes: [
      { sessionId: 'a', sha256: 'h1', writtenNs: 1_000_000_000n },
      { sessionId: 'b', sha256: 'h2', writtenNs: 1_000_000_000n },
      { sessionId: 'a', sha256: 'h3', writtenNs: 2_000_000_000n },
    ],
    changes: [{ sessionId: 'a', seq: 5n, sha256: 'h1' }, { sessionId: 'b', seq: 9n, sha256: 'h2' }],
    timeline: [
      { sessionId: 'a', seq: 4n, ns: 1_010_000_000n },
      { sessionId: 'a', seq: 6n, ns: 1_050_000_000n },
      { sessionId: 'b', seq: 9n, ns: 1_200_000_000n },
    ],
  });
  assert.deepEqual(r.latenciesMs, [50, 200]);
  assert.deepEqual(r.perSessionMs, { a: [50], b: [200] });
  assert.equal(r.missing, 1, 'h3 never got its own change record (coalesced or not observed)');
});

test('a change whose durable advance was not recorded counts as missing, never as zero latency', () => {
  const r = joinLatencies({
    writes: [{ sessionId: 'a', sha256: 'h1', writtenNs: 10n }],
    changes: [{ sessionId: 'a', seq: 5n, sha256: 'h1' }],
    timeline: [],
  });
  assert.deepEqual(r.latenciesMs, []);
  assert.equal(r.missing, 1);
});
