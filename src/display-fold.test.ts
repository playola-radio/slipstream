import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, foldDisplay } from './display-fold.ts';

const A = 'urn:slipstream:session:a';
const B = 'urn:slipstream:session:b';

function rec(source: string, seq: string, type: string, data: unknown): Record<string, unknown> {
  return { source, seq, type, data };
}

const gap = (seq: string, data: Record<string, unknown> = {}) =>
  rec(A, seq, 'slipstream.capture.gap.v1', { scope: { kind: 'session' }, reason: 'restart', ...data });

const evidence = (seq: string, data: Record<string, unknown> = {}) =>
  rec(A, seq, 'slipstream.harness.evidence.v1', {
    evidence_key: { harness: 'claude-code', harness_session_id: 'hs', record_id: 'r1' },
    tool_name: 'Write',
    timestamp: { at_ms: 1000, basis: 'record-time' },
    file_scope: { kind: 'paths', paths: ['a.ts'] },
    ...data,
  });

const attribution = (seq: string, data: Record<string, unknown> = {}) =>
  rec(A, seq, 'slipstream.change.attribution.v1', {
    change_seq: '1',
    policy_seq: '1',
    status: 'heuristic',
    reason: 'single-candidate',
    evidence_seqs: [],
    ...data,
  });

const coverage = (seq: string, data: Record<string, unknown> = {}) =>
  rec(A, seq, 'slipstream.enrichment.coverage.v1', { harness: 'codex', state: 'readable', ...data });

const MIXED = [
  rec(A, '1', 'slipstream.file.changed.v1', { path: 'a.ts' }),
  evidence('2'),
  attribution('3', { evidence_seqs: ['2'] }),
  gap('4'),
  coverage('5', { issues: [{ kind: 'missing', detail: 'x' }] }),
  rec(B, '1', 'slipstream.file.changed.v1', { path: 'b.ts' }),
  rec(B, '2', 'slipstream.harness.evidence.v1', (evidence('2').data as object)),
];

