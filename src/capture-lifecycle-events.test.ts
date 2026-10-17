import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicEnvelope, PUBLIC_EVENT_TYPES, type PublicEventInput } from './public-events.ts';
import { loadSchema, validate } from './schema.ts';

const SESSION = '00000000-0000-4000-8000-000000000001';
const AT = 1789657200000;
const TARGET = { harness: 'claude-code', harness_session_id: 'chat-1', worktree: '/w/root' } as const;

async function errorsFor(input: PublicEventInput): Promise<string[]> {
  return validate(await loadSchema(input.type), buildPublicEnvelope(input, 7n, SESSION));
}

describe('capture lifecycle and binding events', () => {
  it('are public event types', () => {
    for (const type of ['slipstream.capture.ready.v1', 'slipstream.capture.stopped.v1',
      'slipstream.agent.binding.v1', 'slipstream.agent.unlinked.v1']) {
      assert.ok((PUBLIC_EVENT_TYPES as readonly string[]).includes(type), type);
    }
  });

  it('capture.ready carries only the session id', async () => {
    const input: PublicEventInput = { type: 'slipstream.capture.ready.v1', occurred_at_ms: AT, data: {} };
    const event = buildPublicEnvelope(input, 7n, SESSION);
    assert.deepEqual(event.data, { session_id: SESSION });
    assert.equal(event.subject, undefined);
    assert.deepEqual(await errorsFor(input), []);
  });

  it('capture.stopped validates for every closed reason and rejects others', async () => {
    for (const reason of ['detached', 'archived', 'maintenance', 'root-missing', 'watcher-failed'] as const) {
      assert.deepEqual(await errorsFor({ type: 'slipstream.capture.stopped.v1', occurred_at_ms: AT, data: { reason } }), [], reason);
    }
    const bad = { type: 'slipstream.capture.stopped.v1', occurred_at_ms: AT, data: { reason: 'shutdown' } } as unknown as PublicEventInput;
    assert.ok((await errorsFor(bad)).length > 0);
  });

  it('agent.binding carries the generation, target, and verified transcript', async () => {
    const input: PublicEventInput = {
      type: 'slipstream.agent.binding.v1', occurred_at_ms: AT,
      data: { binding_generation: '3', target: TARGET, verified_transcript_path: '/t/chat-1.jsonl' },
    };
    assert.deepEqual(buildPublicEnvelope(input, 7n, SESSION).data, {
      session_id: SESSION, binding_generation: '3', target: TARGET, verified_transcript_path: '/t/chat-1.jsonl',
    });
    assert.deepEqual(await errorsFor(input), []);
    const noWorktree = { ...input, data: { ...input.data, target: { harness: 'codex', harness_session_id: 'x' } } } as PublicEventInput;
    assert.ok((await errorsFor(noWorktree)).length > 0);
    const badGeneration = { ...input, data: { ...input.data, binding_generation: 3 } } as unknown as PublicEventInput;
    assert.ok((await errorsFor(badGeneration)).length > 0);
  });

  it('agent.unlinked validates for each reason', async () => {
    for (const reason of ['unlinked', 'detached', 'archived'] as const) {
      const input: PublicEventInput = { type: 'slipstream.agent.unlinked.v1', occurred_at_ms: AT, data: { binding_generation: '3', reason } };
      assert.deepEqual(await errorsFor(input), [], reason);
    }
    const bad = { type: 'slipstream.agent.unlinked.v1', occurred_at_ms: AT, data: { binding_generation: '3', reason: 'maintenance' } } as unknown as PublicEventInput;
    assert.ok((await errorsFor(bad)).length > 0);
  });

  it('agent.connection accepts an optional binding generation', async () => {
    const input: PublicEventInput = {
      type: 'slipstream.agent.connection.v1', occurred_at_ms: AT,
      data: { state: 'setup_pending', binding_generation: '3', target: { harness: 'codex', harness_session_id: 'c' } },
    };
    assert.deepEqual(await errorsFor(input), []);
    const bad = { ...input, data: { ...input.data, binding_generation: '03' } } as PublicEventInput;
    assert.ok((await errorsFor(bad)).length > 0);
  });

  it('session.started and session.resumed accept capture_mode watch-only only', async () => {
    const started = await loadSchema('slipstream.session.started.v1');
    const resumed = await loadSchema('slipstream.session.resumed.v1');
    const startEvent = {
      specversion: '1.0', id: '1', source: `urn:slipstream:session:${SESSION}`, type: 'slipstream.session.started.v1',
      datacontenttype: 'application/json', seq: '1', time: new Date(AT).toISOString(),
      data: { session_id: SESSION, root: '/w', max_bytes: 1, started_at_ms: AT, capture_mode: 'watch-only' },
    };
    assert.deepEqual(validate(started, startEvent), []);
    assert.ok(validate(started, { ...startEvent, data: { ...startEvent.data, capture_mode: 'chat' } }).length > 0);
    const resumeEvent = {
      ...startEvent, type: 'slipstream.session.resumed.v1',
      data: { session_id: SESSION, recovered_through_seq: '4', discarded_tail_bytes: 0, resumed_at_ms: AT, capture_mode: 'watch-only' },
    };
    assert.deepEqual(validate(resumed, resumeEvent), []);
    assert.ok(validate(resumed, { ...resumeEvent, data: { ...resumeEvent.data, capture_mode: 'chat' } }).length > 0);
  });
});
