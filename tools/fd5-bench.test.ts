import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterfaceCorpus, validateConfig } from './fd5-bench.ts';
import { createTypeScriptInterfaceExtractor } from '../src/interface-v2-typescript.ts';
import { compareStructuredExtractions } from '../src/interface-v2-comparison.ts';
import { createCas } from '../src/cas.ts';

test('registered config preserves fixed B2 limits and requires an explicit finite cold corpus', async () => {
  const config = JSON.parse(await readFile(new URL('./fd5-provisional-config.json', import.meta.url), 'utf8'));
  assert.equal(validateConfig(config).requestSlots, 16);
  for (const change of [
    { requestSlots: 15 }, { repetitions: 2 }, { scheduledWrites: 99 }, { burstWrites: 99 },
    { admission: { ...config.admission, clipDeadlineMs: 101 } },
    { interfaceCorpusPages: 100 }, { clipCorpusChanges: 100 },
  ]) assert.throws(() => validateConfig({ ...config, ...change }));
});

test('disposable interface corpus has unique cold keys and mixed 1/4/16-file ranges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-corpus-test-'));
  try {
    const pages = await createInterfaceCorpus(root, 3);
    assert.deepEqual(pages.map(p => p.limit), [1, 4, 16]);
    assert.deepEqual(pages.map(p => p.expected.files.length), [1, 4, 16]);
    assert.equal(new Set(pages.map(p => p.expected.key)).size, 3);
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

test('TS and TSX corpus variants retain the pinned expected structured changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-expected-test-'));
  try {
    const pages = await createInterfaceCorpus(root, 3);
    const cas = await createCas(join(root, 'blobs'));
    for (const [grammar, extension] of [['typescript', '.ts'], ['tsx', '.tsx']] as const) {
      const file = pages.flatMap(p => p.expected.files).find(f => f.path.endsWith(extension))!;
      const extract = await createTypeScriptInterfaceExtractor(grammar);
      const before = extract(await cas.read(file.beforeSha256));
      const after = extract(await cas.read(file.afterSha256));
      const comparison = compareStructuredExtractions(before, after);
      assert.equal(comparison.status, 'ready');
      if (comparison.status === 'ready') assert.deepEqual(comparison.changes, file.changes);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
