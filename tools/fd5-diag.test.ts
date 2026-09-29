import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { describeDiagnosticMode, parseDiagnosticArgs, validateDiagnosticConfig } from './fd5-diag.ts';
import { runBoundedDiagnostic, scoreDiagnosticOverhead } from './fd5-diag-run.ts';
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
  assert.deepEqual(describeDiagnosticMode(config, 'overhead'), { arms: 8, writes: 1600, maxRequests: 40000 });
  assert.deepEqual(describeDiagnosticMode(config, 'unqueued'), { cells: 7, measured: 350,
    warmups: 2, cacheControlsMaximum: 60, conditionalSwiftMaximum: 150, maxRequests: 562 });
  assert.deepEqual(describeDiagnosticMode(config, 'queue'), { cells: 6, writes: 1200, maxRequests: 30000,
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

test('overhead comparison pairs off/on and on/off within each workload', () => {
  const report = (p95: number): CaptureArmReport => ({ latency: { n: 100, p50: p95, p95, p99: p95 },
    throughputPerSecond: 100 } as CaptureArmReport);
  const reports = [report(10), report(11), report(11), report(10), report(10), report(11), report(11), report(10)];
  const tolerance = { maxLatencyRatio: { p50: 1.1, p95: 1.1, p99: 1.1 }, minThroughputRatio: 0.95 };
  assert.equal(scoreDiagnosticOverhead(reports, tolerance).length, 4);
  assert(scoreDiagnosticOverhead(reports, tolerance).every(item => item.passed));
  assert(scoreDiagnosticOverhead(reports, { ...tolerance,
    maxLatencyRatio: { p50: 1.05, p95: 1.05, p99: 1.05 } }).every(item => !item.passed));
});
