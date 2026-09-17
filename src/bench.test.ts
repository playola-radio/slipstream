import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { percentile, readBenchRecords, waitForSettled } from './bench.ts';
import { withTempDir } from './test/helpers.ts';

describe('bench', () => {
  it('requires at least 500 ms of quiet before delivery is settled', async () => {
    let now = 0;
    const lengths = [1, 1, 2, 2, 2, 2, 2, 2];
    let reads = 0;
    await waitForSettled(
      async () => Array.from({ length: lengths[Math.min(reads++, lengths.length - 1)]! }),
      async (ms) => { now += ms; },
      () => now,
    );
    assert.ok(now >= 600, `settled after only ${now} ms`);
  });

  it('ignores an incomplete trailing JSONL record while polling', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'events.jsonl');
      const complete = { type: 'capture.gap', path: '', reason: 'watcher-error', observed_at_ms: 1, committed_at_ms: 2 };
      await writeFile(path, `${JSON.stringify(complete)}\n{"type":"file.changed"`);
      assert.deepEqual(await readBenchRecords(path), [complete]);
    });
  });

  describe('percentile', () => {
    it('returns the single value for a one-element sample', () => {
      assert.equal(percentile([42], 50), 42);
      assert.equal(percentile([42], 99), 42);
    });

    it('uses nearest-rank so p50 and p99 land on real observed samples', () => {
      const sorted = [10, 20, 30, 40, 50];
      assert.equal(percentile(sorted, 50), 30);
      assert.equal(percentile(sorted, 99), 50);
    });

    it('returns NaN for an empty sample rather than a misleading zero', () => {
      assert.ok(Number.isNaN(percentile([], 50)));
    });
  });
});
