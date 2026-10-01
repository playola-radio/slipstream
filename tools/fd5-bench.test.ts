import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterfaceCorpus, validateConfig } from './fd5-bench.ts';
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
import { INTERFACE_PAGE_DEADLINE_MS } from '../src/interface-service.ts';
import { assembleProjectionTrace, scoreClipTrace, type InterfaceAttempt } from './fd5-score.ts';
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
  ]) assert.throws(() => validateConfig({ ...config, ...change }));
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
