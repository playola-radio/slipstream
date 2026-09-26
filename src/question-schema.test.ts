import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { foldDisplay } from './display-fold.ts';
import { buildPublicEnvelope } from './public-events.ts';
import { loadSchema, validate } from './schema.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const QUESTION = '4a32f01b-4e43-4f78-bb25-d7d4b4a8c030';
const REQUEST = '8ed82b30-2dd8-4f6d-9c5d-4b6e5b89c567';

function queuedQuestion(): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: '9007199254741001',
    source: `urn:slipstream:session:${SESSION}`,
    type: 'slipstream.question.queued.v1',
    datacontenttype: 'application/json',
    seq: '9007199254741001',
    time: '2026-09-17T15:00:00.123Z',
    subject: `question/${QUESTION}`,
    data: {
      session_id: SESSION,
      question_id: QUESTION,
      request_id: REQUEST,
      target: { harness: 'codex', harness_session_id: 'harness-session', worktree: '/tmp/worktree' },
      text: 'Why did this change?',
      context: {
        change_seq: '9007199254741001',
        path: 'src/a.ts',
        snapshot_sha256: 'a'.repeat(64),
        line_start: 3,
        line_end: 5,
        selected_text: 'const answer = 42;',
      },
      queued_at_ms: 1789657200123,
      expires_at_ms: 1789659000123,
    },
  };
}

describe('slipstream.question.queued.v1 schema', () => {
  it('validates a durable dispatch attempt with the same public question identity', async () => {
    const event = buildPublicEnvelope({ type: 'slipstream.question.dispatch_attempted.v1',
      occurred_at_ms: 1789657200123,
      data: { question_id: QUESTION, queued_seq: '4', attempted_at_ms: 1789657200123 },
    }, 5n, SESSION);
    assert.equal(event.subject, `question/${QUESTION}`);
    assert.deepEqual(validate(await loadSchema(event.type), event), []);
    const bad = { ...event, data: { ...event.data, queued_seq: 4 } };
    assert.ok(validate(await loadSchema(event.type), bad).length > 0);
  });
  it('validates a durable answer with the same public question identity', async () => {
    const event = buildPublicEnvelope({ type: 'slipstream.question.answered.v1',
      occurred_at_ms: 1789657200123,
      data: { question_id: QUESTION, attempt_seq: '5', text: 'Because.', answered_at_ms: 1789657200123 },
    }, 6n, SESSION);
    assert.equal(event.id, '6');
    assert.equal(event.subject, `question/${QUESTION}`);
    assert.equal(event.time, '2026-09-17T15:00:00.123Z');
    assert.deepEqual(event.data, { question_id: QUESTION, attempt_seq: '5', text: 'Because.', answered_at_ms: 1789657200123, session_id: SESSION });
    assert.deepEqual(validate(await loadSchema(event.type), event), []);
    assert.deepEqual(foldDisplay([event]), { contract: 'display-fold.v1', result: 'ok',
      state: { attributions: [], coverage: [], evidence: [], gaps: [] } });
  });

  for (const [name, patch] of [
    ['a numeric attempt sequence', { attempt_seq: 5 }],
    ['an empty answer', { text: '' }],
    ['an answer longer than 16384 characters', { text: 'a'.repeat(16385) }],
    ['a negative answer timestamp', { answered_at_ms: -1 }],
    ['a non-canonical question id', { question_id: 'ABC' }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`rejects an answer with ${name}`, async () => {
      const event = buildPublicEnvelope({ type: 'slipstream.question.answered.v1', occurred_at_ms: 1,
        data: { question_id: QUESTION, attempt_seq: '5', text: 'Because.', answered_at_ms: 1 } }, 6n, SESSION);
      const bad = { ...event, data: { ...event.data, ...patch } };
      assert.ok(validate(await loadSchema('slipstream.question.answered.v1'), bad).length > 0);
    });
  }

  it('accepts the durable D1 record and additive future fields', async () => {
    const event = queuedQuestion();
    event.future_envelope_field = true;
    (event.data as Record<string, unknown>).future_data_field = 'additive';
    assert.deepEqual(validate(await loadSchema('slipstream.question.queued.v1'), event), []);
  });

  it('validates the public builder output without losing a huge decimal sequence', async () => {
    const seq = 9007199254741001n;
    const data = queuedQuestion().data as Record<string, unknown>;
    const event = buildPublicEnvelope({
      type: 'slipstream.question.queued.v1',
      occurred_at_ms: 1789657200123,
      data: {
        question_id: data.question_id as string,
        request_id: data.request_id as string,
        target: data.target as { harness: 'codex'; harness_session_id: string; worktree: string },
        text: data.text as string,
        context: data.context as {
          change_seq: string; path: string; snapshot_sha256: string;
          line_start: number; line_end: number; selected_text: string;
        },
        queued_at_ms: data.queued_at_ms as number,
        expires_at_ms: data.expires_at_ms as number,
      },
    }, seq, SESSION);
    assert.equal(event.seq, seq.toString());
    assert.equal(event.id, seq.toString());
    assert.equal(event.subject, `question/${QUESTION}`);
    assert.deepEqual(validate(await loadSchema(event.type), event), []);
  });

  it('consumes a queued-question sequence without adding display rows', () => {
    const event = queuedQuestion();
    const folded = foldDisplay([event]);
    assert.deepEqual(folded, {
      contract: 'display-fold.v1',
      result: 'ok',
      state: { attributions: [], coverage: [], evidence: [], gaps: [] },
    });
  });

  for (const [name, mutate] of [
    ['a missing question subject', (event: Record<string, unknown>) => { delete event.subject; }],
    ['a non-canonical question id', (event: Record<string, unknown>) => { (event.data as Record<string, unknown>).question_id = 'ABC'; }],
    ['a non-canonical request id', (event: Record<string, unknown>) => { (event.data as Record<string, unknown>).request_id = 'ABC'; }],
    ['a numeric change sequence', (event: Record<string, unknown>) => { ((event.data as Record<string, unknown>).context as Record<string, unknown>).change_seq = 9; }],
    ['a non-hex source hash', (event: Record<string, unknown>) => { ((event.data as Record<string, unknown>).context as Record<string, unknown>).snapshot_sha256 = 'ABC'; }],
    ['an invalid target harness', (event: Record<string, unknown>) => { ((event.data as Record<string, unknown>).target as Record<string, unknown>).harness = 'other'; }],
    ['a missing target worktree', (event: Record<string, unknown>) => { delete ((event.data as Record<string, unknown>).target as Record<string, unknown>).worktree; }],
    ['a fractional line range', (event: Record<string, unknown>) => { ((event.data as Record<string, unknown>).context as Record<string, unknown>).line_start = 1.5; }],
    ['a negative queued timestamp', (event: Record<string, unknown>) => { (event.data as Record<string, unknown>).queued_at_ms = -1; }],
    ['a negative expiry timestamp', (event: Record<string, unknown>) => { (event.data as Record<string, unknown>).expires_at_ms = -1; }],
  ] as Array<[string, (event: Record<string, unknown>) => void]>) {
    it(`rejects ${name}`, async () => {
      const event = queuedQuestion();
      mutate(event);
      assert.ok(validate(await loadSchema('slipstream.question.queued.v1'), event).length > 0);
    });
  }
});
