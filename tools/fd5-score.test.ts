import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleProjectionTrace, compareCaptureToBaseline, PLANNED_ABORT, scoreInterfaceLoad, scoreProcessStartupTiming,
  validateInterfacePage, witnessCoverageFaults, type AdmissionTrace, type ExpectedInterfaceRequest, type InterfaceAttempt, type InterfaceLoadInput } from './fd5-score.ts';
import { scoreCaptureArm } from '../src/clip-bench.ts';

const ns = (ms: number): bigint => BigInt(ms) * 1_000_000n;
const languages = ['typescript', 'tsx', 'swift'] as const;
function expected(i: number, language = languages[i % 3]!): ExpectedInterfaceRequest {
  return { key: `unique-content-${i}`, routeKey: `/v1/sessions/test-${i}/interfaces?before_seq=3&after_seq=4&limit=1`,
    language, sizeClass: 'tiny', sessionId: '11111111-1111-4111-8111-111111111111',
    beforeSeq: '3', afterSeq: '4', files: [{ path: `file-${i}.${language === 'swift' ? 'swift' : language === 'tsx' ? 'tsx' : 'ts'}`,
      language: language === 'swift' ? 'swift' : 'typescript', languageVersion: language === 'swift' ? 'swift.v1' : 'typescript.v2',
      beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), beforeRecordSeq: '2', afterRecordSeq: '4',
      changes: [{ kind: 'signatureChanged', identity: { name: `f${i}` } }] }] };
}
function page(e: ExpectedInterfaceRequest): unknown {
  return { projection_version: 'interface.v2', session_id: e.sessionId,
    range: { before_seq: e.beforeSeq, after_seq: e.afterSeq }, status: 'ready',
    inventory: { scope: 'observed' }, analysis: { shared_types: 'notAnalyzed' }, gaps: [], gaps_complete: true,
    files: e.files.map(f => ({ path: f.path,
      before: { kind: 'recorded', record_seq: f.beforeRecordSeq, field: 'snapshot',
        snapshot: { kind: 'content', sha256: f.beforeSha256 } },
      after: { kind: 'recorded', record_seq: f.afterRecordSeq, field: 'after', observation: 'watcher',
        snapshot: { kind: 'content', sha256: f.afterSha256 } },
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
      freshnessByPath: overloaded ? {} : Object.fromEntries(e.files.map(f => [f.path, 'fresh'])) });
    traces.push({ unitId: i, routeKey: e.routeKey, workload: 'interface', submittedAtNs: start,
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
  rows[0]!.after = { ...(rows[0]!.after as object), record_seq: 'wrong' };
  assert.match(validateInterfacePage(good, e).join(' '), /source provenance mismatch/);
  rows.pop();
  assert.match(validateInterfacePage(good, e).join(' '), /missing file/);
});

test('complete ready page may include an explicitly requested identical row', () => {
  const e = expected(0);
  const body = page(e) as { files: Array<Record<string, unknown>> };
  body.files[0]!.status = 'identical';
  body.files[0]!.changes = [];
  assert.deepEqual(validateInterfacePage(body, e), []);
});

test('rejects malformed 200, HTTP failure, cache-only, empty, overload-only and missing language', () => {
  const variants: Array<[string, (x: InterfaceLoadInput) => void, RegExp]> = [
    ['malformed', x => { x.attempts[0]!.body = { status: 'ready', files: [] }; }, /projection version|session mismatch/],
    ['http', x => { x.attempts[0]!.httpStatus = 500; x.attempts[0]!.error = 'boom'; }, /HTTP|host|failure/i],
    ['cache', x => { for (const a of x.attempts) if (a.freshnessByPath) for (const path of Object.keys(a.freshnessByPath)) a.freshnessByPath[path] = 'cache-hit'; }, /useful fresh|window/],
    ['empty', x => { for (const a of x.attempts) if (Object.keys(a.freshnessByPath ?? {}).length) a.body = { ...page(a.expected) as object, files: [] }; }, /missing file/],
    ['overload', x => { for (const a of x.attempts) a.freshnessByPath = {}; }, /useful fresh|window/],
    ['language', x => { for (const a of x.attempts) if (a.expected.language === 'swift') a.freshnessByPath = {}; }, /languages had no useful/],
  ];
  for (const [name, mutate, reason] of variants) {
    const input = passing(); mutate(input);
    const report = scoreInterfaceLoad(input);
    assert.equal(report.sufficient, false, name);
    assert.match(report.reasons.join(' '), reason, name);
  }
});

test('cold comparison cannot hide one cached or unobserved ready row among useful work', () => {
  const cached = passing();
  cached.attempts[0]!.freshnessByPath![cached.attempts[0]!.expected.files[0]!.path] = 'cache-hit';
  assert.match(scoreInterfaceLoad(cached).reasons.join(' '), /cold.*cached/);
  const missing = passing();
  delete missing.attempts[0]!.freshnessByPath![missing.attempts[0]!.expected.files[0]!.path];
  assert.match(scoreInterfaceLoad(missing).reasons.join(' '), /lacks.*freshness/);
});

test('counts look-ahead timeout once even with ready file; separates queue and running timeouts', () => {
  const input = passing();
  const running = input.traces![0]!;
  running.outcome = 'timeout'; running.exitedAtNs = running.settledAtNs + ns(1);
  input.attempts[0]!.body = { ...page(input.attempts[0]!.expected) as object,
    status: 'partial', fallback_reason: 'timeout', page: { complete: false, next_after_path: null } };
  const queued = input.traces![2]!;
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
  const cases: Array<[(x: InterfaceLoadInput) => void, RegExp]> = [
    [x => { x.traces!.pop(); }, /admission trace count/],
    [x => { delete x.attempts[0]!.completedAtNs; }, /correlated admission/],
    [x => { x.traces![0]!.outcome = 'cancelled'; }, /actual exit/],
    [x => { x.corpusExhausted = true; }, /corpus exhausted/],
    [x => { x.attemptLimitReached = true; }, /attempt guard/],
    [x => { x.cleanupComplete = false; }, /cleanup unproven/],
  ];
  for (const [mutate, reason] of cases) {
    const x = passing(); mutate(x);
    const report = scoreInterfaceLoad(x);
    assert.equal(report.sufficient, false);
    assert.match(report.reasons.join(' '), reason);
  }
});

test('rejects illegal retry and an interval gap despite peak concurrency', () => {
  const x = passing();
  x.attempts[2]!.expected = x.attempts[0]!.expected;
  assert.match(scoreInterfaceLoad(x).reasons.join(' '), /repeated/);
  const y = passing();
  y.attempts = y.attempts.filter((_, i) => i !== 12);
  y.traces = y.traces!.filter(t => t.unitId !== 12);
  assert.match(scoreInterfaceLoad(y).reasons.join(' '), /continuously|window/);
});

test('capture comparison checks all six latency cells and throughput independently', () => {
  const base = { written: 200, missing: 0, latency: { n: 200, p50: 10, p99: 10 }, scheduledLatency: { n: 100, p50: 10, p99: 10 },
    burstLatency: { n: 100, p50: 10, p99: 10 }, throughputPerSecond: 100 } as Parameters<typeof compareCaptureToBaseline>[0];
  const loaded = { ...base, burstLatency: { n: 100, p50: 10, p95: 10, p99: 13 }, throughputPerSecond: 90 };
  const result = compareCaptureToBaseline(base, loaded, 'combined', 2, true);
  assert.equal(result.passed, false);
  assert.equal(result.latencyCells.length, 6);
  assert.equal(result.latencyCells.filter(cell => !cell.passed).length, 1);
  assert.equal(result.throughputCell.passed, false);
  assert.match(result.reasons.join(' '), /burstLatency.p99/);
  assert.match(result.reasons.join(' '), /throughput/);
});

test('baseline trace faults invalidate an otherwise passing paired capture comparison', () => {
  const capture = { written: 200, missing: 0, latency: { n: 200, p50: 10, p99: 10 },
    scheduledLatency: { n: 100, p50: 10, p99: 10 }, burstLatency: { n: 100, p50: 10, p99: 10 },
    throughputPerSecond: 100 } as Parameters<typeof compareCaptureToBaseline>[0];
  const result = compareCaptureToBaseline(capture, capture, 'clip-only', 1, true,
    ['baseline trace evidence invalid']);
  assert.equal(result.passed, false);
  assert.match(result.reasons.join(' '), /baseline trace evidence invalid/);
});

test('joins legal same-key overload retry by route and disjoint monotonic interval', () => {
  const x = passing();
  x.attempts[0]!.body = { ...page(x.attempts[0]!.expected) as object,
    status: 'skipped', fallback_reason: 'overloaded', files: [] };
  x.attempts[0]!.freshnessByPath = {};
  x.traces![0]!.outcome = 'overloaded';
  delete x.traces![0]!.admittedAtNs;
  delete x.traces![0]!.startedAtNs;
  x.attempts[1]!.expected = x.attempts[0]!.expected;
  x.attempts[1]!.body = page(x.attempts[1]!.expected);
  x.attempts[1]!.freshnessByPath = { [x.attempts[1]!.expected.files[0]!.path]: 'fresh' };
  x.traces![1]!.routeKey = x.traces![0]!.routeKey;
  x.traces![1]!.outcome = 'ok';
  x.traces![1]!.admittedAtNs = x.traces![1]!.submittedAtNs;
  x.traces![1]!.startedAtNs = x.traces![1]!.submittedAtNs;
  assert.equal(scoreInterfaceLoad(x).sufficient, true);
  // An ambiguous runtime unit for one interval must not be guessed by order.
  x.traces!.push({ ...x.traces![1]!, unitId: 999 });
  assert.match(scoreInterfaceLoad(x).reasons.join(' '), /correlated admission/);
});

test('frozen observer events assemble into distinct retries and per-file freshness', () => {
  const e = expected(0);
  const attempts: InterfaceAttempt[] = [
    { requestId: 'first', expected: e, startedAtNs: ns(0), completedAtNs: ns(10),
      httpStatus: 200, body: { ...page(e) as object, status: 'skipped', fallback_reason: 'overloaded', files: [] } },
    { requestId: 'second', expected: e, startedAtNs: ns(11), completedAtNs: ns(40), httpStatus: 200, body: page(e) },
  ];
  const events = [
    { kind: 'admission', unitId: 1, routeKey: e.routeKey, workload: 'interface', atNs: ns(1), disposition: 'overloaded' },
    { kind: 'settle', unitId: 1, atNs: ns(2), priorState: 'overloaded', outcome: 'overloaded' },
    { kind: 'admission', unitId: 2, routeKey: e.routeKey, workload: 'interface', atNs: ns(12), disposition: 'running' },
    { kind: 'dispatch', unitId: 2, atNs: ns(13) },
    { kind: 'interface-file', routeKey: e.routeKey, path: e.files[0]!.path, atNs: ns(25), freshness: 'fresh', resultStatus: 'ready' },
    { kind: 'task-finished', unitId: 2, atNs: ns(29) },
    { kind: 'settle', unitId: 2, atNs: ns(30), priorState: 'running', outcome: 'ok' },
  ] as const;
  const assembled = assembleProjectionTrace([...events], attempts);
  assert.deepEqual(assembled.faults, []);
  assert.equal(assembled.traces.length, 2);
  assert.equal(assembled.attempts[1]!.freshnessByPath?.[e.files[0]!.path], 'fresh');
  assert.equal(assembled.attempts[0]!.freshnessByPath?.[e.files[0]!.path], undefined);
  assert.match(assembleProjectionTrace([...events, events[4]], attempts).faults.join(' '), /duplicate interface-file/);
});

test('a planned disconnect keeps its completed-row freshness without an HTTP row to match', () => {
  const e = expected(0);
  const attempts: InterfaceAttempt[] = [{ requestId: 'planned', expected: e, startedAtNs: ns(0), completedAtNs: ns(10),
    error: PLANNED_ABORT, plannedAbortMs: 10 }];
  const events = [
    { kind: 'admission', unitId: 1, routeKey: e.routeKey, workload: 'interface', atNs: ns(1), disposition: 'running' },
    { kind: 'dispatch', unitId: 1, atNs: ns(2) },
    { kind: 'interface-file', routeKey: e.routeKey, path: e.files[0]!.path, atNs: ns(8), freshness: 'fresh', resultStatus: 'ready' },
    { kind: 'settle', unitId: 1, atNs: ns(12), priorState: 'running', outcome: 'cancelled' },
    { kind: 'task-finished', unitId: 1, atNs: ns(13) },
  ] as const;
  const assembled = assembleProjectionTrace([...events], attempts);
  assert.deepEqual(assembled.faults, []);
  assert.equal(assembled.attempts[0]!.freshnessByPath?.[e.files[0]!.path], 'fresh');
});

test('only a parser process alive at cancellation and then exited proves cancelled parser work', () => {
  const e = expected(0);
  const scanOnly = [
    { kind: 'admission', unitId: 1, routeKey: e.routeKey, workload: 'interface', atNs: ns(1), disposition: 'running' },
    { kind: 'dispatch', unitId: 1, atNs: ns(2) },
    { kind: 'settle', unitId: 1, atNs: ns(4), priorState: 'running', outcome: 'cancelled' },
    { kind: 'task-finished', unitId: 1, atNs: ns(6) },
  ] as const;
  assert.notEqual(assembleProjectionTrace([...scanOnly], []).traces[0]!.parserCancelled, true);
  const parsing = [
    ...scanOnly.slice(0, 2),
    { kind: 'parser-request', unitId: 1, atNs: ns(2) },
    { kind: 'process-start', processId: 9, process: 'swift-child', unitId: 1, atNs: ns(3) },
    ...scanOnly.slice(2),
    { kind: 'process-exit', processId: 9, atNs: ns(7), code: 1 },
  ] as const;
  const assembled = assembleProjectionTrace([...parsing], []);
  assert.deepEqual(assembled.faults, []);
  assert.equal(assembled.traces[0]!.parserCancelled, true);
  const exitedFirst = parsing.map(event => event.kind === 'process-exit' ? { ...event, atNs: ns(3) } : event);
  assert.notEqual(assembleProjectionTrace([...exitedFirst], []).traces[0]!.parserCancelled, true);
  const pooled = [
    ...scanOnly.slice(0, 2),
    { kind: 'parser-request', unitId: 1, atNs: ns(2) },
    { kind: 'process-start', processId: 9, process: 'ts-worker', atNs: ns(0) },
    { kind: 'process-use', processId: 9, unitId: 1, atNs: ns(3) },
    ...scanOnly.slice(2),
    { kind: 'process-exit', processId: 9, atNs: ns(9), code: 0 },
  ] as const;
  assert.notEqual(assembleProjectionTrace([...pooled], []).traces[0]!.parserCancelled, true);
  const retired = assembleProjectionTrace([...pooled.slice(0, -1),
    { kind: 'process-retire', processId: 9, unitId: 1, atNs: ns(5) }, pooled.at(-1)!], []);
  assert.deepEqual(retired.faults, []);
  assert.equal(retired.traces[0]!.parserCancelled, true);
});

test('actual process exit and task completion are both required after a running timeout', () => {
  const e = expected(0);
  const events = [
    { kind: 'admission', unitId: 1, routeKey: e.routeKey, workload: 'interface', atNs: ns(1), disposition: 'running' },
    { kind: 'dispatch', unitId: 1, atNs: ns(2) },
    { kind: 'parser-request', unitId: 1, atNs: ns(2) },
    { kind: 'process-start', processId: 9, process: 'ts-worker', atNs: ns(3) },
    { kind: 'process-use', processId: 9, unitId: 1, atNs: ns(3) },
    { kind: 'settle', unitId: 1, atNs: ns(4), priorState: 'running', outcome: 'timeout' },
    { kind: 'process-retire', processId: 9, unitId: 1, atNs: ns(5) },
    { kind: 'task-finished', unitId: 1, atNs: ns(6) },
  ] as const;
  const withoutExit = assembleProjectionTrace([...events], []);
  assert.equal(withoutExit.traces[0]!.exitedAtNs, undefined);
  assert.equal(withoutExit.processExitsVerified, false);
  assert.match(withoutExit.faults.join(' '), /actual exit/);
  const withExit = assembleProjectionTrace([...events,
    { kind: 'process-exit', processId: 9, atNs: ns(7), code: 1 }], []);
  assert.deepEqual(withExit.faults, []);
  assert.equal(withExit.traces[0]!.exitedAtNs, ns(7));
  assert.equal(withExit.processExitsVerified, true);
  const noLink = assembleProjectionTrace(events.filter(event => event.kind !== 'process-use'
    && event.kind !== 'process-retire'), []);
  assert.equal(noLink.traces[0]!.exitedAtNs, undefined);
  assert.match(noLink.faults.join(' '), /parser request has no linked process/);
});

test('killed-before-ready process is censored; successful work without startup timing is a fault', () => {
  const uses = [{ unitId: 4, processId: 8 }];
  const events = [{ kind: 'process-start', processId: 8, process: 'swift-child', atNs: 1n },
    { kind: 'process-exit', processId: 8, code: null, signal: 'SIGKILL', atNs: 2n }] as const;
  const trace: AdmissionTrace = { unitId: 4, routeKey: '/swift', workload: 'interface',
    submittedAtNs: 0n, admittedAtNs: 0n, startedAtNs: 0n, settledAtNs: 2n,
    exitedAtNs: 2n, outcome: 'timeout' };
  const censored = scoreProcessStartupTiming(uses, [...events], new Map(), [trace]);
  assert.deepEqual(censored.faults, []);
  assert.equal(censored.censored, 1);
  assert.match(scoreProcessStartupTiming(uses, [...events], new Map(),
    [{ ...trace, outcome: 'ok' }]).faults.join(' '), /lacks startup timing/);
  assert.match(scoreProcessStartupTiming(uses, [{ ...events[0]! },
    { kind: 'process-exit', processId: 8, code: 0, atNs: 2n }], new Map(),
  [trace]).faults.join(' '), /lacks startup timing/);
  assert.match(scoreProcessStartupTiming(uses, [{ ...events[0]! },
    { kind: 'process-exit', processId: 8, code: 1, atNs: 1n }], new Map(),
  [trace]).faults.join(' '), /lacks startup timing/);
});

test('per-file freshness does not credit cached rows on a fresh multi-file page', () => {
  const x = passing();
  const first = x.attempts[0]!;
  const second = { ...expected(99).files[0]!, path: 'second.ts' };
  first.expected.files.push(second);
  first.body = page(first.expected);
  first.freshnessByPath = { [first.expected.files[0]!.path]: 'fresh', [second.path]: 'cache-hit' };
  const report = scoreInterfaceLoad(x);
  assert.equal(report.total.usefulComparisons, 15);
  assert.equal(report.total.cacheHits, 1);
});

test('ready continuation and timed-out look-ahead remain distinct from complete pages', () => {
  const x = passing();
  const first = x.attempts[0]!;
  first.expected.files.push({ ...expected(99).files[0]!, path: 'later.ts' });
  first.body = { ...page(expected(0)) as object, page: { complete: false, next_after_path: first.expected.files[0]!.path } };
  assert.deepEqual(validateInterfacePage(first.body, first.expected), []);
  x.traces![0]!.outcome = 'timeout';
  x.traces![0]!.exitedAtNs = x.traces![0]!.settledAtNs + ns(1);
  const report = scoreInterfaceLoad(x);
  assert.equal(report.total.runningTimeout, 1);
  assert.equal(report.timeoutWithoutHttpReason, 1);
  assert.equal(report.total.completedPages, 14);
});

test('contradictory and unclassified admission evidence invalidates denominators', () => {
  const x = passing();
  x.traces![1]!.admittedAtNs = x.traces![1]!.submittedAtNs;
  assert.match(scoreInterfaceLoad(x).reasons.join(' '), /contradicts outcome/);
  const y = passing();
  y.traces![0]!.settledAtNs = y.traces![0]!.submittedAtNs - 1n;
  assert.match(scoreInterfaceLoad(y).reasons.join(' '), /timestamps are contradictory/);
});

test('FD5 capture still treats a missing durable timestamp as a missing write', () => {
  const report = scoreCaptureArm({ name: 'baseline',
    writes: [{ path: 'one.ts', sha256: 'a'.repeat(64), startedAtNs: ns(0), phase: 'scheduled' }],
    records: [{ type: 'slipstream.file.changed.v1', seq: '7',
      data: { path: 'one.ts', after: { kind: 'content', sha256: 'a'.repeat(64) } } }],
    durableAtNsBySeq: new Map(), clipResponses: [], requestedClipKeys: [], concurrentClipRequests: 0 });
  assert.equal(report.missing, 1);
  assert.equal(report.latency.n, 0);
  assert.equal(report.latency.p99, null);
});

function httpOnly(): InterfaceLoadInput {
  const x = passing();
  for (const a of x.attempts) delete a.freshnessByPath;
  return { ...x, traces: null };
}
const timedOut = (e: ExpectedInterfaceRequest): unknown => ({ ...page(e) as object, status: 'skipped',
  fallback_reason: 'timeout', files: [], page: { complete: false, next_after_path: null } });
const lookAhead = (e: ExpectedInterfaceRequest): unknown => ({ ...page(e) as object,
  page: { complete: false, next_after_path: e.files[0]!.path } });
function malformed(i: number): ExpectedInterfaceRequest {
  const e = expected(i);
  e.variant = 'malformed';
  e.files[0]!.changes = [];
  e.files[0]!.incompleteReason = 'before-parse-error';
  return e;
}
const incompleteRow = (e: ExpectedInterfaceRequest, reason = 'before-parse-error'): unknown => {
  const body = page(e) as { status: string; files: Array<Record<string, unknown>> };
  body.status = 'partial';
  Object.assign(body.files[0]!, { status: 'incomplete', fallback_reason: reason });
  return body;
};

test('HTTP-only scoring classifies overload, work and windows without admission traces', () => {
  const report = scoreInterfaceLoad(httpOnly());
  assert.deepEqual(report.reasons, []);
  assert.equal(report.classification, 'http');
  assert.equal(report.total.rejected, 15);
  assert.equal(report.total.admitted, 15);
  assert.equal(report.total.usefulComparisons, 15);
  assert.equal(report.total.unclassified, 0);
});

test('HTTP-only scoring still rejects failures, illegal cold-key reuse and overload-free windows', () => {
  const cases: Array<[(x: InterfaceLoadInput) => void, RegExp]> = [
    [x => { x.attempts[0]!.httpStatus = 500; }, /HTTP or host failure/],
    [x => { delete x.attempts[0]!.httpStatus; x.attempts[0]!.error = 'reset'; }, /HTTP or host failure/],
    [x => { x.attempts[2]!.expected = x.attempts[0]!.expected; }, /repeated/],
    [x => { for (const a of x.attempts) a.body = page(a.expected); }, /window lacked/],
  ];
  for (const [mutate, reason] of cases) {
    const x = httpOnly(); mutate(x);
    const report = scoreInterfaceLoad(x);
    assert.equal(report.sufficient, false);
    assert.match(report.reasons.join(' '), reason);
  }
  const retry = httpOnly();
  retry.attempts[2]!.expected = retry.attempts[1]!.expected;
  retry.attempts[2]!.body = page(retry.attempts[1]!.expected);
  assert.deepEqual(scoreInterfaceLoad(retry).reasons, []);
});

test('a planned disconnect cannot bridge a gap in continuous request coverage', () => {
  const x = httpOnly();
  const [gap] = x.attempts.splice(4, 1);
  assert.match(scoreInterfaceLoad(x).reasons.join(' '), /continuously cover/);
  x.attempts.push({ requestId: 'planned', expected: expected(700), startedAtNs: gap!.startedAtNs,
    completedAtNs: gap!.completedAtNs, error: PLANNED_ABORT, plannedAbortMs: 100 });
  x.corpusKeys.push(expected(700).key);
  assert.match(scoreInterfaceLoad(x).reasons.join(' '), /continuously cover/);
});

test('timeout fraction is bounded by explicit timeouts and unexplained incomplete pages', () => {
  const x = httpOnly();
  x.attempts[0]!.body = timedOut(x.attempts[0]!.expected);
  x.attempts[6]!.body = lookAhead(x.attempts[6]!.expected);
  const report = scoreInterfaceLoad(x);
  const typescript = report.byLanguage.typescript;
  assert.equal(typescript.validResponses, 5);
  assert.equal(typescript.explicitTimeouts, 1);
  assert.equal(typescript.unexplainedIncomplete, 1);
  assert.deepEqual(typescript.timeoutFractionBounds, { lower: 1 / 5, upper: 2 / 5 });
  assert.equal(typescript.usefulComparisons, 3);
  assert.equal(report.byLanguage.swift.timeoutFractionBounds?.upper, 0);
});

test('traced witnesses prove the HTTP timeout evidence agrees with admission', () => {
  const explicit = passing();
  explicit.attempts[0]!.body = timedOut(explicit.attempts[0]!.expected);
  assert.match(scoreInterfaceLoad(explicit).reasons.join(' '), /timeout disagrees with admission/);
  const silent = passing();
  silent.attempts[0]!.body = lookAhead(silent.attempts[0]!.expected);
  assert.match(scoreInterfaceLoad(silent).reasons.join(' '), /incomplete page lacks timeout/);
  silent.traces![0]!.outcome = 'timeout';
  silent.traces![0]!.exitedAtNs = silent.traces![0]!.settledAtNs;
  assert.deepEqual(scoreInterfaceLoad(silent).reasons, []);
});

function withPlanned(x: InterfaceLoadInput, language: 'typescript' | 'swift'): InterfaceAttempt {
  const e = expected(500, language);
  const attempt: InterfaceAttempt = { requestId: 'planned', expected: e, startedAtNs: ns(150),
    completedAtNs: ns(250), error: PLANNED_ABORT, plannedAbortMs: 100 };
  x.attempts.push(attempt);
  x.corpusKeys.push(e.key);
  return attempt;
}

test('planned client aborts are excluded from load denominators but counted separately', () => {
  const x = httpOnly();
  withPlanned(x, 'typescript');
  const report = scoreInterfaceLoad(x);
  assert.deepEqual(report.reasons, []);
  assert.equal(report.total.submitted, 30);
  assert.deepEqual(report.plannedCancels, { planned: 1, abortedBeforeResponse: 1, respondedBeforeAbort: 0,
    cancelledRunning: { typescript: 0, swift: 0 } });
  const failed = httpOnly();
  withPlanned(failed, 'typescript').error = 'socket hang up';
  assert.match(scoreInterfaceLoad(failed).reasons.join(' '), /HTTP or host failure/);
});

test('traced planned aborts must settle cancelled running work with an actual exit', () => {
  const x = passing();
  const attempt = withPlanned(x, 'swift');
  const cancelled: AdmissionTrace = { unitId: 900, routeKey: attempt.expected.routeKey, workload: 'interface',
    submittedAtNs: ns(151), admittedAtNs: ns(151), startedAtNs: ns(152), settledAtNs: ns(260),
    outcome: 'cancelled', exitedAtNs: ns(270) };
  x.traces!.push(cancelled);
  assert.equal(scoreInterfaceLoad(x).plannedCancels.cancelledRunning.swift, 0);
  cancelled.parserCancelled = true;
  const report = scoreInterfaceLoad(x);
  assert.deepEqual(report.reasons, []);
  assert.equal(report.plannedCancels.cancelledRunning.swift, 1);
  delete cancelled.exitedAtNs;
  assert.match(scoreInterfaceLoad(x).reasons.join(' '), /actual exit/);
  cancelled.exitedAtNs = ns(270);
  x.traces!.push({ ...cancelled, unitId: 901 });
  assert.match(scoreInterfaceLoad(x).reasons.join(' '), /planned abort.*admission/);
  x.traces!.pop();
  x.traces!.pop();
  assert.deepEqual(scoreInterfaceLoad(x).reasons, []);
});

test('expected parse failures must stay incomplete with their stated reason', () => {
  const e = malformed(0);
  assert.deepEqual(validateInterfacePage(incompleteRow(e), e), []);
  assert.match(validateInterfacePage(page(e), e).join(' '), /expected incomplete/);
  assert.match(validateInterfacePage(incompleteRow(e, 'after-parse-error'), e).join(' '), /incomplete reason/);
  const wrongStatuses = ['identical', 'skipped', 'unavailable', 'unsupported'] as const;
  for (const status of wrongStatuses) {
    const body = incompleteRow(e) as { files: Array<Record<string, unknown>> };
    Object.assign(body.files[0]!, { status, fallback_reason: status === 'skipped' ? 'cancelled' : undefined });
    assert.match(validateInterfacePage(body, e).join(' '), /expected incomplete/, status);
  }
  assert.deepEqual(validateInterfacePage(timedOut(e), e), []);
  assert.deepEqual(validateInterfacePage({ ...page(e) as object, status: 'skipped',
    fallback_reason: 'overloaded', files: [], page: { complete: false, next_after_path: null } }, e), []);
});

test('each requested input variant needs one correctly handled response', () => {
  const x = httpOnly();
  const e = malformed(600);
  x.attempts.push({ requestId: 'variant', expected: e, startedAtNs: ns(2900), completedAtNs: ns(2950),
    httpStatus: 200, body: incompleteRow(e) });
  x.corpusKeys.push(e.key);
  const report = scoreInterfaceLoad(x);
  assert.deepEqual(report.reasons, []);
  assert.deepEqual(report.variants, { 'malformed:typescript': { requested: 1, handled: 1 } });
  x.attempts.at(-1)!.body = incompleteRow(e, 'after-parse-error');
  assert.match(scoreInterfaceLoad(x).reasons.join(' '), /variant malformed:typescript was never handled/);
  x.attempts.at(-1)!.body = timedOut(e);
  assert.match(scoreInterfaceLoad(x).reasons.join(' '), /variant malformed:typescript was never handled/);
});

test('witness coverage needs cancelled parser work per family, every input variant and a retired TypeScript worker', () => {
  const report = scoreInterfaceLoad(passing());
  const retired = [
    { kind: 'process-start', processId: 3, process: 'ts-worker', atNs: 1n },
    { kind: 'process-retire', processId: 3, unitId: 1, atNs: 2n },
    { kind: 'process-exit', processId: 3, code: 1, atNs: 3n },
  ] as const;
  assert.match(witnessCoverageFaults(report, [...retired]).join(' '), /typescript.*cancel/);
  report.plannedCancels.cancelledRunning = { typescript: 1, swift: 1 };
  assert.match(witnessCoverageFaults(report, [...retired]).join(' '), /variant malformed:swift was never handled/);
  for (const variant of ['malformed:typescript', 'malformed:tsx', 'malformed:swift', 'unicode:typescript', 'unicode:tsx'])
    report.variants[variant] = { requested: 1, handled: 1 };
  assert.deepEqual(witnessCoverageFaults(report, [...retired]), []);
  assert.match(witnessCoverageFaults(report, [retired[0], retired[1]]).join(' '), /retired TypeScript worker/);
});
