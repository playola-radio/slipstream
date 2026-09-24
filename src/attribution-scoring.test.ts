import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EnrichmentPolicy, EvidenceKey } from './event.ts';
import type { Invocation } from './attribution.ts';
import { attributionResultsEqual, evaluateChange } from './attribution-scoring.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';

const POLICY: EnrichmentPolicy = {
  window_ms: 2000,
  grace_ms: 5000,
  sources: { 'claude-code': 'unconfigured', codex: 'unconfigured' },
};

const key = (record_id: string, harness_session_id = 'hs-1'): EvidenceKey => ({
  harness: 'claude-code',
  harness_session_id,
  record_id,
});

describe('attribution scoring', () => {
  describe('evaluateChange', () => {
    const inv = (over: Partial<Invocation> & { keyStr: string }): Invocation => ({
      key: key(over.keyStr),
      minAtMs: 1000,
      maxAtMs: 1000,
      knownPaths: ['src/a.ts'],
      conflicted: false,
      evidenceSeqs: [1n],
      ...over,
    });

    const interval = { start_ms: 1000, end_ms: 2000 };

    it('one eligible candidate -> heuristic', () => {
      const r = evaluateChange({
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
      const r = evaluateChange({ path: 'src/a.ts', interval, policy: POLICY, invocations: [] });
      assert.equal(r.status, 'unknown');
      assert.equal(r.reason, 'no-matching-evidence');
    });

    it('an unavailable interval -> unknown / observation-interval-unavailable', () => {
      const r = evaluateChange({
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
        path: 'src/a.ts',
        interval: undefined,
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1' })],
      });
      assert.equal(r.reason, 'observation-interval-unavailable');
    });

    it('an inverted interval (end before start, e.g. clock regression) is unavailable, not a false match', () => {
      const r = evaluateChange({
        path: 'src/a.ts',
        interval: { start_ms: 2000, end_ms: 1000 },
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', minAtMs: 1500, maxAtMs: 1500 })],
      });
      assert.equal(r.status, 'unknown');
      assert.equal(r.reason, 'observation-interval-unavailable');
      assert.deepEqual(r.evidenceSeqs, []);
    });

    it('excludes an invocation whose scope does not include the path', () => {
      const r = evaluateChange({
        path: 'src/a.ts',
        interval,
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', knownPaths: ['src/other.ts'] })],
      });
      assert.equal(r.status, 'unknown');
    });

    it('excludes an invocation with no known paths from candidacy', () => {
      const r = evaluateChange({
        path: 'src/a.ts',
        interval,
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', knownPaths: [] })],
      });
      assert.equal(r.status, 'unknown');
    });

    it('treats window overlap as inclusive at the boundary', () => {
      // window = [minAt - 2000, maxAt + 2000] = [-1000, 3000]; interval starts at 3000.
      const r = evaluateChange({
        path: 'src/a.ts',
        interval: { start_ms: 3000, end_ms: 4000 },
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', minAtMs: 1000, maxAtMs: 1000 })],
      });
      assert.equal(r.status, 'heuristic', 'touching at exactly one point still overlaps');
    });

    it('excludes an invocation whose window falls entirely before the interval', () => {
      const r = evaluateChange({
        path: 'src/a.ts',
        interval: { start_ms: 10000, end_ms: 11000 },
        policy: POLICY,
        invocations: [inv({ keyStr: 'k1', minAtMs: 1000, maxAtMs: 1000 })],
      });
      assert.equal(r.status, 'unknown');
    });

    it('discloses a relevant conflict and never counts it as a candidate', () => {
      const r = evaluateChange({
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
