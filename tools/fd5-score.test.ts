import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareCaptureToBaseline, scoreInterfaceLoad, validateInterfacePage,
  type AdmissionTrace, type ExpectedInterfaceRequest, type InterfaceAttempt, type InterfaceLoadInput } from './fd5-score.ts';

const ns = (ms: number): bigint => BigInt(ms) * 1_000_000n;
const languages = ['typescript', 'tsx', 'swift'] as const;
function expected(i: number, language = languages[i % 3]!): ExpectedInterfaceRequest {
  return { key: `unique-content-${i}`, language, sessionId: '11111111-1111-4111-8111-111111111111',
    beforeSeq: '3', afterSeq: '4', files: [{ path: `file-${i}.${language === 'swift' ? 'swift' : language === 'tsx' ? 'tsx' : 'ts'}`,
      language: language === 'swift' ? 'swift' : 'typescript', languageVersion: language === 'swift' ? 'swift.v1' : 'typescript.v2',
      beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), changes: [{ kind: 'signatureChanged', identity: { name: `f${i}` } }] }] };
}
function page(e: ExpectedInterfaceRequest): unknown {
  return { projection_version: 'interface.v2', session_id: e.sessionId,
    range: { before_seq: e.beforeSeq, after_seq: e.afterSeq }, status: 'ready',
    inventory: { scope: 'observed' }, analysis: { shared_types: 'notAnalyzed' }, gaps: [], gaps_complete: true,
    files: e.files.map(f => ({ path: f.path,
      before: { kind: 'baseline', snapshot: { kind: 'content', sha256: f.beforeSha256 } },
      after: { kind: 'recorded', snapshot: { kind: 'content', sha256: f.afterSha256 } },
      language: f.language, language_version: f.languageVersion, status: 'ready', changes: f.changes })),
    page: { complete: true, next_after_path: null } };
}
function passing(): InterfaceLoadInput {
  const attempts: InterfaceAttempt[] = [];
  const traces: AdmissionTrace[] = [];
  for (let i = 0; i < 30; i++) {
    const e = expected(i, languages[Math.floor(i / 2) % 3]!);
    const overloaded = i % 2 === 1;
    const start = ns(i * 100), completed = ns((i + 1) * 100);
    attempts.push({ requestId: `r${i}`, expected: e, startedAtNs: start, completedAtNs: completed,
      httpStatus: 200, body: overloaded ? { ...page(e) as object, status: 'skipped', fallback_reason: 'overloaded', files: [] } : page(e),
      freshness: overloaded ? 'none' : 'fresh' });
    traces.push({ requestId: `r${i}`, workload: 'interface', submittedAtNs: start,
      ...(overloaded ? {} : { admittedAtNs: start, startedAtNs: start }),
      settledAtNs: completed, outcome: overloaded ? 'overloaded' : 'ok' });
  }
  return { attempts, traces, corpusKeys: attempts.map(a => a.expected.key), maxConcurrentRequests: 16,
    freshServer: true, loadStartedAtNs: ns(0), loadStoppedAtNs: ns(3000), firstWriteAtNs: ns(0),
    lastDurableAtNs: ns(3000), corpusExhausted: false, attemptLimitReached: false, drained: true, cleanupComplete: true };
}

test('known trace passes with all languages, fresh comparisons, overload and continuous windows', () => {
  const report = scoreInterfaceLoad(passing());
  assert.deepEqual(report.reasons, []);
  assert.equal(report.sufficient, true);
  assert.equal(report.total.submitted, 30);
  assert.equal(report.total.admitted, 15);
  assert.equal(report.total.rejected, 15);
  assert.equal(report.total.usefulComparisons, 15);
  assert.equal(report.total.overloadFraction, 0.5);
  assert.equal(report.activityWindows.length, 3);
});

test('validates every row and source/version/change, rather than first row or ready alone', () => {
  const e = expected(0);
  e.files.push({ ...expected(1).files[0]!, path: 'second.tsx' });
  const good = page(e) as Record<string, unknown>;
  assert.deepEqual(validateInterfacePage(good, e), []);
  const rows = good.files as Record<string, unknown>[];
  rows[1]!.language_version = 'wrong';
  rows[1]!.changes = [];
  assert.match(validateInterfacePage(good, e).join(' '), /version mismatch.*change mismatch/);
  rows.pop();
  assert.match(validateInterfacePage(good, e).join(' '), /missing file/);
});

