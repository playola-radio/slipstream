import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { percentile } from './bench.ts';

describe('bench', () => {
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
