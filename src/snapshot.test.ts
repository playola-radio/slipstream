import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotsEqual, type Snapshot } from './snapshot.ts';

const content = (sha: string, size = 1): Snapshot => ({ kind: 'content', sha256: sha, size });

test('two content snapshots are equal only when their hashes match', () => {
  assert.equal(snapshotsEqual(content('a'), content('a')), true);
  assert.equal(snapshotsEqual(content('a'), content('b')), false);
});

test('an A -> B -> A cycle is not globally deduplicated', () => {
  // Suppression compares only consecutive states, so returning to a prior
  // hash is still a real transition the caller must emit.
  const a = content('aaa');
  const b = content('bbb');
  assert.equal(snapshotsEqual(a, b), false);
  assert.equal(snapshotsEqual(b, a), false);
});

test('absent equals absent but never equals content', () => {
  assert.equal(snapshotsEqual({ kind: 'absent' }, { kind: 'absent' }), true);
  assert.equal(snapshotsEqual({ kind: 'absent' }, content('a')), false);
});

test('unavailable snapshots are equal only when the reason matches', () => {
  assert.equal(
    snapshotsEqual({ kind: 'unavailable', reason: 'oversize' }, { kind: 'unavailable', reason: 'oversize' }),
    true,
  );
  assert.equal(
    snapshotsEqual({ kind: 'unavailable', reason: 'oversize' }, { kind: 'unavailable', reason: 'unreadable' }),
    false,
  );
});

test('a file becoming unreadable is a real transition, not identical', () => {
  assert.equal(snapshotsEqual(content('a'), { kind: 'unavailable', reason: 'unreadable' }), false);
});
