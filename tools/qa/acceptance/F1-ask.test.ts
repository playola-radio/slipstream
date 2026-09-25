import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertAskAcknowledgment, assertQueuedQuestion, f1Ask } from './F1-ask.ts';

const expected = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  questionId: '33333333-3333-4333-8333-333333333333',
  seq: '43',
  text: 'What changed?',
  target: { harness: 'codex' as const, harness_session_id: 'harness-1', worktree: '/qa/worktree' },
  context: {
    change_seq: '42',
    path: 'Sources/App.swift',
    snapshot_sha256: 'a'.repeat(64),
    line_start: 1,
    line_end: 2,
    selected_text: 'first\nsecond',
  },
  queuedAtMs: 1_700_000_000_000,
  expiresAtMs: 1_700_001_800_000,
};

function queuedEvent(data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'slipstream.question.queued.v1',
    seq: '43',
    id: '43',
    source: `urn:slipstream:session:${expected.sessionId}`,
    subject: `question/${expected.questionId}`,
    data: {
      session_id: expected.sessionId,
      question_id: expected.questionId,
      request_id: expected.requestId,
      target: expected.target,
      text: expected.text,
      context: expected.context,
      queued_at_ms: expected.queuedAtMs,
      expires_at_ms: expected.expiresAtMs,
      ...data,
    },
  };
}

describe('F1-ask queued-event checker', () => {
  it('owns its disposable daemon instead of rebinding a caller-provided acceptance daemon', () => {
    assert.equal(f1Ask.needsDaemon, false);
  });
  it('rejects an absent queued record and a corrupted identity or selected context', () => {
    assert.throws(() => assertQueuedQuestion([], expected), /exactly one queued/i);
    assert.throws(
      () => assertQueuedQuestion([queuedEvent({ request_id: '44444444-4444-4444-8444-444444444444' })], expected),
      /request_id/i,
    );
    assert.throws(
      () => assertQueuedQuestion([{ ...queuedEvent(), id: '44' }], expected),
      /id/i,
    );
    assert.throws(
      () => assertQueuedQuestion([queuedEvent({ target: { ...expected.target, worktree: '/wrong' } })], expected),
      /target\.worktree/i,
    );
    assert.throws(
      () => assertQueuedQuestion([queuedEvent({ context: { ...expected.context, selected_text: 'wrong' } })], expected),
      /selected_text/i,
    );
  });

  it('rejects malformed and identity-mismatched CLI acknowledgments', () => {
    const ack = {
      v: 1, ok: true, session_id: expected.sessionId, request_id: expected.requestId,
      question_id: expected.questionId, seq: '43', queued_at_ms: expected.queuedAtMs,
      expires_at_ms: expected.expiresAtMs, duplicate: false,
    };
    assert.throws(() => assertAskAcknowledgment({ ...ack, session_id: 'wrong' }, expected.sessionId, expected.requestId, false), /session_id/i);
    assert.throws(() => assertAskAcknowledgment({ ...ack, ok: false }, expected.sessionId, expected.requestId, false), /v1 successful/i);
  });
});