describe('foldDisplay', () => {
  it('folds an empty stream to exactly the four empty D1 components', () => {
    assert.equal(
      canonicalJson(foldDisplay([])),
      '{"contract":"display-fold.v1","result":"ok","state":{"attributions":[],"coverage":[],"evidence":[],"gaps":[]}}',
    );
  });

  it('is independent of delivery order', () => {
    const forward = canonicalJson(foldDisplay(MIXED));
    const reversed = canonicalJson(foldDisplay([...MIXED].reverse()));
    const rotated = canonicalJson(foldDisplay([...MIXED.slice(3), ...MIXED.slice(0, 3)]));
    assert.equal(reversed, forward);
    assert.equal(rotated, forward);
  });

  it('dedups a fully duplicated stream to identical bytes', () => {
    assert.equal(canonicalJson(foldDisplay([...MIXED, ...MIXED])), canonicalJson(foldDisplay(MIXED)));
  });

  it('treats -0 and 0 as the same transport value', () => {
    const r = foldDisplay([gap('1', { observed_at_ms: 0 }), gap('1', { observed_at_ms: -0 })]);
    assert.equal(r.result, 'ok');
  });

  it('dedups independently parsed copies of a record with a deeply nested unknown field', () => {
    const depth = 20_000;
    const line = JSON.stringify(gap('1')).replace('"data":{', `"data":{"extra":${'['.repeat(depth)}0${']'.repeat(depth)},`);
    const r = foldDisplay([JSON.parse(line), JSON.parse(line)]);
    assert.equal(canonicalJson(r), canonicalJson(foldDisplay([gap('1')])));
  });

  it('selects the same error regardless of delivery order', () => {
    const input = [
      gap('1'),
      gap('1', { reason: 'storage' }),
      rec(A, '2', 'slipstream.file.changed.v2', {}),
      coverage('9', { harness: 'gemini' }),
      coverage('8', { state: 'bogus' }),
    ];
    const expected = '{"contract":"display-fold.v1","error":{"reason":"invalid-record","seq":"8","source":"urn:slipstream:session:a"},"result":"invalid"}';
    assert.equal(canonicalJson(foldDisplay(input)), expected);
    assert.equal(canonicalJson(foldDisplay([...input].reverse())), expected);
  });

  it('prefers an identity-less invalid record over any identified one', () => {
    const r = foldDisplay([coverage('1', { state: 'bogus' }), { source: A, seq: '0', type: 'x', data: {} }]);
    assert.deepEqual(r, { contract: 'display-fold.v1', result: 'invalid', error: { reason: 'invalid-record' } });
  });

  it('reports any non-"1" version of a consumed family as unsupported', () => {
    for (const type of ['slipstream.capture.gap.v01', 'slipstream.capture.gap.v2', 'slipstream.harness.evidence.vNext']) {
      const r = foldDisplay([rec(A, '1', type, {})]);
      assert.deepEqual(r, {
        contract: 'display-fold.v1',
        result: 'unsupported',
        error: { reason: 'unsupported-event-version', source: A, seq: '1', type },
      });
    }
  });

  it('ignores unknown types, including an unconsumed slipstream family at any version', () => {
    for (const type of ['slipstream.session.started.v2', 'slipstream.capture.gap', 'org.example.v1']) {
      assert.equal(foldDisplay([rec(A, '1', type, { anything: 1.5 })]).result, 'ok', type);
    }
  });

  describe('input validation', () => {
    const invalid: Array<[string, unknown]> = [
      ['non-object record', 'x'],
      ['array record', []],
      ['missing source', { seq: '1', type: 't', data: {} }],
      ['empty source', { source: '', seq: '1', type: 't', data: {} }],
      ['numeric seq', { source: A, seq: 1, type: 't', data: {} }],
      ['leading-zero seq', { source: A, seq: '01', type: 't', data: {} }],
    ];
    for (const [name, record] of invalid) {
      it(`rejects a record with no identity: ${name}`, () => {
        assert.deepEqual(foldDisplay([record]), {
          contract: 'display-fold.v1',
          result: 'invalid',
          error: { reason: 'invalid-record' },
        });
      });
    }

    const bad: Array<[string, Record<string, unknown>]> = [
      ['non-string type', { source: A, seq: '1', type: 7, data: {} }],
      ['null data', { source: A, seq: '1', type: 't', data: null }],
      ['array data', { source: A, seq: '1', type: 't', data: [] }],
      ['attribution numeric change_seq', attribution('1', { change_seq: 1 })],
      ['attribution leading-zero change_seq', attribution('1', { change_seq: '01' })],
      ['attribution bad policy_seq', attribution('1', { policy_seq: '0' })],
      ['attribution bad status', attribution('1', { status: 'verified' })],
      ['attribution bad reason', attribution('1', { reason: 'because' })],
      ['attribution bad evidence_seqs', attribution('1', { evidence_seqs: ['1', 2] })],
      ['attribution null excluded_conflicts', attribution('1', { excluded_conflicts: null })],
      ['attribution bad excluded key', attribution('1', { excluded_conflicts: [{ harness: 'x', harness_session_id: 's', record_id: 'r' }] })],
      ['evidence bad harness', evidence('1', { evidence_key: { harness: 'x', harness_session_id: 's', record_id: 'r' } })],
      ['evidence missing record_id', evidence('1', { evidence_key: { harness: 'codex', harness_session_id: 's' } })],
      ['evidence missing tool_name', evidence('1', { tool_name: undefined })],
      ['evidence bad basis', evidence('1', { timestamp: { at_ms: 1, basis: 'later' } })],
      ['evidence fractional at_ms', evidence('1', { timestamp: { at_ms: 1.5, basis: 'record-time' } })],
      ['evidence string at_ms', evidence('1', { timestamp: { at_ms: '1', basis: 'record-time' } })],
      ['evidence non-string path', evidence('1', { file_scope: { kind: 'paths', paths: [1] } })],
      ['evidence unknown scope kind', evidence('1', { file_scope: { kind: 'some' } })],
      ['evidence unknown scope without reason', evidence('1', { file_scope: { kind: 'unknown' } })],
      ['coverage bad harness', coverage('1', { harness: 'gemini' })],
      ['coverage bad state', coverage('1', { state: 'complete' })],
      ['coverage null issues', coverage('1', { issues: null })],
      ['coverage bad issue kind', coverage('1', { issues: [{ kind: 'odd', detail: 'x' }] })],
      ['coverage issue without detail', coverage('1', { issues: [{ kind: 'missing' }] })],
      ['gap bad reason', gap('1', { reason: 'unknown-reason' })],
      ['gap bad scope kind', gap('1', { scope: { kind: 'file', path: 'a' } })],
      ['gap path scope without path', gap('1', { scope: { kind: 'path' } })],
      ['gap null episode_id', gap('1', { episode_id: null })],
    ];
    for (const [name, record] of bad) {
      it(`rejects ${name}`, () => {
        assert.deepEqual(foldDisplay([record]), {
          contract: 'display-fold.v1',
          result: 'invalid',
          error: { reason: 'invalid-record', source: record.source, seq: record.seq },
        });
      });
    }

    for (const at_ms of [-1, 9007199254740992, 1e300]) {
      it(`reports evidence at_ms ${at_ms} as out of range`, () => {
        assert.deepEqual(foldDisplay([evidence('1', { timestamp: { at_ms, basis: 'record-time' } })]), {
          contract: 'display-fold.v1',
          result: 'invalid',
          error: { reason: 'timestamp-out-of-range', source: A, seq: '1' },
        });
      });
    }
  });
});

describe('canonicalJson', () => {
  it('sorts object keys by UTF-16 code units, including integer-like keys', () => {
    assert.equal(canonicalJson({ a: 3, 10: 1, 9: 2 }), '{"10":1,"9":2,"a":3}');
  });

  it('orders an astral key before a high BMP key, unlike code-point order', () => {
    assert.equal(canonicalJson({ '\uff5e': 1, '\ud83d\ude00': 2 }), '{"\ud83d\ude00":2,"\uff5e":1}');
  });

  it('keeps array order and emits no whitespace', () => {
    assert.equal(canonicalJson([3, [true, null], 'x']), '[3,[true,null],"x"]');
  });

  it('escapes a lone surrogate', () => {
    assert.equal(canonicalJson('\ud800'), '"\\ud800"');
  });

  it('serializes -0 as 0', () => {
    assert.equal(canonicalJson(-0), '0');
  });

  for (const [name, value] of [
    ['a fraction', 1.5],
    ['an unsafe integer', 9007199254740992],
    ['NaN', Number.NaN],
    ['a bigint', 1n],
    ['undefined', undefined],
    ['an undefined field', { a: undefined }],
  ] as Array<[string, unknown]>) {
    it(`rejects ${name}`, () => {
      assert.throws(() => canonicalJson(value), TypeError);
    });
  }
});
