import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterfaceCorpus, validateConfig } from './fd5-bench.ts';
import { createTypeScriptInterfaceExtractor } from '../src/interface-v2-typescript.ts';
import { compareStructuredExtractions } from '../src/interface-v2-comparison.ts';
import { createCas } from '../src/cas.ts';
import { extractSwiftSides } from '../src/swift-interface.ts';
import { compareV2 } from '../src/interface-v2-core.ts';
import { Worker } from 'node:worker_threads';

test('registered config preserves fixed B2 limits and requires an explicit finite cold corpus', async () => {
  const config = JSON.parse(await readFile(new URL('./fd5-provisional-config.json', import.meta.url), 'utf8'));
  assert.equal(validateConfig(config).requestSlots, 16);
  assert.equal(validateConfig({ ...config, admission: { ...config.admission, Q: 0, W: 0 } }).admission.Q, 0);
  for (const change of [
    { requestSlots: 15 }, { repetitions: 2 }, { scheduledWrites: 99 }, { burstWrites: 99 },
    { admission: { ...config.admission, clipDeadlineMs: 101 } },
    { interfaceCorpusPages: 100 }, { clipCorpusChanges: 100 },
  ]) assert.throws(() => validateConfig({ ...config, ...change }));
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
  const worker = new Worker(new URL('./fd5-load-worker.ts', import.meta.url), {
    workerData: { kind: 'interface', url: 'http://127.0.0.1:1', token: 'unused', corpus: [], slots: 16 },
  });
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
