import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnvelope,
  type AnyEvent,
  type ChangeAttributionData,
  type EnrichmentPolicy,
  type EvidenceKey,
  type ObservedInterval,
} from './event.ts';
import { createAttributionEngine, type CommittedChange } from './attribution-engine.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const SHA = 'a'.repeat(64);

const POLICY: EnrichmentPolicy = {
  window_ms: 2000,
  grace_ms: 5000,
  sources: { 'claude-code': 'unconfigured', codex: 'unconfigured' },
};

/** A controllable clock + single-timer registry, driven by `advance`. */
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

/** A fake single-writer log for attribution appends. */
function fakeLog() {
  let seq = 100n; // start high so change/evidence seqs are clearly lower
  const events: AnyEvent[] = [];
  const appendAttribution = async (
    data: Omit<ChangeAttributionData, 'session_id'>,
  ): Promise<AnyEvent> => {
    seq += 1n;
    const e = buildEnvelope(
      { type: 'slipstream.change.attribution.v1', occurred_at_ms: 0, data },
      seq,
      SESSION,
    );
    events.push(e);
    return e;
  };
  return { appendAttribution, events };
}

function evidenceEvent(
  seq: bigint,
  key: EvidenceKey,
  fields: { at_ms: number; tool_name?: string; basis?: 'tool-start' | 'tool-end' | 'record-time'; paths?: string[] },
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
        file_scope: { kind: 'paths', paths: fields.paths ?? ['src/a.ts'] },
      },
    },
    seq,
    SESSION,
  );
}

const key = (record_id: string): EvidenceKey => ({
  harness: 'claude-code',
  harness_session_id: 'h1',
  record_id,
});

const change = (
  changeSeq: bigint,
  interval: ObservedInterval | undefined,
  path = 'src/a.ts',
): CommittedChange => ({ changeSeq, path, interval, policy: POLICY, policySeq: 5n });

/** Wire an engine over an in-memory, mutable evidence log. */
function harness(initialEvidence: AnyEvent[] = []) {
  const sched = fakeScheduler();
  const log = fakeLog();
  const evidence = [...initialEvidence];
  const engine = createAttributionEngine({
    now: sched.now,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    readEvents: () => evidence,
    appendAttribution: log.appendAttribution,
  });
  const results = () =>
    log.events.map((e) => e.data as ChangeAttributionData);
  return { engine, sched, evidence, results, events: log.events };
}

