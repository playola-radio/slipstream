import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, type AnyEvent, type EnrichmentPolicy, type EvidenceKey } from './event.ts';
import {
  attributionResultsEqual,
  bindPolicy,
  evaluateChange,
  evidenceKeyString,
  foldAttributions,
  foldEvidence,
  foldPolicies,
  type Invocation,
} from './attribution.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const SHA = 'a'.repeat(64);

const POLICY: EnrichmentPolicy = {
  window_ms: 2000,
  grace_ms: 5000,
  sources: { 'claude-code': 'unconfigured', codex: 'unconfigured' },
};

/** Build a normalized evidence event at `seq`. */
function evidence(
  seq: bigint,
  key: EvidenceKey,
  fields: {
    tool_name?: string;
    at_ms: number;
    basis?: 'tool-start' | 'tool-end' | 'record-time';
    paths?: string[];
    unknownScope?: string;
  },
): AnyEvent {
  return buildEnvelope(
    {
      type: 'slipstream.harness.evidence.v1',
      occurred_at_ms: fields.at_ms,
      data: {
        evidence_key: key,
        adapter_version: 'test/1',
        tool_name: fields.tool_name ?? 'Write',
        timestamp: { at_ms: fields.at_ms, basis: fields.basis ?? 'record-time' },
        file_scope: fields.unknownScope
          ? { kind: 'unknown', reason: fields.unknownScope }
          : { kind: 'paths', paths: fields.paths ?? ['src/a.ts'] },
      },
    },
    seq,
    SESSION,
  );
}

function change(seq: bigint, path: string): AnyEvent {
  return buildEnvelope(
    {
      type: 'slipstream.file.changed.v1',
      occurred_at_ms: 1000,
      data: {
        path,
        before: { kind: 'absent' },
        after: { kind: 'content', sha256: SHA, size: 1 },
        observation: 'watcher',
      },
    },
    seq,
    SESSION,
  );
}

function policyEvent(seq: bigint, policy: EnrichmentPolicy): AnyEvent {
  return buildEnvelope(
    { type: 'slipstream.enrichment.configured.v1', occurred_at_ms: 1, data: { policy } },
    seq,
    SESSION,
  );
}

function attribution(
  seq: bigint,
  data: {
    change_seq: string;
    policy_seq: string;
    status: 'heuristic' | 'ambiguous' | 'unknown';
    reason: 'single-candidate' | 'multiple-candidates' | 'no-matching-evidence' | 'observation-interval-unavailable';
    evidence_seqs: string[];
    excluded_conflicts?: EvidenceKey[];
  },
): AnyEvent {
  return buildEnvelope(
    { type: 'slipstream.change.attribution.v1', occurred_at_ms: 1, data },
    seq,
    SESSION,
  );
}

const key = (record_id: string, harness_session_id = 'hs-1'): EvidenceKey => ({
  harness: 'claude-code',
  harness_session_id,
  record_id,
});

