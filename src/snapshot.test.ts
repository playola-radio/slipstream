import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotsEqual } from './snapshot.ts';
import { content } from './test/helpers.ts';

describe('snapshot', () => {
  describe('snapshotsEqual', () => {
    it('treats two content snapshots as equal only when their hashes match', () => {
      assert.equal(snapshotsEqual(content('a'), content('a')), true);
      assert.equal(snapshotsEqual(content('a'), content('b')), false);
    });

    it('does not globally deduplicate an A -> B -> A cycle', () => {
      // Suppression compares only consecutive states, so returning to a prior
      // hash is still a real transition the caller must emit.
      const a = content('aaa');
      const b = content('bbb');
      assert.equal(snapshotsEqual(a, b), false);
      assert.equal(snapshotsEqual(b, a), false);
    });

    it('treats absent as equal to absent but never to content', () => {
      assert.equal(snapshotsEqual({ kind: 'absent' }, { kind: 'absent' }), true);
      assert.equal(snapshotsEqual({ kind: 'absent' }, content('a')), false);
    });

    it('treats unavailable snapshots as equal only when the reason matches', () => {
      assert.equal(
        snapshotsEqual({ kind: 'unavailable', reason: 'oversize' }, { kind: 'unavailable', reason: 'oversize' }),
        true,
      );
      assert.equal(
        snapshotsEqual({ kind: 'unavailable', reason: 'oversize' }, { kind: 'unavailable', reason: 'unreadable' }),
        false,
      );
    });

    it('treats a file becoming unreadable as a real transition, not identical', () => {
      assert.equal(snapshotsEqual(content('a'), { kind: 'unavailable', reason: 'unreadable' }), false);
    });
  });
});
