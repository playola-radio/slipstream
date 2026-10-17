import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGate, latencyStats, parseMemSize, parseTopLog, summarizeTop } from './analysis.ts';

const TOP_LOG = `Processes: 1452 total, 4 running, 1448 sleeping, 8002 threads
2026/10/17 11:00:29
Load Avg: 4.00, 4.69, 4.98

PID    %CPU #TH MEM IDLEW CSW
90371  0.0  7   11M 2     325
Processes: 1452 total, 4 running, 1448 sleeping, 8002 threads
2026/10/17 11:00:30

PID    %CPU #TH MEM IDLEW CSW
90371  1.5  9   11M+ 2     395+
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