describe('attribution reducer', () => {
  describe('evidenceKeyString', () => {
    it('is stable and distinguishes each field', () => {
      assert.equal(evidenceKeyString(key('r1')), evidenceKeyString(key('r1')));
      assert.notEqual(evidenceKeyString(key('r1')), evidenceKeyString(key('r2')));
      assert.notEqual(evidenceKeyString(key('r1', 'hs-1')), evidenceKeyString(key('r1', 'hs-2')));
      assert.notEqual(
        evidenceKeyString(key('r1')),
        evidenceKeyString({ harness: 'codex', harness_session_id: 'hs-1', record_id: 'r1' }),
      );
    });
  });

  describe('foldEvidence', () => {
    it('joins a start and end record for one invocation into a single candidate', () => {
      const inv = foldEvidence([
        evidence(1n, key('r1'), { at_ms: 1000, basis: 'tool-start', paths: ['src/a.ts'] }),
        evidence(2n, key('r1'), { at_ms: 3000, basis: 'tool-end', paths: ['src/a.ts'] }),
      ]);
      assert.equal(inv.size, 1);
      const only = [...inv.values()][0]!;
      assert.equal(only.conflicted, false);
      assert.equal(only.minAtMs, 1000);
      assert.equal(only.maxAtMs, 3000);
      assert.deepEqual(only.evidenceSeqs, [1n, 2n]);
      assert.deepEqual(only.scope, { kind: 'paths', paths: ['src/a.ts'] });
    });

    it('dedups a byte-identical reread to a single variant seq', () => {
      const inv = foldEvidence([
        evidence(1n, key('r1'), { at_ms: 1000, basis: 'record-time', paths: ['src/a.ts'] }),
        evidence(5n, key('r1'), { at_ms: 1000, basis: 'record-time', paths: ['src/a.ts'] }),
      ]);
      const only = [...inv.values()][0]!;
      assert.deepEqual(only.evidenceSeqs, [1n]);
      assert.equal(only.conflicted, false);
    });

    it('flags a conflict when two distinct variants share one basis', () => {
      const inv = foldEvidence([
        evidence(1n, key('r1'), { tool_name: 'Write', at_ms: 1000, basis: 'tool-start', paths: ['src/a.ts'] }),
        evidence(2n, key('r1'), { tool_name: 'Edit', at_ms: 1000, basis: 'tool-start', paths: ['src/b.ts'] }),
      ]);
      const only = [...inv.values()][0]!;
      assert.equal(only.conflicted, true);
      assert.deepEqual(only.evidenceSeqs, [1n, 2n]);
    });

    it('flags a conflict when tool names disagree across bases', () => {
      const inv = foldEvidence([
        evidence(1n, key('r1'), { tool_name: 'Write', at_ms: 1000, basis: 'tool-start', paths: ['src/a.ts'] }),
        evidence(2n, key('r1'), { tool_name: 'Bash', at_ms: 2000, basis: 'tool-end', paths: ['src/a.ts'] }),
      ]);
      assert.equal([...inv.values()][0]!.conflicted, true);
    });

    it('merges an unknown-scope record into an unknown invocation scope', () => {
      const inv = foldEvidence([
        evidence(1n, key('r1'), { at_ms: 1000, basis: 'tool-start', unknownScope: 'no-tool-input' }),
      ]);
      assert.equal([...inv.values()][0]!.scope.kind, 'unknown');
    });
  });

  describe('policy binding', () => {
    it('binds a change to the latest policy that precedes it by sequence', () => {
      const policies = foldPolicies([
        policyEvent(1n, POLICY),
        policyEvent(10n, { ...POLICY, window_ms: 9999 }),
      ]);
      assert.equal(bindPolicy(policies, 5n)?.seq, 1n);
      assert.equal(bindPolicy(policies, 11n)?.seq, 10n);
      assert.equal(bindPolicy(policies, 10n)?.seq, 1n, 'strictly preceding, not equal');
    });

    it('returns undefined for a change with no preceding policy (legacy)', () => {
      const policies = foldPolicies([policyEvent(5n, POLICY)]);
      assert.equal(bindPolicy(policies, 3n), undefined);
    });
  });

  describe('foldAttributions', () => {
    it('keeps the highest-seq attribution per change and validates the target', () => {
      const latest = foldAttributions([
        change(2n, 'src/a.ts'),
        attribution(3n, { change_seq: '2', policy_seq: '1', status: 'unknown', reason: 'no-matching-evidence', evidence_seqs: [] }),
        attribution(9n, { change_seq: '2', policy_seq: '1', status: 'heuristic', reason: 'single-candidate', evidence_seqs: ['5'] }),
      ]);
      assert.equal(latest.get(2n)?.data.status, 'heuristic');
      assert.equal(latest.get(2n)?.seq, 9n);
    });

    it('ignores an attribution whose target does not exist', () => {
      const latest = foldAttributions([
        attribution(3n, { change_seq: '2', policy_seq: '1', status: 'unknown', reason: 'no-matching-evidence', evidence_seqs: [] }),
      ]);
      assert.equal(latest.size, 0);
    });

    it('ignores an attribution that does not strictly precede its target', () => {
      const latest = foldAttributions([
        change(5n, 'src/a.ts'),
        attribution(4n, { change_seq: '5', policy_seq: '1', status: 'unknown', reason: 'no-matching-evidence', evidence_seqs: [] }),
      ]);
      assert.equal(latest.size, 0);
    });

    it('ignores an attribution targeting a non-file.changed seq', () => {
      const latest = foldAttributions([
        policyEvent(2n, POLICY),
        attribution(3n, { change_seq: '2', policy_seq: '1', status: 'unknown', reason: 'no-matching-evidence', evidence_seqs: [] }),
      ]);
      assert.equal(latest.size, 0);
    });
  });

  describe('evaluateChange', () => {
    const inv = (over: Partial<Invocation> & { keyStr: string }): Invocation => ({
      key: key(over.keyStr),
      toolName: 'Write',
      minAtMs: 1000,
      maxAtMs: 1000,
      scope: { kind: 'paths', paths: ['src/a.ts'] },
      conflicted: false,
      evidenceSeqs: [1n],
      ...over,
    });

    const interval = { start_ms: 1000, end_ms: 2000 };

    it('one eligible candidate -> heuristic', () => {
      const r = evaluateChange({
        changeSeq: 10n,
        path: 'src/a.ts',
        interval,
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', evidenceSeqs: [4n] })],
      });
      assert.equal(r.status, 'heuristic');
      assert.equal(r.reason, 'single-candidate');
      assert.deepEqual(r.evidenceSeqs, [4n]);
      assert.deepEqual(r.excludedConflicts, []);
    });

    it('two eligible candidates -> ambiguous', () => {
      const r = evaluateChange({
        changeSeq: 10n,
        path: 'src/a.ts',
        interval,
        policy: POLICY,
        invocations: [
          inv({ keyStr: 'k1', evidenceSeqs: [4n] }),
          inv({ keyStr: 'k2', evidenceSeqs: [6n] }),
        ],
      });
      assert.equal(r.status, 'ambiguous');
      assert.equal(r.reason, 'multiple-candidates');
      assert.deepEqual(r.evidenceSeqs, [4n, 6n]);
    });

    it('no candidates under an available interval -> unknown / no-matching-evidence', () => {
      const r = evaluateChange({ changeSeq: 10n, path: 'src/a.ts', interval, policy: POLICY, invocations: [] });
      assert.equal(r.status, 'unknown');
      assert.equal(r.reason, 'no-matching-evidence');
    });

    it('an unavailable interval -> unknown / observation-interval-unavailable', () => {
      const r = evaluateChange({
        changeSeq: 10n,
        path: 'src/a.ts',
        interval: { unavailable: true, reason: 'reconciliation' },
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1' })],
      });
      assert.equal(r.status, 'unknown');
      assert.equal(r.reason, 'observation-interval-unavailable');
      assert.deepEqual(r.evidenceSeqs, []);
    });

    it('a missing interval is read as unavailable', () => {
      const r = evaluateChange({
        changeSeq: 10n,
        path: 'src/a.ts',
        interval: undefined,
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1' })],
      });
      assert.equal(r.reason, 'observation-interval-unavailable');
    });

    it('excludes an invocation whose scope does not include the path', () => {
      const r = evaluateChange({
        changeSeq: 10n,
        path: 'src/a.ts',
        interval,
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', scope: { kind: 'paths', paths: ['src/other.ts'] } })],
      });
      assert.equal(r.status, 'unknown');
    });

    it('excludes an unknown-scope invocation from candidacy', () => {
      const r = evaluateChange({
        changeSeq: 10n,
        path: 'src/a.ts',
        interval,
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', scope: { kind: 'unknown', reason: 'x' } })],
      });
      assert.equal(r.status, 'unknown');
    });

    it('treats window overlap as inclusive at the boundary', () => {
      // window = [minAt - 2000, maxAt + 2000] = [-1000, 3000]; interval starts at 3000.
      const r = evaluateChange({
        changeSeq: 10n,
        path: 'src/a.ts',
        interval: { start_ms: 3000, end_ms: 4000 },
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', minAtMs: 1000, maxAtMs: 1000 })],
      });
      assert.equal(r.status, 'heuristic', 'touching at exactly one point still overlaps');
    });

    it('excludes an invocation whose window falls entirely before the interval', () => {
      const r = evaluateChange({
        changeSeq: 10n,
        path: 'src/a.ts',
        interval: { start_ms: 10000, end_ms: 11000 },
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', minAtMs: 1000, maxAtMs: 1000 })],
      });
      assert.equal(r.status, 'unknown');
    });

    it('discloses a relevant conflict and never counts it as a candidate', () => {
      const r = evaluateChange({
        changeSeq: 10n,
        path: 'src/a.ts',
        interval,
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', conflicted: true, evidenceSeqs: [4n, 5n] })],
      });
      assert.equal(r.status, 'unknown');
      assert.equal(r.reason, 'no-matching-evidence');
      assert.equal(r.excludedConflicts.length, 1);
      assert.equal(r.excludedConflicts[0]!.record_id, 'k1');
    });

    it('keeps an eligible candidate while still disclosing a separate conflict', () => {
      const r = evaluateChange({
        changeSeq: 10n,
        path: 'src/a.ts',
        interval,
        policy: POLICY,
        invocations: [
          inv({ keyStr: 'good', evidenceSeqs: [4n] }),
          inv({ keyStr: 'bad', conflicted: true, evidenceSeqs: [7n] }),
        ],
      });
      assert.equal(r.status, 'heuristic');
      assert.deepEqual(r.evidenceSeqs, [4n]);
      assert.equal(r.excludedConflicts.length, 1);
      assert.equal(r.excludedConflicts[0]!.record_id, 'bad');
    });
  });

  describe('attributionResultsEqual', () => {
    const base = {
      session_id: SESSION,
      change_seq: '10',
      policy_seq: '1',
      status: 'heuristic' as const,
      reason: 'single-candidate' as const,
      evidence_seqs: ['4', '6'],
    };
    it('treats reordered evidence seqs as equal', () => {
      assert.equal(attributionResultsEqual(base, { ...base, evidence_seqs: ['6', '4'] }), true);
    });
    it('treats a different status as not equal', () => {
      assert.equal(attributionResultsEqual(base, { ...base, status: 'ambiguous' }), false);
    });
    it('treats a different bound policy as not equal', () => {
      assert.equal(attributionResultsEqual(base, { ...base, policy_seq: '2' }), false);
    });
    it('treats a different conflict disclosure as not equal', () => {
      assert.equal(
        attributionResultsEqual(base, { ...base, excluded_conflicts: [key('bad')] }),
        false,
      );
    });
  });
});
