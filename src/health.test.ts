import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHealth } from './health.ts';

describe('health', () => {
  it('starts in the starting state with the seeded durable seq', () => {
    const h = createHealth(7n);
    const snap = h.snapshot();
    assert.equal(snap.state, 'starting');
    assert.equal(snap.durable_seq, '7');
    assert.equal(snap.gap_pending, false);
    assert.equal(snap.failure, undefined);
  });

  it('reports the latest durable seq as a decimal string', () => {
    const h = createHealth();
    assert.equal(h.snapshot().durable_seq, '0');
    h.setDurableSeq(42n);
    assert.equal(h.snapshot().durable_seq, '42');
  });

  it('enters failing with the triggering failure and a pending gap', () => {
    const h = createHealth();
    h.markHealthy();
    h.markFailing({ code: 'ENOSPC', operation: 'append', detected_at_ms: 100 });
    const snap = h.snapshot();
    assert.equal(snap.state, 'failing');
    assert.equal(snap.gap_pending, true);
    assert.deepEqual(snap.failure, { code: 'ENOSPC', operation: 'append', detected_at_ms: 100 });
  });

  it('keeps the first failure of an outage across repeated markFailing calls', () => {
    const h = createHealth();
    h.markFailing({ code: 'ENOSPC', operation: 'append', detected_at_ms: 100 });
    h.markFailing({ code: 'EIO', operation: 'append', detected_at_ms: 200 });
    assert.equal(h.snapshot().failure?.detected_at_ms, 100);
    assert.equal(h.snapshot().failure?.code, 'ENOSPC');
  });

  it('clears the failure and the pending gap once healthy again', () => {
    const h = createHealth();
    h.markFailing({ code: 'ENOSPC', operation: 'append', detected_at_ms: 100 });
    h.markHealthy();
    const snap = h.snapshot();
    assert.equal(snap.state, 'healthy');
    assert.equal(snap.failure, undefined);
    assert.equal(snap.gap_pending, false);
  });

  it('reports recovering while a repair is in progress', () => {
    const h = createHealth();
    h.markFailing({ code: 'ENOSPC', operation: 'append', detected_at_ms: 100 });
    h.markRecovering();
    assert.equal(h.snapshot().state, 'recovering');
  });
});

describe('health subscribe', () => {
  it('notifies listeners on setDurableSeq and stops after unsubscribe', () => {
    const h = createHealth();
    let calls = 0;
    const off = h.subscribe(() => { calls += 1; });
    h.setDurableSeq(1n);
    h.setDurableSeq(2n);
    assert.equal(calls, 2);
    off();
    h.setDurableSeq(3n);
    assert.equal(calls, 2);
    assert.equal(h.snapshot().durable_seq, '3');
  });
});
