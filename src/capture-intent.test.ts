import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CAPTURES, admitCapture, emptyIntent, forgetSession, linkBinding, linkedCount, revokeBinding, runningCount, withdrawCapture,
  findLinked,
} from './capture-intent.ts';

const capture = (n: number) => ({ session_id: `s${n}`, root: `/w/${n}`, root_identity: null });
const chat = (n: number) => ({
  session_id: `s${n}`, harness: 'claude-code' as const, harness_session_id: `chat-${n}`,
  canonical_worktree: `/w/${n}`, verified_transcript_path: `/t/${n}.jsonl`,
});

describe('capture intent', () => {
  it('admits sixteen running captures and the seventeenth as waiting', () => {
    const record = emptyIntent();
    for (let i = 0; i < MAX_CAPTURES; i++) assert.equal(admitCapture(record, capture(i)).intent, 'running');
    assert.equal(admitCapture(record, capture(16)).intent, 'waiting');
    assert.equal(runningCount(record), 16);
  });

  it('counts in-flight admissions against the cap', () => {
    const record = emptyIntent();
    for (let i = 0; i < 15; i++) admitCapture(record, capture(i));
    assert.equal(admitCapture(record, capture(15), 1).intent, 'waiting');
  });

  it('promotes the oldest waiting capture when a running one is withdrawn', () => {
    const record = emptyIntent();
    for (let i = 0; i < 18; i++) admitCapture(record, capture(i));
    const promoted = withdrawCapture(record, 's3', 'detached');
    assert.equal(promoted?.session_id, 's16');
    assert.equal(promoted?.intent, 'running');
    assert.equal(record.captures.find((c) => c.session_id === 's17')?.intent, 'waiting');
    assert.equal(runningCount(record), 16);
  });

  it('withdrawing a waiting capture frees no slot', () => {
    const record = emptyIntent();
    for (let i = 0; i < 18; i++) admitCapture(record, capture(i));
    assert.equal(withdrawCapture(record, 's17', 'detached'), undefined);
    assert.equal(runningCount(record), 16);
    assert.equal(record.captures.find((c) => c.session_id === 's16')?.intent, 'waiting');
  });

  it('withdraws once and keeps the entry for history', () => {
    const record = emptyIntent();
    admitCapture(record, capture(0));
    withdrawCapture(record, 's0', 'detached');
    assert.equal(withdrawCapture(record, 's0', 'detached'), undefined);
    assert.deepEqual(record.captures.map((c) => [c.intent, c.withdrawn_reason]), [['withdrawn', 'detached']]);
  });

  it('re-admitting a withdrawn session replaces its entry', () => {
    const record = emptyIntent();
    admitCapture(record, capture(0));
    withdrawCapture(record, 's0', 'detached');
    admitCapture(record, capture(0));
    assert.deepEqual(record.captures.map((c) => c.intent), ['running']);
  });

  it('allocates monotonic generations that unlink never reuses', () => {
    const record = emptyIntent();
    assert.equal(linkBinding(record, chat(0)).binding_generation, '1');
    revokeBinding(record, 's0');
    assert.equal(linkBinding(record, chat(0)).binding_generation, '2');
    assert.equal(record.next_binding_generation, '3');
    assert.equal(linkedCount(record), 1);
  });

  it('finds a linked chat by identity and forgets a deleted session', () => {
    const record = emptyIntent();
    admitCapture(record, capture(1));
    linkBinding(record, chat(1));
    assert.equal(findLinked(record, 'claude-code', 'chat-1')?.session_id, 's1');
    assert.equal(findLinked(record, 'codex', 'chat-1'), undefined);
    forgetSession(record, 's1');
    assert.deepEqual([record.captures, record.bindings], [[], []]);
  });
});
