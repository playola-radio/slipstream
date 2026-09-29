import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeDiagnosticMode, parseDiagnosticArgs, validateDiagnosticConfig } from './fd5-diag.ts';
import { acquireWithin, executionApprovalFaults, planInterfaceCohort, scoreInterfaceCohort,
  readPrior, runBoundedDiagnostic, scoreDiagnosticOverhead } from './fd5-diag-run.ts';
import type { CaptureArmReport } from '../src/clip-bench.ts';
import type { CorpusPage } from './fd5-bench.ts';
import type { InterfaceAttempt } from './fd5-score.ts';

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
  assert.equal(config.protocol, 'fd5-bounded-diagnostic.v2-proposal');
  assert.equal(config.interfaceScorer, 'terminal200-first180-v2');
  assert.throws(() => validateDiagnosticConfig({ ...config, interfaceScorer: 'ready-only-v1' }), /interfaceScorer/);
});

test('v1 and mismatched v2 prior chains cannot authorize the next mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fd5-prior-test-'));
  const path = join(dir, 'prior.jsonl');
  const prior = (scorerVersion: string, configSha256 = 'same') => [
    { type: 'started', mode: 'smoke', revision: 'same', configSha256, scorerVersion },
    { type: 'final', diagnosticValid: true },
  ].map(record => JSON.stringify(record)).join('\n') + '\n';
  try {
    await writeFile(path, prior('ready-only-v1'));
    await assert.rejects(readPrior(path, 'overhead', 'same', 'same'), /another head\/config/);
    await writeFile(path, prior('terminal200-first180-v2', 'other'));
    await assert.rejects(readPrior(path, 'overhead', 'same', 'same'), /another head\/config/);
    await writeFile(path, prior('terminal200-first180-v2'));
    assert.deepEqual(await readPrior(path, 'overhead', 'same', 'same'), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
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
  const plan = planInterfaceCohort(corpus());
  const report = (p95: number) => ({ capture: ({ latency: { n: 100, p50: p95, p95, p99: p95 },
    throughputPerSecond: 100 } as CaptureArmReport), requestLatency: { n: 100, p50: p95, p95, p99: p95 },
    interfaceCohort: scoreInterfaceCohort(plan, attempts(corpus(), p95)) });
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

function corpus(): CorpusPage[] {
  const languages = ['typescript', 'tsx', 'swift'] as const;
  return Array.from({ length: 181 }, (_, i) => ({ limit: [1, 4, 16][Math.floor(i / 3) % 3] as 1 | 4 | 16,
    expected: { key: `key-${i}`, routeKey: `/interface/${i}`, language: languages[i % 3]!,
      sizeClass: Math.floor(i / 9) % 2 ? 'representative' : 'tiny', sessionId: `session-${i}`,
      beforeSeq: '1', afterSeq: '2', files: [] } }));
}
function attempts(pages: CorpusPage[], duration = 100): InterfaceAttempt[] {
  return pages.map((page, i) => ({ requestId: `r${i}`, expected: page.expected,
    startedAtNs: BigInt(i) * 1_000_000_000n,
    completedAtNs: BigInt(i) * 1_000_000_000n + BigInt(duration) * 1_000_000n,
    httpStatus: 200, body: { status: 'ready', files: [{ status: 'ready' }] } }));
}
test('predeclared interface cohort contains ten of every language, size and page cell', () => {
  const plan = planInterfaceCohort(corpus());
  assert.equal(plan.length, 180);
  assert.equal(new Set(plan.map(row => `${row.language}/${row.sizeClass}/${row.limit}`)).size, 18);
  assert(plan.every(row => plan.filter(other => other.cell === row.cell).length === 10));
  assert.equal(plan.some(row => row.key === 'key-180'), false);
});
test('fixed interface cohort rejects shortfall, duplicate, wrong source and HTTP errors', () => {
  const plan = planInterfaceCohort(corpus());
  const all = attempts(corpus());
  assert.equal(scoreInterfaceCohort(plan, all).valid, true);
  assert.match(scoreInterfaceCohort(plan, all.slice(1)).faults.join(' '), /missing.*key-0/);
  assert.match(scoreInterfaceCohort(plan, all.slice(0, 100)).faults.join(' '), /shortfall: 80/);
  assert.match(scoreInterfaceCohort(plan, [...all, all[0]!]).faults.join(' '), /duplicate.*key-0/);
  const wrong = structuredClone(all); wrong[0]!.expected.sessionId = 'wrong';
  assert.match(scoreInterfaceCohort(plan, wrong).faults.join(' '), /identity mismatch/);
  const failed = structuredClone(all); failed[0]!.httpStatus = 500;
  assert.match(scoreInterfaceCohort(plan, failed).faults.join(' '), /HTTP outcome/);
});
test('all terminal 200s count, including slow partials and skipped; extras cannot move cohort', () => {
  const plan = planInterfaceCohort(corpus());
  const off = attempts(corpus());
  const on = attempts(corpus());
  off[179]!.body = { status: 'partial', fallback_reason: 'timeout', files: [] };
  off[179]!.completedAtNs = off[179]!.startedAtNs + 900_000_000n;
  on[179]!.body = { status: 'skipped', fallback_reason: 'overloaded', files: [] };
  on[179]!.completedAtNs = on[179]!.startedAtNs + 800_000_000n;
  on[180]!.completedAtNs = on[180]!.startedAtNs + 10_000_000_000n;
  const a = scoreInterfaceCohort(plan, off), b = scoreInterfaceCohort(plan, on);
  assert.equal(a.httpLatency.n, 180);
  assert.equal(a.httpLatency.p99, 100);
  assert.equal(a.httpLatency.p100, 900);
  assert.equal(b.httpLatency.p99, 100);
  assert.equal(b.fullArm.httpLatency.p100, 10_000);
  assert.equal(a.readyCount, 179);
  assert.equal(b.transitionsByKey.length, 180);
  assert.equal(a.unfinishedCompletionCount, 1);
});
test('interface ready loss fails despite faster HTTP, zero reference invalid, clip capture gate stays', () => {
  const plan = planInterfaceCohort(corpus());
  const off = scoreInterfaceCohort(plan, attempts(corpus(), 100));
  const onAttempts = attempts(corpus(), 50);
  for (let i = 0; i < 12; i++) onAttempts[i]!.body = { status: 'skipped', fallback_reason: 'overloaded', files: [] };
  const on = scoreInterfaceCohort(plan, onAttempts);
  const capture = (p50: number) => ({ latency: { n: 200, p50, p95: 100, p99: 100 },
    throughputPerSecond: 100 } as CaptureArmReport);
  const report = (p50: number, cohort: typeof off) => ({ capture: capture(p50),
    requestLatency: { n: 180, p50: 100, p95: 100, p99: 100 }, interfaceCohort: cohort });
  const rows = [report(100, off), report(100, on), report(100, on), report(100, off),
    ...Array.from({ length: 4 }, () => report(100, off))];
  rows[5] = report(100, on);
  const tolerance = { approved: true as const,
    maxCaptureLatencyRatio: { p50: 1.05, p95: 1.1, p99: 1.2 },
    maxRequestLatencyRatio: { p50: 1.05, p95: 1.1, p99: 1.2 },
    minCaptureThroughputRatio: 0.95, minReadyRatio: 0.95 };
  assert.equal(scoreDiagnosticOverhead(rows, tolerance)[2]!.passed, false);
  rows[1] = report(110.3, off);
  assert.equal(scoreDiagnosticOverhead(rows, tolerance)[0]!.passed, false);
  const zero = attempts(corpus()); for (const item of zero) item.body = { status: 'skipped', fallback_reason: 'overloaded', files: [] };
  rows[1] = report(100, off); rows[4] = report(100, scoreInterfaceCohort(plan, zero));
  assert.equal(scoreDiagnosticOverhead(rows, tolerance)[2]!.passed, false);
});
