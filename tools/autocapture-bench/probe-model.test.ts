import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPath, isMetadataOp } from './probe-model.ts';

const roots = { worktrees: '/t/wt', store: '/t/store', transcripts: '/t/homes' };

test('paths are classified by the root they live under', () => {
  assert.equal(classifyPath('/t/wt/w3/src/a.txt', roots), 'worktree');
  assert.equal(classifyPath('/t/store/blobs/ab/cd', roots), 'store');
  assert.equal(classifyPath('/t/homes/codex/sessions/x.jsonl', roots), 'transcript');
  assert.equal(classifyPath('/usr/bin/git', roots), 'other');
});

test('a sibling directory sharing a name prefix is not under the root', () => {
  assert.equal(classifyPath('/t/wt2/a', roots), 'other');
});

test('store and session lock files are counted apart from other store I/O', () => {
  assert.equal(classifyPath('/t/store/owner.lock', roots), 'lock');
  assert.equal(classifyPath('/t/store/sessions/abc/owner.lock', roots), 'lock');
});

test('resolving or probing a path is metadata; listing, stat-ing or reading is not', () => {
  for (const op of ['realpath', 'realpathSync', 'access', 'existsSync']) assert.equal(isMetadataOp(op), true, op);
  for (const op of ['readdir', 'lstat', 'stat', 'open', 'readFile', 'fh.read']) assert.equal(isMetadataOp(op), false, op);
});
