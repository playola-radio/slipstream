import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, EVENT_TYPES, type EventInput } from './event.ts';
import { loadAllSchemas, loadSchema, validate } from './schema.ts';

const SHA = 'a'.repeat(64);
const SESSION = '550e8400-e29b-41d4-a716-446655440000';

/** One representative input per event type, exercising the richer data shapes. */
const SAMPLES: Record<string, EventInput> = {
  'slipstream.session.started.v1': {
    type: 'slipstream.session.started.v1',
    occurred_at_ms: 1789657200123,
    data: { root: '/tmp/worktree', max_bytes: 10485760 },
  },
  'slipstream.file.baselined.v1': {
    type: 'slipstream.file.baselined.v1',
    occurred_at_ms: 1789657200123,
    data: { path: 'src/a.ts', snapshot: { kind: 'content', sha256: SHA, size: 12 } },
  },
  'slipstream.capture.baseline.completed.v1': {
    type: 'slipstream.capture.baseline.completed.v1',
    occurred_at_ms: 1789657200123,
    data: { unknown_scopes: ['locked'] },
  },
  'slipstream.file.changed.v1': {
    type: 'slipstream.file.changed.v1',
    occurred_at_ms: 1789657200123,
    data: {
      path: 'src/a.ts',
      before: { kind: 'absent' },
      after: { kind: 'content', sha256: SHA, size: 12 },
      observation: 'reconciliation',
      coalesced: true,
      gap_ref: '7',
    },
  },
  'slipstream.capture.gap.v1': {
    type: 'slipstream.capture.gap.v1',
    occurred_at_ms: 1789657200123,
    data: { scope: { kind: 'session' }, reason: 'restart' },
  },
  'slipstream.session.resumed.v1': {
    type: 'slipstream.session.resumed.v1',
    occurred_at_ms: 1789657200123,
    data: { recovered_through_seq: '41', discarded_tail_bytes: 18 },
  },
  'slipstream.task.started.v1': {
    type: 'slipstream.task.started.v1',
    occurred_at_ms: 1789657200123,
    data: {
      task_id: '11111111-1111-4111-8111-111111111111',
      request_id: '22222222-2222-4222-8222-222222222222',
      title: 'Implement attachment selection',
    },
  },
  'slipstream.harness.evidence.v1': {
    type: 'slipstream.harness.evidence.v1',
    occurred_at_ms: 1789657200123,
    data: {
      evidence_key: {
        harness: 'claude-code',
        harness_session_id: 'hs-1',
        record_id: 'call-7',
      },
      adapter_version: 'claude-code/1',
      tool_name: 'Write',
      timestamp: { at_ms: 1789657200000, basis: 'tool-start' },
      file_scope: { kind: 'paths', paths: ['src/a.ts'] },
    },
  },
  'slipstream.change.attribution.v1': {
    type: 'slipstream.change.attribution.v1',
    occurred_at_ms: 1789657200123,
    data: {
      change_seq: '12',
      policy_seq: '3',
      status: 'heuristic',
      reason: 'single-candidate',
      evidence_seqs: ['9'],
      excluded_conflicts: [
        { harness: 'codex', harness_session_id: 'hs-2', record_id: 'call-3' },
      ],
    },
  },
  'slipstream.enrichment.configured.v1': {
    type: 'slipstream.enrichment.configured.v1',
    occurred_at_ms: 1789657200123,
    data: {
      policy: {
        window_ms: 2000,
        grace_ms: 5000,
        sources: { 'claude-code': 'unconfigured', codex: 'unconfigured' },
      },
    },
  },
};

describe('schema', () => {
  describe('the schemas/ directory', () => {
    it('has exactly one schema file per v1 event type', async () => {
      const schemas = await loadAllSchemas();
      assert.deepEqual(new Set(schemas.keys()), new Set(EVENT_TYPES));
    });

    it('names each schema by its own type const', async () => {
      const schemas = await loadAllSchemas();
      for (const [name, schema] of schemas) {
        const typeConst = (schema.properties as Record<string, { const?: string }>).type?.const;
        assert.equal(typeConst, name, `${name} should pin type.const to its filename`);
      }
    });
  });

  describe('a built envelope for every event type', () => {
    for (const type of EVENT_TYPES) {
      it(`validates against ${type}`, async () => {
        const schema = await loadSchema(type);
        const event = buildEnvelope(SAMPLES[type]!, 42n, SESSION);
        assert.deepEqual(validate(schema, event), []);
      });
    }
  });

  describe('forward compatibility', () => {
    it('accepts an event carrying unknown top-level and data fields', async () => {
      const schema = await loadSchema('slipstream.file.changed.v1');
      const event = buildEnvelope(SAMPLES['slipstream.file.changed.v1']!, 42n, SESSION) as unknown as Record<string, unknown>;
      event.subject = 'task/abc';
      (event.data as Record<string, unknown>).task_hint_id = 'task-1';
      assert.deepEqual(validate(schema, event), []);
    });
  });

  describe('rejects malformed events', () => {
    it('flags a wrong type const', async () => {
      const schema = await loadSchema('slipstream.capture.gap.v1');
      const event = buildEnvelope(SAMPLES['slipstream.file.changed.v1']!, 1n, SESSION);
      assert.ok(validate(schema, event).length > 0);
    });

    it('flags a missing required data field', async () => {
      const schema = await loadSchema('slipstream.session.started.v1');
      const event = buildEnvelope(SAMPLES['slipstream.session.started.v1']!, 1n, SESSION) as unknown as Record<string, unknown>;
      delete (event.data as Record<string, unknown>).root;
      assert.ok(validate(schema, event).some((e) => e.includes('root')));
    });

    it('flags a non-hex content sha256', async () => {
      const schema = await loadSchema('slipstream.file.baselined.v1');
      const event = buildEnvelope(
        {
          type: 'slipstream.file.baselined.v1',
          occurred_at_ms: 1,
          data: { path: 'x', snapshot: { kind: 'content', sha256: 'nope', size: 1 } },
        },
        1n,
        SESSION,
      );
      assert.ok(validate(schema, event).length > 0);
    });

    it('flags a seq that is not a positive decimal string', async () => {
      const schema = await loadSchema('slipstream.capture.gap.v1');
      const event = buildEnvelope(SAMPLES['slipstream.capture.gap.v1']!, 1n, SESSION) as unknown as Record<string, unknown>;
      event.seq = '0';
      assert.ok(validate(schema, event).some((e) => e.includes('seq')));
    });
  });

  describe('the validator itself', () => {
    it('requires exactly one oneOf branch to match', () => {
      const schema = { oneOf: [{ const: 'a' }, { const: 'b' }] };
      assert.deepEqual(validate(schema, 'a'), []);
      assert.ok(validate(schema, 'c').length > 0);
    });

    it('enforces pattern, enum, and minimum', () => {
      assert.ok(validate({ type: 'string', pattern: '^x' }, 'yz').length > 0);
      assert.ok(validate({ enum: [1, 2] }, 3).length > 0);
      assert.ok(validate({ type: 'integer', minimum: 0 }, -1).length > 0);
    });
  });
});
