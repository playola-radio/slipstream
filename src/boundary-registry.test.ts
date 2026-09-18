import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBoundaryRegistry } from './boundary-registry.ts';
import { staticBoundary } from './reader-runtime.ts';
import { createHealth } from './health.ts';

const ID = '11111111-1111-4111-8111-111111111111';

describe('boundary registry', () => {
  it('reserve exposes a zero boundary before capture commits anything', () => {
    const reg = createBoundaryRegistry();
    reg.reserve(ID);
    assert.equal(reg.get(ID)?.boundary.current(), 0n);
  });

  it('activate swaps in a live boundary that tracks the session health', () => {
    const reg = createBoundaryRegistry();
    const health = createHealth(0n);
    reg.reserve(ID);
    reg.activate(ID, liveOf(health));
    assert.equal(reg.get(ID)?.boundary.current(), 0n);
    health.setDurableSeq(5n);
    assert.equal(reg.get(ID)?.boundary.current(), 5n);
  });

  it('freeze pins the boundary at the final durable seq', () => {
    const reg = createBoundaryRegistry();
    reg.reserve(ID);
    reg.freeze(ID, 9n);
    assert.equal(reg.get(ID)?.boundary.current(), 9n);
  });

  it('activate aborts and clears the session followers so they reconnect', () => {
    const reg = createBoundaryRegistry();
    reg.reserve(ID);
    const ac = new AbortController();
    reg.addFollower(ID, ac);
    reg.activate(ID, staticBoundary(3n));
    assert.equal(ac.signal.aborted, true);
    // The set is cleared: a second transition must not double-abort a stale ref.
    const ac2 = new AbortController();
    reg.addFollower(ID, ac2);
    reg.freeze(ID, 3n);
    assert.equal(ac2.signal.aborted, true);
  });

  it('freeze aborts the session followers', () => {
    const reg = createBoundaryRegistry();
    reg.reserve(ID);
    const ac = new AbortController();
    reg.addFollower(ID, ac);
    reg.freeze(ID, 1n);
    assert.equal(ac.signal.aborted, true);
  });

  it('removeFollower unregisters a follower that finished on its own', () => {
    const reg = createBoundaryRegistry();
    reg.reserve(ID);
    const ac = new AbortController();
    reg.addFollower(ID, ac);
    reg.removeFollower(ID, ac);
    reg.activate(ID, staticBoundary(2n));
    assert.equal(ac.signal.aborted, false);
  });

  it('installIfAbsent creates a retained entry but never overwrites a live one', () => {
    const reg = createBoundaryRegistry();
    reg.reserve(ID);
    reg.activate(ID, staticBoundary(7n));
    const entry = reg.installIfAbsent(ID, staticBoundary(1n));
    assert.equal(entry.boundary.current(), 7n); // kept the live one
    const other = '22222222-2222-4222-8222-222222222222';
    const created = reg.installIfAbsent(other, staticBoundary(4n));
    assert.equal(created.boundary.current(), 4n);
    assert.equal(reg.get(other)?.boundary.current(), 4n);
  });

  it('ids enumerates known sessions', () => {
    const reg = createBoundaryRegistry();
    reg.reserve(ID);
    reg.reserve('22222222-2222-4222-8222-222222222222');
    assert.deepEqual(reg.ids().sort(), [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });
});

function liveOf(health: ReturnType<typeof createHealth>) {
  // A tiny live boundary over health for the activate test (mirrors
  // reader-runtime.liveBoundary without pulling in the abort machinery).
  return {
    current: () => BigInt(health.snapshot().durable_seq),
    waitForAdvance: () => new Promise<void>(() => {}),
  };
}
