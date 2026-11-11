import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardNameWorkspace } from './name-forwarder.ts';
import { OutcomeUnknownError } from './control-client.ts';
import type { RequestEnvelope, ResponseEnvelope } from './control-protocol.ts';
import type { Identity } from './harness-context.ts';

const IDENTITY: Identity = { harness: 'codex', harness_session_id: 'thread-1', worktree: '/repos/w' };

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

const ok = (fields: Record<string, unknown>): ResponseEnvelope => ({ v: 1, ok: true, ...fields });
const name = (send: (r: RequestEnvelope) => Promise<ResponseEnvelope>, extra: { replaceExisting?: unknown; identity?: Identity | { unresolved: string } } = {}) =>
  forwardNameWorkspace({ identity: extra.identity ?? IDENTITY, name: 'Workspace rename menu', replaceExisting: extra.replaceExisting, send });

test('success text depends on changed', async () => {
  assert.equal((await name(scriptedSend([ok({ changed: true })]).send)).text, 'Agent name saved.');
  assert.equal((await name(scriptedSend([ok({ changed: false })]).send)).text, 'An agent name was already set; kept it.');
});

test('structured result is {changed}', async () => {
  const res = await name(scriptedSend([ok({ changed: false })]).send);
  assert.deepEqual(res, { text: 'An agent name was already set; kept it.', isError: false, structured: { changed: false } });
});

test('daemon error passes through as {code}', async () => {
  const res = await name(scriptedSend([{ v: 1, ok: false, code: 'INVALID_NAME', message: 'name is empty' }]).send);
  assert.deepEqual(res, { text: 'INVALID_NAME: name is empty', isError: true, structured: { code: 'INVALID_NAME' } });
});

test('lost reply is OUTCOME_UNKNOWN and sends exactly once', async () => {
  const { send, sent } = scriptedSend([new OutcomeUnknownError('reply lost'), ok({ changed: true })]);
  const res = await name(send);
  assert.deepEqual(res.structured, { code: 'OUTCOME_UNKNOWN' });
  assert.equal(res.text, 'OUTCOME_UNKNOWN: the name was sent but whether it was saved could not be confirmed');
  assert.equal(sent.length, 1);
});

test('malformed ack is OUTCOME_UNKNOWN', async () => {
  for (const fields of [{}, { changed: 'true' }]) {
    const { send, sent } = scriptedSend([ok(fields), ok({ changed: true })]);
    const res = await name(send);
    assert.deepEqual(res.structured, { code: 'OUTCOME_UNKNOWN' }, JSON.stringify(fields));
    assert.equal(sent.length, 1);
  }
});

test('replace_existing "true" is forwarded raw', async () => {
  const { send, sent } = scriptedSend([{ v: 1, ok: false, code: 'PROTOCOL', message: 'replace_existing must be a boolean' }]);
  await name(send, { replaceExisting: 'true' });
  assert.deepEqual(sent, [{ v: 1, verb: 'name_workspace', name: 'Workspace rename menu', replace_existing: 'true',
    harness: 'codex', harness_session_id: 'thread-1', worktree: '/repos/w' }]);
});

test('absent replace_existing is omitted from the envelope', async () => {
  const { send, sent } = scriptedSend([ok({ changed: true })]);
  await name(send);
  assert.equal('replace_existing' in sent[0]!, false);
});

test('unresolved identity never sends', async () => {
  const { send, sent } = scriptedSend([]);
  const res = await name(send, { identity: { unresolved: 'no threadId' } });
  assert.deepEqual(res, { text: 'IDENTITY_UNRESOLVED: no threadId', isError: true, structured: { code: 'IDENTITY_UNRESOLVED' } });
  assert.equal(sent.length, 0);
});
