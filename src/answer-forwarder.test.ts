import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardAnswer } from './answer-forwarder.ts';
import { OutcomeUnknownError } from './control-client.ts';
import type { RequestEnvelope, ResponseEnvelope, ControlErrorCode } from './control-protocol.ts';
import type { Identity } from './harness-context.ts';

const IDENTITY: Identity = { harness: 'codex', harness_session_id: 'thread-1', worktree: '/repos/w' };
const QUESTION = '11111111-1111-4111-8111-111111111111';

function scriptedSend(steps: Array<ResponseEnvelope | Error>) {
  const sent: RequestEnvelope[] = [];
  let i = 0;
  const send = async (request: RequestEnvelope): Promise<ResponseEnvelope> => {
    sent.push(structuredClone(request));
    const step = steps[i++];
    if (step === undefined) throw new Error('scriptedSend exhausted');
    if (step instanceof Error) throw step;
    return step;
  };
  return { send, sent };
}

const ACK = { session_id: 'cap-1', question_id: QUESTION, event_id: '8', seq: '8', answered_at_ms: 1000, duplicate: false };
const ok = (fields: Record<string, unknown> = ACK): ResponseEnvelope => ({ v: 1, ok: true, ...fields });
const err = (code: ControlErrorCode, message = 'msg'): ResponseEnvelope => ({ v: 1, ok: false, code, message });
const unknown = () => new OutcomeUnknownError('reply lost');
const answer = (send: (r: RequestEnvelope) => Promise<ResponseEnvelope>, identity: Identity | { unresolved: string } = IDENTITY) =>
  forwardAnswer({ identity, questionId: QUESTION, text: ' Because.\n', send });

test('an unresolved identity is refused without contacting the daemon', async () => {
  const { send, sent } = scriptedSend([]);
  const res = await answer(send, { unresolved: 'no threadId' });
  assert.deepEqual(res, { text: 'IDENTITY_UNRESOLVED: no threadId', isError: true, structured: { code: 'IDENTITY_UNRESOLVED' } });
  assert.equal(sent.length, 0);
});

test('a matching ack is reported as recorded with the ack as structured content', async () => {
  const { send, sent } = scriptedSend([ok()]);
  const res = await answer(send);
  assert.deepEqual(res, { text: `Answer recorded for question ${QUESTION} (seq 8).`, isError: false, structured: ACK });
  assert.deepEqual(sent, [{ v: 1, verb: 'answer_question', question_id: QUESTION, text: ' Because.\n',
    harness: 'codex', harness_session_id: 'thread-1', worktree: '/repos/w' }]);
});

test('every first-send rejection passes through once without a resend', async () => {
  for (const code of ['SESSION_NOT_SELECTED', 'CAPTURE_NOT_READY', 'STORAGE_UNAVAILABLE', 'INVALID_ANSWER',
    'QUESTION_NOT_FOUND', 'ANSWER_CONFLICT', 'DAEMON_UNAVAILABLE', 'PROTOCOL'] as ControlErrorCode[]) {
    const { send, sent } = scriptedSend([err(code, 'why')]);
    assert.deepEqual(await answer(send), { text: `${code}: why`, isError: true, structured: { code } });
    assert.equal(sent.length, 1);
  }
});

test('a lost reply or a mismatched ack is resolved by one identical resend', async () => {
  for (const first of [unknown(), ok({ ...ACK, question_id: '22222222-2222-4222-8222-222222222222' }),
    ok({ ...ACK, seq: '' }), ok({ ...ACK, event_id: '9' }), ok({}),
    ok({ ...ACK, seq: 'x', event_id: 'x' }), ok({ ...ACK, seq: '08', event_id: '08' }),
    ok({ question_id: QUESTION, event_id: '8', seq: '8' }), ok({ ...ACK, session_id: '' }),
    ok({ ...ACK, answered_at_ms: '1000' }), ok({ ...ACK, duplicate: 'false' })]) {
    const { send, sent } = scriptedSend([first, ok({ ...ACK, duplicate: true })]);
    const res = await answer(send);
    assert.equal(res.isError, false);
    assert.deepEqual(res.structured, { ...ACK, duplicate: true });
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);
  }
});

test('on the resend only structural rejections are definitive', async () => {
  for (const code of ['INVALID_ANSWER', 'IDENTITY_UNRESOLVED', 'ANSWER_CONFLICT'] as ControlErrorCode[]) {
    const { send } = scriptedSend([unknown(), err(code, 'why')]);
    assert.deepEqual(await answer(send), { text: `${code}: why`, isError: true, structured: { code } });
  }
  for (const second of [err('SESSION_NOT_SELECTED'), err('QUESTION_NOT_FOUND'), err('STORAGE_UNAVAILABLE'),
    err('CAPTURE_NOT_READY'), err('DAEMON_UNAVAILABLE'), unknown(), ok({})]) {
    const { send, sent } = scriptedSend([unknown(), second]);
    const res = await answer(send);
    assert.equal(res.isError, true);
    assert.deepEqual(res.structured, { code: 'OUTCOME_UNKNOWN' });
    assert.match(res.text, /resending the identical text is safe, different text is not/);
    assert.equal(sent.length, 2);
  }
});

test('a transport failure other than an unknown outcome propagates', async () => {
  const { send } = scriptedSend([new Error('boom')]);
  await assert.rejects(answer(send), /boom/);
});
