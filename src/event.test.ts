import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnvelope,
  sourceFor,
  DATA_CONTENT_TYPE,
  SOURCE_PREFIX,
  SPEC_VERSION,
} from './event.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';

const GAP_INPUT = {
  type: 'slipstream.capture.gap.v1' as const,
  occurred_at_ms: 1789657200123,
  data: { scope: { kind: 'session' as const }, reason: 'restart' as const },
};

describe('buildEnvelope', () => {
  it('stamps the CloudEvents 1.0 constants', () => {
    const e = buildEnvelope(GAP_INPUT, 5n, SESSION);
    assert.equal(e.specversion, SPEC_VERSION);
    assert.equal(e.datacontenttype, DATA_CONTENT_TYPE);
    assert.equal(e.type, 'slipstream.capture.gap.v1');
  });

  it('renders seq as a decimal string and sets id equal to seq', () => {
    const e = buildEnvelope(GAP_INPUT, 42n, SESSION);
    assert.equal(e.seq, '42');
    assert.equal(e.id, '42');
  });

  it('handles sequence values beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    const e = buildEnvelope(GAP_INPUT, big, SESSION);
    assert.equal(e.seq, big.toString());
    assert.equal(e.id, big.toString());
  });

  it('derives source from the session id as a urn', () => {
    const e = buildEnvelope(GAP_INPUT, 1n, SESSION);
    assert.equal(e.source, `${SOURCE_PREFIX}${SESSION}`);
    assert.equal(e.source, sourceFor(SESSION));
  });

  it('injects session_id into data rather than as a top-level attribute', () => {
    const e = buildEnvelope(GAP_INPUT, 1n, SESSION);
    assert.equal(e.data.session_id, SESSION);
    assert.ok(!('session_id' in e));
  });

  it('converts occurred_at_ms to an RFC3339 time and never copies it into data', () => {
    const e = buildEnvelope(GAP_INPUT, 1n, SESSION);
    assert.equal(e.time, '2026-09-17T15:00:00.123Z');
    assert.ok(!('occurred_at_ms' in e));
    assert.ok(!('occurred_at_ms' in e.data));
    assert.ok(!('committed_at_ms' in e));
  });

  it('preserves caller data fields alongside the injected session_id', () => {
    const e = buildEnvelope(
      {
        type: 'slipstream.file.changed.v1',
        occurred_at_ms: 0,
        data: {
          path: 'src/a.ts',
          before: { kind: 'absent' },
          after: { kind: 'content', sha256: 'a'.repeat(64), size: 3 },
          observation: 'watcher',
        },
      },
      7n,
      SESSION,
    );
    assert.equal(e.type, 'slipstream.file.changed.v1');
    if (e.type === 'slipstream.file.changed.v1') {
      assert.equal(e.data.path, 'src/a.ts');
      assert.equal(e.data.observation, 'watcher');
      assert.equal(e.data.after.kind, 'content');
      // occurred_at_ms is mirrored into data as the type-specific observed_at_ms,
      // preserving the observation instant that `time` (commit order) does not.
      assert.equal(e.data.observed_at_ms, 0);
    }
  });

  it('is pure — the same inputs yield an identical envelope', () => {
    assert.deepEqual(buildEnvelope(GAP_INPUT, 3n, SESSION), buildEnvelope(GAP_INPUT, 3n, SESSION));
  });
});
