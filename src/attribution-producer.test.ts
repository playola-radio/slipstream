import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnvelope,
  type AnyEvent,
  type ChangeAttributionData,
  type EnrichmentPolicy,
  type EventInput,
  type EvidenceKey,
  type ObservedInterval,
} from './event.ts';
import type { Snapshot } from './snapshot.ts';
import { createAttributionProducer, type AttributionProducer } from './attribution-producer.ts';
import type { NormalizedEvidence } from './evidence-ingest.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const SHA = 'a'.repeat(64);

const POLICY: EnrichmentPolicy = {
  window_ms: 2000,
  grace_ms: 5000,
  sources: { 'claude-code': 'unconfigured', codex: 'unconfigured' },
};

function fakeScheduler() {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  return {
    now: () => current,
    setTimer: (delayMs: number, fn: () => void): number => {
      const id = nextId++;
      timers.set(id, { fireAt: current + delayMs, fn });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    advance(ms: number): void {
      current += ms;
      for (;;) {
        let fired = false;
        for (const [id, t] of [...timers]) {
          if (t.fireAt <= current) {
            timers.delete(id);
            t.fn();
            fired = true;
          }
        }
        if (!fired) break;
      }
    },
  };
}

const content: Snapshot = { kind: 'content', sha256: SHA, size: 1 };
const absent: Snapshot = { kind: 'absent' };

function fileChangedInput(
  path: string,
  interval: ObservedInterval | undefined,
): EventInput {
  return {
    type: 'slipstream.file.changed.v1',
    occurred_at_ms: interval && 'start_ms' in interval ? interval.start_ms : 0,
    data: {
      path,
      before: absent,
      after: content,
      observation: 'watcher',
      ...(interval ? { observed_interval_ms: interval } : {}),
    },
  };
}

const key = (record_id: string): EvidenceKey => ({
  harness: 'claude-code',
  harness_session_id: 'h1',
  record_id,
});

function evidence(record_id: string, at_ms: number, tool_name = 'Write'): NormalizedEvidence {
  return {
    evidence_key: key(record_id),
    adapter_version: 'test/1',
    tool_name,
    timestamp: { at_ms, basis: 'record-time' },
    file_scope: { kind: 'paths', paths: ['src/a.ts'] },
  };
}

/** A session-shaped harness: one serialized log that routes every commit back to
 * the producer, exactly as the real {@link AppendSequencer.onCommitted} does. */
function harness() {
  const sched = fakeScheduler();
  let seq = 0n;
  const events: AnyEvent[] = [];
  let producer!: AttributionProducer;
  const append = async (input: EventInput): Promise<AnyEvent> => {
    seq += 1n;
    const e = buildEnvelope(input, seq, SESSION);
    events.push(e);
    producer.noteCommitted(e);
    return e;
  };
  producer = createAttributionProducer({
    appendEvent: append,
    now: sched.now,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
  });
  const attributions = (): ChangeAttributionData[] =>
    events
      .filter((e) => e.type === 'slipstream.change.attribution.v1')
      .map((e) => e.data as ChangeAttributionData);
  const policies = (): AnyEvent[] =>
    events.filter((e) => e.type === 'slipstream.enrichment.configured.v1');
  return { producer, sched, events, attributions, policies, append };
}

describe('attribution producer', () => {
  it('attributes a change committed under an effective policy', async () => {
    const h = harness();
    h.producer.start([]);
    await h.producer.ensurePolicy(POLICY);
    await h.append(fileChangedInput('src/a.ts', { start_ms: 1000, end_ms: 1000 }));
    h.sched.advance(6000);
    await h.producer.drain();
    assert.equal(h.attributions().length, 1);
    assert.equal(h.attributions()[0]?.status, 'unknown');
    assert.equal(h.attributions()[0]?.reason, 'no-matching-evidence');
  });

  it('does not attribute a change committed before any policy (legacy record)', async () => {
    const h = harness();
    h.producer.start([]);
    await h.append(fileChangedInput('src/a.ts', { start_ms: 1000, end_ms: 1000 }));
    h.sched.advance(6000);
    await h.producer.drain();
    assert.equal(h.attributions().length, 0);
  });

  it('appends the policy only when it differs from the committed one', async () => {
    const h = harness();
    h.producer.start([]);
    await h.producer.ensurePolicy(POLICY);
    await h.producer.ensurePolicy(POLICY);
    await h.producer.ensurePolicy({ ...POLICY, sources: { codex: 'unconfigured', 'claude-code': 'unconfigured' } });
    assert.equal(h.policies().length, 1, 'identical policy (any key order) is not re-appended');
    await h.producer.ensurePolicy({ ...POLICY, grace_ms: 9000 });
    assert.equal(h.policies().length, 2, 'a genuinely different policy is appended');
  });

  it('revises a change when ingested evidence overlaps its window', async () => {
    const h = harness();
    h.producer.start([]);
    await h.producer.ensurePolicy(POLICY);
    await h.append(fileChangedInput('src/a.ts', { start_ms: 1000, end_ms: 1000 }));
    await h.producer.ingestEvidence(evidence('r1', 1500));
    h.sched.advance(6000);
    await h.producer.drain();
    assert.equal(h.attributions().length, 1);
    assert.equal(h.attributions()[0]?.status, 'heuristic');
    assert.equal(h.attributions()[0]?.reason, 'single-candidate');
  });

  it('marks two overlapping parallel invocations ambiguous, never silently credited', async () => {
    const h = harness();
    h.producer.start([]);
    await h.producer.ensurePolicy(POLICY);
    await h.append(fileChangedInput('src/a.ts', { start_ms: 1000, end_ms: 1000 }));
    await h.producer.ingestEvidence(evidence('r1', 1400));
    await h.producer.ingestEvidence(evidence('r2', 1600));
    h.sched.advance(6000);
    await h.producer.drain();
    assert.equal(h.attributions().length, 1);
    assert.equal(h.attributions()[0]?.status, 'ambiguous');
    assert.equal(h.attributions()[0]?.reason, 'multiple-candidates');
  });

  it('discloses a conflicted invocation instead of a silent overwrite', async () => {
    const h = harness();
    h.producer.start([]);
    await h.producer.ensurePolicy(POLICY);
    await h.append(fileChangedInput('src/a.ts', { start_ms: 1000, end_ms: 1000 }));
    const first = await h.producer.ingestEvidence(evidence('r1', 1500, 'Write'));
    const conflicting = await h.producer.ingestEvidence(evidence('r1', 1500, 'Edit'));
    assert.equal(first.status, 'appended');
    assert.equal(conflicting.status, 'appended');
    h.sched.advance(6000);
    await h.producer.drain();
    assert.equal(h.attributions()[0]?.status, 'unknown');
    assert.deepEqual(h.attributions()[0]?.excluded_conflicts, [key('r1')]);
  });

  it('replay seeds prior results so a reproduced attribution appends nothing', async () => {
    const h = harness();
    // A durable log where the change already carries a matching heuristic result.
    const policyEvt = buildEnvelope(
      { type: 'slipstream.enrichment.configured.v1', occurred_at_ms: 0, data: { policy: POLICY } },
      1n,
      SESSION,
    );
    const changeEvt = buildEnvelope(fileChangedInput('src/a.ts', { start_ms: 1000, end_ms: 1000 }), 2n, SESSION);
    const evidenceEvt = buildEnvelope(
      { type: 'slipstream.harness.evidence.v1', occurred_at_ms: 1500, data: evidence('r1', 1500) },
      3n,
      SESSION,
    );
    const attrEvt = buildEnvelope(
      {
        type: 'slipstream.change.attribution.v1',
        occurred_at_ms: 0,
        data: {
          change_seq: '2',
          policy_seq: '1',
          status: 'heuristic',
          reason: 'single-candidate',
          evidence_seqs: ['3'],
        },
      },
      4n,
      SESSION,
    );
    h.sched.advance(7000); // past the change's grace deadline
    h.producer.start([policyEvt, changeEvt, evidenceEvt, attrEvt]);
    h.sched.advance(1);
    await h.producer.drain();
    assert.equal(h.attributions().length, 0, 'no double-attribution: the same result is not re-appended');
  });

  it('replay attributes a change that was still pending (no prior result)', async () => {
    const h = harness();
    const policyEvt = buildEnvelope(
      { type: 'slipstream.enrichment.configured.v1', occurred_at_ms: 0, data: { policy: POLICY } },
      1n,
      SESSION,
    );
    const changeEvt = buildEnvelope(fileChangedInput('src/a.ts', { start_ms: 1000, end_ms: 1000 }), 2n, SESSION);
    h.sched.advance(7000);
    h.producer.start([policyEvt, changeEvt]);
    h.sched.advance(1);
    await h.producer.drain();
    assert.equal(h.attributions().length, 1);
    assert.equal(h.attributions()[0]?.change_seq, '2');
    assert.equal(h.attributions()[0]?.status, 'unknown');
  });

  it('stop cancels an outstanding grace so no attribution is appended', async () => {
    const h = harness();
    h.producer.start([]);
    await h.producer.ensurePolicy(POLICY);
    await h.append(fileChangedInput('src/a.ts', { start_ms: 1000, end_ms: 1000 }));
    await h.producer.stop();
    h.sched.advance(6000);
    assert.equal(h.attributions().length, 0);
  });

  it('ignores commits routed while stopped', async () => {
    const h = harness();
    h.producer.start([]);
    await h.producer.ensurePolicy(POLICY);
    await h.producer.stop();
    await h.append(fileChangedInput('src/a.ts', { start_ms: 1000, end_ms: 1000 }));
    h.sched.advance(6000);
    await h.producer.drain();
    assert.equal(h.attributions().length, 0);
  });
});