describe('attribution engine', () => {
  it('resolves an unavailable interval immediately to unknown, no grace', async () => {
    const h = harness();
    h.engine.onChangeCommitted(change(10n, { unavailable: true, reason: 'reconciliation' }));
    await h.engine.drain();
    assert.equal(h.results().length, 1);
    assert.equal(h.results()[0]?.status, 'unknown');
    assert.equal(h.results()[0]?.reason, 'observation-interval-unavailable');
  });

  it('waits for the grace deadline before the first evaluation', async () => {
    const h = harness();
    h.engine.onChangeCommitted(change(10n, { start_ms: 1000, end_ms: 1000 }));
    h.sched.advance(5999); // deadline is end_ms(1000)+grace(5000)=6000
    await h.engine.drain();
    assert.equal(h.results().length, 0, 'nothing published before grace elapses');
    h.sched.advance(1);
    await h.engine.drain();
    assert.equal(h.results().length, 1);
    assert.equal(h.results()[0]?.status, 'unknown');
    assert.equal(h.results()[0]?.reason, 'no-matching-evidence');
  });

  it('credits a single overlapping invocation as heuristic (possibly agent, not authored)', async () => {
    // A human save landing inside a matching agent tool window: temporal overlap
    // is evidence, not proof, so the honest status is heuristic — never a silent
    // "attributed", and there is no out-of-window cop-out here (the window covers it).
    const h = harness([evidenceEvent(1n, key('r1'), { at_ms: 1500 })]);
    h.engine.onChangeCommitted(change(10n, { start_ms: 1000, end_ms: 1000 }));
    h.sched.advance(6000);
    await h.engine.drain();
    assert.equal(h.results().length, 1);
    assert.equal(h.results()[0]?.status, 'heuristic');
    assert.equal(h.results()[0]?.reason, 'single-candidate');
    assert.deepEqual(h.results()[0]?.evidence_seqs, ['1']);
  });

  it('marks two overlapping parallel invocations ambiguous', async () => {
    const h = harness([
      evidenceEvent(1n, key('r1'), { at_ms: 1400 }),
      evidenceEvent(2n, key('r2'), { at_ms: 1600 }),
    ]);
    h.engine.onChangeCommitted(change(10n, { start_ms: 1000, end_ms: 1000 }));
    h.sched.advance(6000);
    await h.engine.drain();
    assert.equal(h.results().length, 1);
    assert.equal(h.results()[0]?.status, 'ambiguous');
    assert.equal(h.results()[0]?.reason, 'multiple-candidates');
    assert.deepEqual(h.results()[0]?.evidence_seqs, ['1', '2']);
  });

  it('revises a resolved change when late evidence arrives, without a new grace and without mutating the original', async () => {
    const h = harness();
    h.engine.onChangeCommitted(change(10n, { start_ms: 1000, end_ms: 1000 }));
    h.sched.advance(6000);
    await h.engine.drain();
    assert.equal(h.results()[0]?.status, 'unknown', 'first result is honest unknown');
    const firstSeq = h.events[0]?.seq;

    // Late evidence appears; a fresh evaluation runs immediately (no new grace).
    h.evidence.push(evidenceEvent(3n, key('r1'), { at_ms: 1500 }));
    h.engine.onEvidenceChanged();
    await h.engine.drain();

    assert.equal(h.results().length, 2, 'a revision is appended, not an overwrite');
    assert.equal(h.results()[1]?.status, 'heuristic');
    assert.equal(h.events[0]?.seq, firstSeq, 'the original attribution event is immutable');
    assert.equal(h.results()[0]?.status, 'unknown');
    assert.equal(h.results()[1]?.change_seq, '10');
    assert.equal(h.results()[0]?.policy_seq, '5', 'both results carry the change bound policy');
    assert.equal(h.results()[1]?.policy_seq, '5');
  });

  it('appends nothing when a re-evaluation reproduces the same semantic result', async () => {
    const h = harness([evidenceEvent(1n, key('r1'), { at_ms: 1500 })]);
    h.engine.onChangeCommitted(change(10n, { start_ms: 1000, end_ms: 1000 }));
    h.sched.advance(6000);
    await h.engine.drain();
    assert.equal(h.results().length, 1);

    // Re-reading the identical evidence changes nothing semantic.
    h.engine.onEvidenceChanged();
    await h.engine.drain();
    assert.equal(h.results().length, 1, 'no redundant revision');
  });

  it('discloses a conflicted invocation instead of silently crediting or dropping it', async () => {
    // Same native key, same basis, disagreeing tool_name -> a conflicted invocation.
    const h = harness([
      evidenceEvent(1n, key('r1'), { at_ms: 1500, tool_name: 'Write' }),
      evidenceEvent(2n, key('r1'), { at_ms: 1500, tool_name: 'Edit' }),
    ]);
    h.engine.onChangeCommitted(change(10n, { start_ms: 1000, end_ms: 1000 }));
    h.sched.advance(6000);
    await h.engine.drain();
    assert.equal(h.results().length, 1);
    assert.equal(h.results()[0]?.status, 'unknown');
    assert.equal(h.results()[0]?.reason, 'no-matching-evidence');
    assert.deepEqual(h.results()[0]?.excluded_conflicts, [key('r1')]);
  });

  it('is idempotent for a repeated change commit', async () => {
    const h = harness();
    const c = change(10n, { unavailable: true, reason: 'reconciliation' });
    h.engine.onChangeCommitted(c);
    h.engine.onChangeCommitted(c);
    await h.engine.drain();
    assert.equal(h.results().length, 1);
  });
});
