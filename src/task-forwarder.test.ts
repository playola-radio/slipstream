import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardBeginTask, shouldAutoResend } from './task-forwarder.ts';
import { OutcomeUnknownError } from './control-client.ts';
import type { RequestEnvelope, ResponseEnvelope, ControlErrorCode } from './control-protocol.ts';
import type { Identity } from './harness-context.ts';

const IDENTITY: Identity = {
  harness: 'claude-code',
  harness_session_id: 'sid-1',
  worktree: '/Users/x/porto-v3',
};

/** A scripted control channel: each step is a response to return or an error to
 * throw, consumed in order. Records every envelope it was sent. */
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

const okResponse = (): ResponseEnvelope => ({
  v: 1, ok: true, session_id: 'cap-1', task_id: 'task-1', event_id: '5', seq: '5',
});
/** An `ok:true` envelope the control-client validator accepts but that carries no
 * task-commit identifiers — nothing durable is proven. */
const malformedOk = (): ResponseEnvelope => ({ v: 1, ok: true } as ResponseEnvelope);
const errResponse = (code: ControlErrorCode, message = 'msg'): ResponseEnvelope => ({ v: 1, ok: false, code, message });

test('unresolved identity returns IDENTITY_UNRESOLVED without contacting the daemon', async () => {
  const { send, sent } = scriptedSend([]);
  const res = await forwardBeginTask({ identity: { unresolved: 'no threadId' }, title: 't', send });
  assert.equal(res.isError, true);
  assert.match(res.text, /IDENTITY_UNRESOLVED/);
  assert.equal(sent.length, 0);
});

test('a committed declaration returns the structured result and does not resend', async () => {
  const { send, sent } = scriptedSend([okResponse()]);
  const res = await forwardBeginTask({ identity: IDENTITY, title: 'my task', requestId: 'req-1', send });
  assert.equal(res.isError, false);
  assert.deepEqual(res.structured, { session_id: 'cap-1', task_id: 'task-1', event_id: '5', seq: '5' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    v: 1, verb: 'begin_task', title: 'my task', request_id: 'req-1',
    harness: 'claude-code', harness_session_id: 'sid-1', worktree: '/Users/x/porto-v3',
  });
});

test('each daemon domain error maps to an isError result with one send, no resend', async () => {
  for (const code of ['SESSION_NOT_SELECTED', 'CAPTURE_NOT_READY', 'INVALID_TITLE', 'STORAGE_UNAVAILABLE', 'DAEMON_UNAVAILABLE'] as ControlErrorCode[]) {
    const { send, sent } = scriptedSend([errResponse(code)]);
    const res = await forwardBeginTask({ identity: IDENTITY, title: 't', requestId: 'r', send });
    assert.equal(res.isError, true, `${code} should be an error`);
    assert.match(res.text, new RegExp(code));
    assert.equal(sent.length, 1, `${code} should not resend`);
  }
});

test('an OutcomeUnknown on the first send auto-resends the byte-identical payload once, then resolves', async () => {
  const { send, sent } = scriptedSend([new OutcomeUnknownError('no response'), okResponse()]);
  const res = await forwardBeginTask({ identity: IDENTITY, title: 't', requestId: 'req-X', send });
  assert.equal(res.isError, false);
  assert.deepEqual(res.structured, { session_id: 'cap-1', task_id: 'task-1', event_id: '5', seq: '5' });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]); // byte-identical resend
});

test('a malformed success ack on the first send is post-send ambiguity and triggers the one resend', async () => {
  const { send, sent } = scriptedSend([malformedOk(), okResponse()]);
  const res = await forwardBeginTask({ identity: IDENTITY, title: 't', requestId: 'req-m', send });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(res.structured, { session_id: 'cap-1', task_id: 'task-1', event_id: '5', seq: '5' });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
});

test('a malformed success ack on both sends collapses to OUTCOME_UNKNOWN, never a confident success', async () => {
  const { send, sent } = scriptedSend([malformedOk(), malformedOk()]);
  const res = await forwardBeginTask({ identity: IDENTITY, title: 't', requestId: 'req-mm', send });
  assert.equal(res.isError, true);
  assert.match(res.text, /OUTCOME_UNKNOWN/);
  assert.match(res.text, /req-mm/);
  assert.equal(sent.length, 2);
});

test('a final INVALID_TITLE on the resend replaces the earlier unknown', async () => {
  const { send, sent } = scriptedSend([new OutcomeUnknownError('drop'), errResponse('INVALID_TITLE', 'bad')]);
  const res = await forwardBeginTask({ identity: IDENTITY, title: 't', requestId: 'r', send });
  assert.equal(res.isError, true);
  assert.match(res.text, /INVALID_TITLE/);
  assert.equal(sent.length, 2);
});

test('a SESSION_NOT_SELECTED on the resend reports prior commit status as unknown, never "not committed"', async () => {
  const { send } = scriptedSend([new OutcomeUnknownError('drop'), errResponse('SESSION_NOT_SELECTED')]);
  const res = await forwardBeginTask({ identity: IDENTITY, title: 't', requestId: 'req-42', send });
  assert.equal(res.isError, true);
  assert.match(res.text, /SESSION_NOT_SELECTED/);
  assert.match(res.text, /prior commit status unknown for request_id req-42/);
  assert.doesNotMatch(res.text, /not committed/);
});

test('two OutcomeUnknowns collapse to OUTCOME_UNKNOWN carrying the request_id', async () => {
  const { send, sent } = scriptedSend([new OutcomeUnknownError('drop1'), new OutcomeUnknownError('drop2')]);
  const res = await forwardBeginTask({ identity: IDENTITY, title: 't', requestId: 'req-99', send });
  assert.equal(res.isError, true);
  assert.match(res.text, /OUTCOME_UNKNOWN/);
  assert.match(res.text, /req-99/);
  assert.match(res.text, /not re-?declare|do not re-?declare/i);
  assert.equal(sent.length, 2);
});

test('DAEMON_UNAVAILABLE on the resend is OUTCOME_UNKNOWN, not a "safe to retry" claim', async () => {
  // The first send was ambiguous (may have committed); the daemon then vanished.
  // Reporting DAEMON_UNAVAILABLE ("nothing happened, retry") would be a lie.
  const { send } = scriptedSend([new OutcomeUnknownError('drop'), errResponse('DAEMON_UNAVAILABLE', 'gone')]);
  const res = await forwardBeginTask({ identity: IDENTITY, title: 't', requestId: 'req-7', send });
  assert.equal(res.isError, true);
  assert.match(res.text, /OUTCOME_UNKNOWN/);
  assert.match(res.text, /req-7/);
});

test('shouldAutoResend only qualifies begin_task envelopes bearing a request_id', () => {
  assert.equal(shouldAutoResend({ v: 1, verb: 'begin_task', request_id: 'r' }), true);
  assert.equal(shouldAutoResend({ v: 1, verb: 'begin_task', request_id: '' }), false);
  assert.equal(shouldAutoResend({ v: 1, verb: 'begin_task' }), false);
  assert.equal(shouldAutoResend({ v: 1, verb: 'status' }), false);
  assert.equal(shouldAutoResend({ v: 1, verb: 'detach', request_id: 'r' }), false);
});