test('rejects malformed 200, HTTP failure, cache-only, empty, overload-only and missing language', () => {
  const variants: Array<[string, (x: InterfaceLoadInput) => void, RegExp]> = [
    ['malformed', x => { x.attempts[0]!.body = { status: 'ready', files: [] }; }, /projection version|session mismatch/],
    ['http', x => { x.attempts[0]!.httpStatus = 500; x.attempts[0]!.error = 'boom'; }, /HTTP|host|failure/i],
    ['cache', x => { for (const a of x.attempts) if (a.freshness === 'fresh') a.freshness = 'cache-hit'; }, /useful fresh|window/],
    ['empty', x => { for (const a of x.attempts) if (a.freshness === 'fresh') a.body = { ...page(a.expected) as object, files: [] }; }, /missing file/],
    ['overload', x => { for (const a of x.attempts) a.freshness = 'none'; }, /useful fresh|window/],
    ['language', x => { for (const a of x.attempts) if (a.expected.language === 'swift') a.freshness = 'none'; }, /languages had no useful/],
  ];
  for (const [name, mutate, reason] of variants) {
    const input = passing(); mutate(input);
    const report = scoreInterfaceLoad(input);
    assert.equal(report.sufficient, false, name);
    assert.match(report.reasons.join(' '), reason, name);
  }
});

test('counts look-ahead timeout once even with ready file; separates queue and running timeouts', () => {
  const input = passing();
  const running = input.traces[0]!;
  running.outcome = 'timeout'; running.exitedAtNs = running.settledAtNs + ns(1);
  input.attempts[0]!.body = { ...page(input.attempts[0]!.expected) as object,
    status: 'partial', fallback_reason: 'timeout', page: { complete: false, next_after_path: null } };
  const queued = input.traces[2]!;
  queued.outcome = 'timeout'; delete queued.startedAtNs;
  input.attempts[2]!.body = { ...page(input.attempts[2]!.expected) as object,
    status: 'skipped', fallback_reason: 'timeout', files: [], page: { complete: false, next_after_path: null } };
  const report = scoreInterfaceLoad(input);
  assert.equal(report.total.runningTimeout, 1);
  assert.equal(report.total.queueTimeout, 1);
  assert.equal(report.total.admittedTimeoutFraction, 2 / 15);
  assert.equal(report.total.completedFiles, 14);
});

test('rejects absent correlation, missing responses, child leaks, corpus and attempt exhaustion', () => {
  const cases: Array<(x: InterfaceLoadInput) => void> = [
    x => { x.traces.pop(); },
    x => { delete x.attempts[0]!.completedAtNs; },
    x => { x.traces[0]!.outcome = 'cancelled'; },
    x => { x.corpusExhausted = true; },
    x => { x.attemptLimitReached = true; },
    x => { x.cleanupComplete = false; },
  ];
  for (const mutate of cases) { const x = passing(); mutate(x); assert.equal(scoreInterfaceLoad(x).sufficient, false); }
});

test('rejects illegal retry and an interval gap despite peak concurrency', () => {
  const x = passing();
  x.attempts[2]!.expected = x.attempts[0]!.expected;
  assert.match(scoreInterfaceLoad(x).reasons.join(' '), /repeated/);
  const y = passing();
  y.attempts = y.attempts.filter((_, i) => i !== 12);
  y.traces = y.traces.filter(t => t.requestId !== 'r12');
  assert.match(scoreInterfaceLoad(y).reasons.join(' '), /continuously|window/);
});

test('capture comparison checks all six latency cells and throughput independently', () => {
  const base = { written: 200, missing: 0, latency: { n: 200, p50: 10, p99: 10 }, scheduledLatency: { n: 100, p50: 10, p99: 10 },
    burstLatency: { n: 100, p50: 10, p99: 10 }, throughputPerSecond: 100 } as Parameters<typeof compareCaptureToBaseline>[0];
  const loaded = { ...base, burstLatency: { n: 100, p50: 10, p99: 13 }, throughputPerSecond: 90 };
  const result = compareCaptureToBaseline(base, loaded, 'combined', 2, true);
  assert.equal(result.passed, false);
  assert.equal(result.latencyCells.length, 6);
  assert.equal(result.latencyCells.filter(cell => !cell.passed).length, 1);
  assert.equal(result.throughputCell.passed, false);
  assert.match(result.reasons.join(' '), /burstLatency.p99/);
  assert.match(result.reasons.join(' '), /throughput/);
});
