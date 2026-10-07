import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicEnvelope, PUBLIC_EVENT_TYPES, type AgentConnectionInput } from './public-events.ts';
import { loadSchema, validate } from './schema.ts';

const SESSION = '00000000-0000-4000-8000-000000000001';
const TARGET = { harness: 'claude-code', harness_session_id: 'root', worktree: '/w' } as const;
const input = (data: AgentConnectionInput['data']): AgentConnectionInput =>
  ({ type: 'slipstream.agent.connection.v1', occurred_at_ms: 1789657200000, data });

describe('slipstream.agent.connection.v1', () => {
  it('is a public event type', () => {
    assert.ok((PUBLIC_EVENT_TYPES as readonly string[]).includes('slipstream.agent.connection.v1'));
  });

  it('builds an envelope that validates for each recorded state', async () => {
    const schema = await loadSchema('slipstream.agent.connection.v1');
    for (const state of ['setup_pending', 'connected'] as const) {
      const event = buildPublicEnvelope(input({ state, target: TARGET }), 7n, SESSION);
      assert.equal(event.subject, undefined);
      assert.deepEqual(event.data, { state, target: TARGET, session_id: SESSION });
      assert.deepEqual(validate(schema, event), [], state);
    }
  });

  it('rejects an unrecorded state or an incomplete target', async () => {
    const schema = await loadSchema('slipstream.agent.connection.v1');
    const bad = [
      { state: 'disconnected', target: TARGET },
      { state: 'connected', target: { ...TARGET, harness: 'manual' } },
      { state: 'connected', target: { harness: 'codex', worktree: '/w' } },
      { state: 'connected' },
    ];
    for (const data of bad) {
      const event = buildPublicEnvelope(input(data as AgentConnectionInput['data']), 7n, SESSION);
      assert.ok(validate(schema, event).length > 0, JSON.stringify(data));
    }
  });
});
