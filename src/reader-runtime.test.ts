import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHealth } from './health.ts';
import { liveBoundary, staticBoundary } from './reader-runtime.ts';

describe('reader-runtime', () => {
  describe('liveBoundary', () => {
    it('resolves immediately when already advanced', async () => {
      const h = createHealth(5n);
      const b = liveBoundary(h);
      assert.equal(b.current(), 5n);
      await b.waitForAdvance(4n, new AbortController().signal); // returns
    });

    it('resolves when the boundary advances via a health notification', async () => {
      const h = createHealth(2n);
      const b = liveBoundary(h);
      const waited = b.waitForAdvance(2n, new AbortController().signal);
      queueMicrotask(() => h.setDurableSeq(3n));
      await waited;
      assert.equal(b.current(), 3n);
    });

    it('rejects on abort', async () => {
      const h = createHealth(1n);
      const b = liveBoundary(h);
      const ac = new AbortController();
      const waited = b.waitForAdvance(1n, ac.signal);
      ac.abort();
      await assert.rejects(waited);
    });
  });

  describe('staticBoundary', () => {
    it('reports a fixed seq and only settles on abort', async () => {
      const b = staticBoundary(7n);
      assert.equal(b.current(), 7n);
      const ac = new AbortController(); ac.abort();
      await assert.rejects(b.waitForAdvance(7n, ac.signal));
    });
  });
});
