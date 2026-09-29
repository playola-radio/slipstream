import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { describeDiagnosticMode, parseDiagnosticArgs, validateDiagnosticConfig } from './fd5-diag.ts';
import { acquireWithin, executionApprovalFaults, runBoundedDiagnostic, scoreDiagnosticOverhead } from './fd5-diag-run.ts';
import type { CaptureArmReport } from '../src/clip-bench.ts';

const proposal = JSON.parse(await readFile(new URL('./fd5-diagnostic-config.json', import.meta.url), 'utf8')) as unknown;

test('bounded diagnostic CLI requires one named mode and an explicit execution switch', () => {
  assert.deepEqual(parseDiagnosticArgs(['--config', 'proposed.json', '--mode', 'smoke', '--describe']),
    { configPath: 'proposed.json', mode: 'smoke', describe: true });
  assert.deepEqual(parseDiagnosticArgs(['--config', 'approved.json', '--mode', 'w-pressure',
    '--out', '/tmp/new.jsonl', '--prior', '/tmp/queue.jsonl', '--execute']),
  { configPath: 'approved.json', mode: 'w-pressure', outputPath: '/tmp/new.jsonl',
    priorPath: '/tmp/queue.jsonl', describe: false });
  for (const argv of [
    ['--config', 'x', '--mode', 'smoke'],
    ['--config', 'x', '--mode', 'full', '--describe'],
    ['--config', 'x', '--mode', 'smoke', '--execute'],
    ['--config', 'x', '--mode', 'smoke', '--describe', '--execute'],
    ['--config', 'x', '--mode', 'smoke', '--describe', '--unknown'],
    ['--config', 'x', '--mode', 'queue', '--out', '/tmp/q', '--execute'],
  ]) assert.throws(() => parseDiagnosticArgs(argv));
});

test('configuration pins bounded counts, separate modes and approval fields', () => {
  const config = validateDiagnosticConfig(proposal);
  assert.deepEqual(describeDiagnosticMode(config, 'smoke'), { arms: 2, writes: 28, maxRequests: 128 });
  assert.deepEqual(describeDiagnosticMode(config, 'overhead'), { arms: 8, writes: 1600,
    maxRequests: 9600, perArmGuard: 5000 });
  assert.deepEqual(describeDiagnosticMode(config, 'unqueued'), { cells: 7, measured: 350,
    warmups: 2, cacheControlsMaximum: 60, conditionalSwiftMaximum: 150, maxRequests: 562 });
  assert.deepEqual(describeDiagnosticMode(config, 'queue'), { cells: 6, writes: 1200, maxRequests: 14400,
    perCellGuard: 5000,
    maxCellSecondsIncludingDrain: 30 });
  assert.deepEqual(describeDiagnosticMode(config, 'w-pressure'), { groups: 40, maxRequests: 200,
    maxSecondsPerCap: 15 });
  assert.throws(() => validateDiagnosticConfig({ ...(proposal as object), repetitions: 3 }), /unknown/);
  assert.throws(() => validateDiagnosticConfig({ ...(proposal as object), overhead: {
    ...(proposal as { overhead: object }).overhead, maxArmSeconds: 300,
  } }), /maxArmSeconds/);
  assert.throws(() => validateDiagnosticConfig({ ...(proposal as object), unqueued: {
    ...(proposal as { unqueued: object }).unqueued, maxRequestsIncludingConditional: 563,
  } }), /maxRequestsIncludingConditional/);
});

test('execute refuses unset owner decisions before creating output or measuring', async () => {
  const config = validateDiagnosticConfig(proposal);
  await assert.rejects(runBoundedDiagnostic(config, 'smoke', '/tmp/fd5-should-not-exist.jsonl'),
    /owner execution decisions are incomplete/);
});

test('explicit approvals reject denial and expired windows without running a mode', () => {
  const config = structuredClone(validateDiagnosticConfig(proposal));
  config.approvalRequired = {
    measurementWindow: { approved: true, hostVetoesApproved: true,
      startUtc: '2026-09-28T00:00:00Z', endUtc: '2026-09-28T02:00:00Z' },
    tracingOverheadTolerance: { approved: true,
      maxCaptureLatencyRatio: { p50: 1.05, p95: 1.05, p99: 1.05 },
      maxRequestLatencyRatio: { p50: 1.05, p95: 1.05, p99: 1.05 },
      minCaptureThroughputRatio: 0.95, minReadyRatio: 0.95 },
    diagnosticDeadlinePoints: { approved: true, interfaceMs: [400, 800],
      conditional800: true, cellsAndCountsApproved: true },
    wPressureRuntimeHook: { approved: true },
    clipHistoricalComparison: { approved: true, treatment: 'historical-only' },
  };
  assert.deepEqual(executionApprovalFaults(config, Date.parse('2026-09-28T01:00:00Z')), []);
  assert.match(executionApprovalFaults(config, Date.parse('2026-09-28T03:00:00Z')).join(' '), /window/);
  config.approvalRequired.wPressureRuntimeHook = { approved: false };
  assert.match(executionApprovalFaults(config, Date.parse('2026-09-28T01:00:00Z')).join(' '), /W runtime/);
});

test('late startup after a wall cap invokes ownership cleanup', async () => {
  const controller = new AbortController();
  let finish!: (value: number) => void;
  const startup = new Promise<number>(resolve => { finish = resolve; });
  const cleaned: number[] = [];
  const pending = acquireWithin(startup, controller.signal, async value => { cleaned.push(value); });
  controller.abort(new Error('cap'));
  finish(7);
  await assert.rejects(pending, /cap/);
  assert.deepEqual(cleaned, [7]);
});

test('overhead comparison pairs off/on and on/off within each workload', () => {
  const report = (p95: number) => ({ capture: ({ latency: { n: 100, p50: p95, p95, p99: p95 },
    throughputPerSecond: 100 } as CaptureArmReport), requestLatency: { n: 100, p50: p95, p95, p99: p95 } });
  const reports = [report(10), report(11), report(11), report(10), report(10), report(11), report(11), report(10)];
  const tolerance = { approved: true as const,
    maxCaptureLatencyRatio: { p50: 1.1, p95: 1.1, p99: 1.1 },
    maxRequestLatencyRatio: { p50: 1.1, p95: 1.1, p99: 1.1 },
    minCaptureThroughputRatio: 0.95, minReadyRatio: 0.95 };
  assert.equal(scoreDiagnosticOverhead(reports, tolerance).length, 4);
  assert(scoreDiagnosticOverhead(reports, tolerance).every(item => item.passed));
  assert(scoreDiagnosticOverhead(reports, { ...tolerance,
    maxRequestLatencyRatio: { p50: 1.05, p95: 1.05, p99: 1.05 } }).every(item => !item.passed));
});
