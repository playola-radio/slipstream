import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campaignApprovalFaults, childProcessesExit, corpusPlan, createInterfaceCorpus, createLargeLogProbe,
  diagnosticCorpusPlan,
  LARGE_LOG_RESTORED_PATHS, largeLogOutcome, runFD5, startInterfaceLoad, validateConfig,
  type CorpusPage } from './fd5-bench.ts';
import { createServer } from 'node:http';
import { createHistoricalCorpus, type ClipResponse } from '../src/clip-bench.ts';
import { createTypeScriptInterfaceExtractor } from '../src/interface-v2-typescript.ts';
import { compareStructuredExtractions } from '../src/interface-v2-comparison.ts';
import { createCas } from '../src/cas.ts';
import { blobPath } from '../src/store-reader.ts';
import { extractSwiftSides, SwiftExtractCancelled } from '../src/swift-interface.ts';
import { createTypeScriptPool } from '../src/interface-ts-pool.ts';
import type { ProjectionTraceEvent } from '../src/projection-trace.ts';
import { compareV2 } from '../src/interface-v2-core.ts';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { startReaderServer } from '../src/http-reader.ts';
import { INTERFACE_PAGE_DEADLINE_MS, INTERFACE_SCAN_BUDGET } from '../src/interface-service.ts';
import { assembleProjectionTrace, PLANNED_ABORT, scoreClipTrace, validateInterfacePage, type InterfaceAttempt } from './fd5-score.ts';
import { createProjectionTraceCollector } from './fd5-trace.ts';

test('registered config preserves fixed B2 limits and requires an explicit finite cold corpus', async () => {
  const config = JSON.parse(await readFile(new URL('./fd5-provisional-config.json', import.meta.url), 'utf8'));
  assert.equal(validateConfig(config).requestSlots, 16);
  assert.equal(validateConfig({ ...config, admission: { ...config.admission, Q: 0, W: 0 } }).admission.Q, 0);
  for (const change of [
    { requestSlots: 15 }, { repetitions: 2 }, { scheduledWrites: 99 }, { burstWrites: 99 },
    { admission: { ...config.admission, clipDeadlineMs: 101 } },
    { interfaceCorpusPages: 100 }, { clipCorpusChanges: 100 },
    { admission: { ...config.admission, interfaceDeadlineMs: 400 } },
    { maxArmSeconds: 0 }, { maxPreparationSeconds: undefined }, { host: undefined },
    { host: { ...config.host, requireAcPower: false } }, { approvalRequired: undefined },
  ]) assert.throws(() => validateConfig({ ...config, ...change }));
});

test('registered config pins the owner-approved FD5 wall caps exactly', async () => {
  const config = JSON.parse(await readFile(new URL('./fd5-provisional-config.json', import.meta.url), 'utf8'));
  assert.equal(validateConfig(config).maxArmSeconds, 180);
  assert.equal(validateConfig(config).maxPreparationSeconds, 2300);
  for (const maxArmSeconds of [0, 179, 181])
    assert.throws(() => validateConfig({ ...config, maxArmSeconds }), /wall caps/);
  for (const maxPreparationSeconds of [0, 300, 2299, 2301])
    assert.throws(() => validateConfig({ ...config, maxPreparationSeconds }), /wall caps/);
});

test('campaign refuses to execute without an approved window, host vetoes and packet decisions', async () => {
  const config = validateConfig(JSON.parse(await readFile(new URL('./fd5-provisional-config.json', import.meta.url), 'utf8')));
  const now = Date.parse('2026-10-02T15:00:00Z');
  assert.deepEqual(campaignApprovalFaults(config, now), ['measurement window or host veto approval missing',
    'FD5 packet decisions approval missing']);
  const approved = { ...config, approvalRequired: {
    measurementWindow: { approved: true, hostVetoesApproved: true, startUtc: '2026-10-02T14:00:00Z', endUtc: '2026-10-02T16:00:00Z' },
    packetDecisions: { approved: true } } };
  assert.deepEqual(campaignApprovalFaults(approved, now), []);
  assert.deepEqual(campaignApprovalFaults(approved, Date.parse('2026-10-02T16:00:00Z')),
    ['measurement window or host veto approval missing']);
});

