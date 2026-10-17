import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname } from 'node:path';
import { REAL_FILE_SIZE_LOG2_HISTOGRAM, REAL_WORKTREE_FILE_COUNTS, createRng, layoutPaths, sampleFileSize, sampleWorktreeFileCounts } from './plan.ts';

test('the same seed reproduces the same sequence', () => {
  const a = createRng(42), b = createRng(42);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('worktree sizes are drawn only from the sampled real distribution', () => {
  const counts = sampleWorktreeFileCounts(57, createRng(1));
  assert.equal(counts.length, 57);
  assert.ok(counts.every((c) => REAL_WORKTREE_FILE_COUNTS.includes(c)));
});

test('file sizes follow the sampled real size histogram', () => {
  const rng = createRng(7);
  const sizes = Array.from({ length: 50_000 }, () => sampleFileSize(rng));
  const total = Object.values(REAL_FILE_SIZE_LOG2_HISTOGRAM).reduce((a, b) => a + b, 0);
  const share = (lo: number, hi: number) => sizes.filter((s) => s >= lo && s < hi).length / sizes.length;
  assert.ok(Math.abs(share(0, 1) - REAL_FILE_SIZE_LOG2_HISTOGRAM[-1]! / total) < 0.002);
  assert.ok(Math.abs(share(2048, 4096) - REAL_FILE_SIZE_LOG2_HISTOGRAM[11]! / total) < 0.01);
  assert.equal(share(2 ** 22, 2 ** 23), 0, 'a bucket absent from the real data never appears');
  assert.ok(Math.max(...sizes) < 2 ** 26);
});

test('a layout has exactly the requested number of unique paths, at most 40 per directory', () => {
  const paths = layoutPaths(4200);
  assert.equal(paths.length, 4200);
  assert.equal(new Set(paths).size, 4200);
  const perDir = new Map<string, number>();
  for (const p of paths) perDir.set(dirname(p), (perDir.get(dirname(p)) ?? 0) + 1);
  assert.ok(Math.max(...perDir.values()) <= 40);
});
