import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, sourceFor, type AnyEvent, type EnrichmentPolicy, type EvidenceKey } from './event.ts';
import {
  attributionTargetKey,
  evidenceKeyString,
  foldAttributions,
  foldEvidence,
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
      assert.deepEqual(only.knownPaths, ['src/a.ts']);
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

    it('contributes no known path for an unknown-scope record', () => {
      const inv = foldEvidence([
        evidence(1n, key('r1'), { at_ms: 1000, basis: 'tool-start', unknownScope: 'no-tool-input' }),
      ]);
      assert.deepEqual([...inv.values()][0]!.knownPaths, []);
    });

    it('keeps a sibling path known when one variant is unknown-scope, so the conflict is disclosable', () => {
      const inv = foldEvidence([
        evidence(1n, key('r1'), { at_ms: 1000, basis: 'record-time', paths: ['src/a.ts'] }),
        evidence(2n, key('r1'), { at_ms: 1000, basis: 'record-time', unknownScope: 'parse-failed' }),
      ]);
      const only = [...inv.values()][0]!;
      assert.equal(only.conflicted, true);
      assert.deepEqual(only.knownPaths, ['src/a.ts']);
    });
  });

  describe('foldAttributions', () => {
    const targetKey = (changeSeq: string) => attributionTargetKey(sourceFor(SESSION), changeSeq);

    it('keeps the highest-seq attribution per change and validates the target', () => {
      const latest = foldAttributions([
        change(2n, 'src/a.ts'),
        attribution(3n, { change_seq: '2', policy_seq: '1', status: 'unknown', reason: 'no-matching-evidence', evidence_seqs: [] }),
        attribution(9n, { change_seq: '2', policy_seq: '1', status: 'heuristic', reason: 'single-candidate', evidence_seqs: ['5'] }),
      ]);
      assert.equal(latest.get(targetKey('2'))?.data.status, 'heuristic');
      assert.equal(latest.get(targetKey('2'))?.seq, 9n);
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
});