test('unapproved campaign stops before writing a report', async () => {
  const config = validateConfig(JSON.parse(await readFile(new URL('./fd5-provisional-config.json', import.meta.url), 'utf8')));
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-unapproved-'));
  try {
    await assert.rejects(runFD5(config, join(root, 'report.jsonl')), /owner execution decisions are incomplete/);
    await assert.rejects(readFile(join(root, 'report.jsonl')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registered config follows the merged 10-second interface page budget', async () => {
  const config = validateConfig(JSON.parse(await readFile(new URL('./fd5-provisional-config.json', import.meta.url), 'utf8')));
  assert.equal(config.admission.interfaceDeadlineMs, INTERFACE_PAGE_DEADLINE_MS);
  assert.equal(INTERFACE_PAGE_DEADLINE_MS, 10_000);
  assert.deepEqual([config.admission.C, config.admission.Q, config.admission.W, config.admission.clipDeadlineMs], [2, 8, 8, 100]);
});

test('disposable interface corpus has unique cold keys and mixed 1/4/16-file ranges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-corpus-test-'));
  try {
    const pages = await createInterfaceCorpus(root, 9);
    assert.deepEqual(pages.map(p => p.limit), [1, 1, 1, 4, 4, 4, 16, 16, 16]);
    assert.deepEqual(pages.map(p => p.expected.files.length), [1, 1, 1, 4, 4, 4, 16, 16, 16]);
    assert.equal(new Set(pages.map(p => p.expected.key)).size, 9);
    assert.deepEqual(new Set(pages.flatMap(p => p.expected.files.map(f => f.language))), new Set(['typescript', 'swift']));
    assert.deepEqual(new Set(pages.map(p => p.expected.language)), new Set(['typescript', 'tsx', 'swift']));
    for (const page of pages) {
      assert.ok(BigInt(page.expected.afterSeq) > BigInt(page.expected.beforeSeq));
      for (const file of page.expected.files) {
        assert.match(file.beforeSha256, /^[0-9a-f]{64}$/);
        assert.match(file.afterSha256, /^[0-9a-f]{64}$/);
        assert.notEqual(file.beforeSha256, file.afterSha256);
        assert.ok(file.changes.length > 0);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('TS, TSX and Swift corpus variants retain pinned changes at tiny and representative sizes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-expected-test-'));
  try {
    const pages = await createInterfaceCorpus(root, 12);
    const cas = await createCas(join(root, 'blobs'));
    for (const sizeClass of ['tiny', 'representative'] as const) {
      for (const [grammar, extension] of [['typescript', '.ts'], ['tsx', '.tsx']] as const) {
        const file = pages.find(p => p.expected.sizeClass === sizeClass && p.expected.language === grammar)!.expected.files[0]!;
        assert.ok(file.path.endsWith(extension));
        const extract = await createTypeScriptInterfaceExtractor(grammar);
        const before = extract(await cas.read(file.beforeSha256));
        const after = extract(await cas.read(file.afterSha256));
        const comparison = compareStructuredExtractions(before, after);
        assert.equal(comparison.status, 'ready');
        if (comparison.status === 'ready') assert.deepEqual(comparison.changes, file.changes);
      }
      const swiftFile = pages.find(p => p.expected.sizeClass === sizeClass && p.expected.language === 'swift')!.expected.files[0]!;
      const sides = await extractSwiftSides([
        { id: 'before', bytes: await cas.read(swiftFile.beforeSha256) },
        { id: 'after', bytes: await cas.read(swiftFile.afterSha256) },
      ]);
      const before = sides.get('before'), after = sides.get('after');
      assert.equal(before?.status, 'complete');
      assert.equal(after?.status, 'complete');
      if (before?.status === 'complete' && after?.status === 'complete') {
        const comparison = compareV2(before.declarations, after.declarations);
        assert.equal(comparison.status, 'ready');
        if (comparison.status === 'ready') assert.deepEqual(comparison.changes, swiftFile.changes);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registered corpus schedule mixes Unicode and parse-failure pages with planned disconnects', () => {
  const plans = Array.from({ length: 300 }, (_, index) => corpusPlan(index));
  const variants = new Set(plans.flatMap(plan => plan.variant ? [`${plan.variant}:${plan.language}`] : []));
  assert.deepEqual(variants, new Set(['unicode:typescript', 'unicode:tsx',
    'malformed:typescript', 'malformed:tsx', 'malformed:swift']));
  for (const plan of plans.filter(plan => plan.variant)) assert.deepEqual([plan.limit, plan.sizeClass], [1, 'tiny']);
  const planned = plans.flatMap((plan, index) => plan.plannedAbortMs === undefined ? [] : [{ index, ...plan }]);
  assert.equal(planned.length, 12);
  assert.ok(planned.every(plan => plan.index % 25 === 11 && plan.variant === undefined));
  assert.deepEqual(new Set(planned.map(plan => `${plan.language}:${plan.plannedAbortMs}`)).size, 12);
  assert.deepEqual(plans.slice(0, 9).map(plan => plan.limit), [1, 1, 1, 4, 4, 4, 16, 16, 16]);
});

test('diagnostic corpus keeps ten plain pages in every language, size and page cell', () => {
  const cells = new Map<string, number>();
  for (let index = 0; index < 180; index++) {
    const plan = diagnosticCorpusPlan(index);
    assert.equal(plan.variant, undefined);
    assert.equal(plan.plannedAbortMs, undefined);
    const cell = `${plan.language}/${plan.sizeClass}/${plan.limit}`;
    cells.set(cell, (cells.get(cell) ?? 0) + 1);
  }
  assert.equal(cells.size, 18);
  assert.ok([...cells.values()].every(count => count === 10));
});

test('real reader handles Unicode and parse-failure variant pages exactly as the fixtures state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-variant-test-'));
  let reader: Awaited<ReturnType<typeof startReaderServer>> | undefined;
  try {
    const pages = [];
    for (const [language, variant] of [['typescript', 'unicode'], ['tsx', 'unicode'], ['typescript', 'malformed'],
      ['tsx', 'malformed'], ['swift', 'malformed']] as const)
      pages.push(...await createInterfaceCorpus(root, 1, `variant-${language}-${variant}`,
        () => ({ language, sizeClass: 'tiny', limit: 1, variant })));
    reader = await startReaderServer({ storeDir: root });
    for (const page of pages) {
      const response = await fetch(reader.url + page.expected.routeKey,
        { headers: { authorization: `Bearer ${reader.token}` } });
      const body = await response.json() as { files: Array<{ status: string }> };
      assert.equal(response.status, 200);
      assert.deepEqual(validateInterfacePage(body, page.expected), []);
      assert.equal(body.files[0]!.status, page.expected.variant === 'unicode' ? 'ready' : 'incomplete');
    }
  } finally {
    await reader?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function fakeReader(handler: Parameters<typeof createServer>[1]):
  Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`,
    close: async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}
const fakePage: CorpusPage = { limit: 1, expected: { key: 'fake', routeKey: '/v1/sessions/fake/interfaces?limit=1',
  language: 'typescript', sizeClass: 'tiny', sessionId: 'fake', beforeSeq: '1', afterSeq: '2', files: [] } };

test('interface load disconnects a planned page once and never retries its key', async () => {
  const fake = await fakeReader(() => {});
  try {
    const load = startInterfaceLoad(fake.url, 'token', [{ ...fakePage, plannedAbortMs: 50 }], 1);
    await new Promise(resolve => setTimeout(resolve, 250));
    const summary = await load.stop();
    assert.equal(summary.attempts.length, 1);
    assert.equal(summary.attempts[0]!.error, PLANNED_ABORT);
    assert.equal(summary.attempts[0]!.plannedAbortMs, 50);
    assert.equal(summary.corpusExhausted, true);
  } finally { await fake.close(); }
});

test('interface load backs off before retrying an overloaded page', async () => {
  const fake = await fakeReader((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'skipped', fallback_reason: 'overloaded' }));
  });
  try {
    const load = startInterfaceLoad(fake.url, 'token', [fakePage], 1);
    await new Promise(resolve => setTimeout(resolve, 450));
    const summary = await load.stop();
    assert.ok(summary.attempts.length >= 2 && summary.attempts.length <= 6, `${summary.attempts.length} attempts`);
    assert.equal(new Set(summary.attempts.map(attempt => attempt.expected.key)).size, 1);
  } finally { await fake.close(); }
});

test('registered large-log probe hides restored paths, serves the one real change and stays inside the scan budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-large-log-test-'));
  let reader: Awaited<ReturnType<typeof startReaderServer>> | undefined;
  try {
    const large = await createLargeLogProbe(root);
    const logBytes = await readFile(join(root, 'sessions', large.expected.sessionId, 'events.jsonl'));
    const recordCount = logBytes.toString('utf8').trimEnd().split('\n').length;
    assert.equal(BigInt(large.expected.afterSeq) - BigInt(large.expected.beforeSeq), BigInt(2 * LARGE_LOG_RESTORED_PATHS + 1));
    assert.ok(recordCount < INTERFACE_SCAN_BUDGET.records, `${recordCount} records`);
    assert.ok(logBytes.byteLength < INTERFACE_SCAN_BUDGET.bytes, `${logBytes.byteLength} bytes`);
    reader = await startReaderServer({ storeDir: root });
    const response = await fetch(reader.url + large.expected.routeKey, { headers: { authorization: `Bearer ${reader.token}` } });
    const body = await response.json() as { status: string; page: { complete: boolean };
      files: Array<{ path: string; status: string; changes: unknown[] }> };
    assert.equal(response.status, 200);
    assert.deepEqual(validateInterfacePage(body, large.expected), []);
    assert.deepEqual([body.status, body.page.complete, body.files.map(file => file.path)], ['ready', true, ['zz-large-log.ts']]);
    const attempt: InterfaceAttempt = { requestId: 'large', expected: large.expected, startedAtNs: 0n, completedAtNs: 1n,
      httpStatus: 200, body };
    assert.deepEqual(largeLogOutcome(attempt), { outcome: 'ready-complete', faults: [] });
    Object.assign(body.files[0]!, { status: 'identical', changes: [] });
    assert.equal(largeLogOutcome(attempt).outcome, 'unexplained');
    assert.notDeepEqual(largeLogOutcome(attempt).faults, []);
  } finally {
    await reader?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unobservable child-process check fails closed', async () => {
  assert.equal(await childProcessesExit('/nonexistent/pgrep'), false);
  assert.equal(await childProcessesExit(), true);
});

test('isolated load client starts, stops and actually exits without a reader', async () => {
  const priorArgv = process.argv[1];
  // Match the registered command's parent argv[1]. A file-backed worker sees
  // its own script as argv[1]; the imported bench module must not run its CLI.
  process.argv[1] = fileURLToPath(new URL('./fd5-bench.ts', import.meta.url));
  let worker: Worker;
  try {
    worker = new Worker(new URL('./fd5-load-worker.ts', import.meta.url), {
      workerData: { kind: 'interface', url: 'http://127.0.0.1:1', token: 'unused', corpus: [], slots: 16 },
    });
  } finally {
    if (priorArgv === undefined) process.argv.splice(1, 1);
    else process.argv[1] = priorArgv;
  }
  try {
    const [started] = await once(worker, 'message', { signal: AbortSignal.timeout(5_000) });
    assert.equal(started.type, 'started');
    const summary = once(worker, 'message', { signal: AbortSignal.timeout(5_000) });
    const exit = once(worker, 'exit', { signal: AbortSignal.timeout(5_000) });
    worker.postMessage('stop');
    const [result] = await summary;
    assert.equal(result.type, 'summary');
    assert.equal(result.summary.corpusExhausted, true);
    assert.deepEqual(result.summary.attempts, []);
    const [code] = await exit;
    assert.equal(code, 0);
  } finally { await worker.terminate(); }
});

test('real authenticated reader events join TS, TSX and Swift HTTP responses through collector and actual exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-trace-test-'));
  const collector = createProjectionTraceCollector();
  let reader: Awaited<ReturnType<typeof startReaderServer>> | undefined;
  try {
    const corpus = await createInterfaceCorpus(root, 3);
    reader = await startReaderServer({ storeDir: root, projectionTrace: collector.observe,
      interfaceDeadlineMs: 30_000 });
    const attempts: InterfaceAttempt[] = [];
    for (const [index, page] of corpus.entries()) {
      const startedAtNs = process.hrtime.bigint();
      const response = await fetch(reader.url + page.expected.routeKey,
        { headers: { authorization: `Bearer ${reader.token}` } });
      const body: unknown = await response.json();
      attempts.push({ requestId: String(index), expected: page.expected, startedAtNs,
        completedAtNs: process.hrtime.bigint(), httpStatus: response.status, body });
    }
    await reader.close(); reader = undefined;
    const observed = collector.snapshot();
    const assembled = assembleProjectionTrace(observed.events, attempts);
    assert.deepEqual(observed.faults, []);
    for (const phase of ['interface:range-scan', 'interface:cas-read', 'interface:cas-hash',
      'typescript:grammar-load', 'typescript:parse-compare', 'typescript:worker-startup',
      'typescript:worker-roundtrip', 'swift:grammar-load', 'swift:parse-compare',
      'swift:child-startup', 'swift:child-lifecycle', 'interface:serialization', 'interface:http-completion'])
      assert.ok((observed.phases[phase]?.count ?? 0) > 0, `missing ${phase} timing`);
    assert.deepEqual(assembled.faults, []);
    assert.equal(assembled.processExitsVerified, true);
    assert.deepEqual(assembled.traces.map(trace => trace.outcome), ['ok', 'ok', 'ok']);
    assert.equal(observed.events.filter(event => event.kind === 'parser-request').length, 3);
    assert.equal(new Set(assembled.processUses.map(use => use.unitId)).size, 3);
    for (const [index, trace] of assembled.traces.entries()) {
      const phases = ['interface:range-scan', 'interface:cas-read', 'interface:cas-hash',
        ...(corpus[index]!.expected.language === 'swift'
          ? ['swift:grammar-load', 'swift:parse-compare', 'swift:child-startup', 'swift:child-lifecycle']
          : ['typescript:grammar-load', 'typescript:parse-compare', 'typescript:worker-roundtrip'])];
      for (const phase of phases) assert.ok(observed.unitPhases.get(trace.unitId)?.has(phase),
        `unit ${trace.unitId} lacks ${phase}`);
    }
    for (const page of corpus) assert.deepEqual(observed.routePhases.get(page.expected.routeKey),
      { serialization: 1, completion: 1 });
    assert.deepEqual(assembled.attempts.map(attempt => Object.values(attempt.freshnessByPath ?? {})),
      [['fresh'], ['fresh'], ['fresh']]);
    assert.equal(observed.events.filter(event => event.kind === 'process-start').length,
      observed.events.filter(event => event.kind === 'process-exit').length);
  } finally {
    await reader?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('real clip cache bypass is separate from admission and blob loss forces a new compute', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-clip-trace-'));
  const collector = createProjectionTraceCollector();
  let reader: Awaited<ReturnType<typeof startReaderServer>> | undefined;
  try {
    const [change] = await createHistoricalCorpus(root, 1);
    const routeKey = `/v1/sessions/${change!.sessionId}/changes/${change!.seq}/clips`;
    reader = await startReaderServer({ storeDir: root, projectionTrace: collector.observe,
      projectionAdmissionConfig: { C: 1, Q: 1, W: 1, D: 5_000 } });
    const responses: ClipResponse[] = [];
    for (let index = 0; index < 3; index++) {
      if (index === 2) await unlink(blobPath(root, change!.key.split('/')[0]!));
      const startedAtNs = process.hrtime.bigint();
      const response = await fetch(reader.url + routeKey,
        { headers: { authorization: `Bearer ${reader.token}` } });
      const body = await response.json() as { status: string; fallback_reason?: string };
      responses.push({ httpStatus: response.status, status: body.status, reason: body.fallback_reason,
        latencyMs: 0, routeKey, startedAtNs, completedAtNs: process.hrtime.bigint() });
    }
    await reader.close(); reader = undefined;
    const assembled = assembleProjectionTrace(collector.snapshot().events, []);
    assert.deepEqual(assembled.faults, []);
    assert.equal(assembled.traces.filter(trace => trace.workload === 'clip').length, 2);
    assert.equal(assembled.clipCacheBypasses.length, 1);
    assert.match(scoreClipTrace([responses[0]!, responses[2]!], assembled.traces,
      assembled.clipCacheBypasses).join(' '), /cold clip did not produce ready/);
    assert.match(scoreClipTrace(responses, assembled.traces, assembled.clipCacheBypasses).join(' '),
      /cache|admission/);
  } finally {
    await reader?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelled TypeScript worker and Swift child report actual exits', async () => {
  const tsEvents: ProjectionTraceEvent[] = [];
  const pool = createTypeScriptPool(event => tsEvents.push(event));
  try {
    const task = pool.run({ language: 'typescript', before: Buffer.from('function f(): number { return 1 }'),
      after: Buffer.from('function f(): string { return "x" }') }, 71);
    task.cancel();
    await assert.rejects(task.promise);
  } finally { await pool.close(); }
  const tsRetired = tsEvents.find(event => event.kind === 'process-retire');
  assert.ok(tsRetired);
  assert.ok(tsEvents.some(event => event.kind === 'process-exit' && event.processId === tsRetired.processId));

  const swiftEvents: ProjectionTraceEvent[] = [];
  const controller = new AbortController();
  await assert.rejects(extractSwiftSides([{ id: 'before', bytes: Buffer.from('func f(x: Int) -> Int { x }') }], {
    signal: controller.signal, traceUnitId: 72, trace: event => {
      swiftEvents.push(event);
      if (event.kind === 'process-start' && event.process === 'swift-child') controller.abort();
    },
  }), SwiftExtractCancelled);
  const swiftStart = swiftEvents.find((event): event is Extract<ProjectionTraceEvent, { kind: 'process-start' }> =>
    event.kind === 'process-start' && event.process === 'swift-child');
  assert.ok(swiftStart);
  assert.ok(swiftEvents.some(event => event.kind === 'process-exit' && event.processId === swiftStart.processId));
});
