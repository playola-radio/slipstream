import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, type AnyEvent, type EventInput } from './event.ts';
import { createEvidenceIngestor, type NormalizedEvidence } from './evidence-ingest.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';

/** A fake single-writer log: assigns contiguous seqs, keeps the appended events. */
function fakeLog() {
  let seq = 0n;
  const events: AnyEvent[] = [];
  const append = async (input: EventInput): Promise<AnyEvent> => {
    seq += 1n;
    const e = buildEnvelope(input, seq, SESSION);
    events.push(e);
    return e;
  };
  return { append, events };
}

/** Like {@link fakeLog} but every append blocks until `release()` is called, so a
 * test can pile up admitted-but-not-durable requests behind the serialized tail. */
function gatedLog() {
  let seq = 0n;
  const events: AnyEvent[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const append = async (input: EventInput): Promise<AnyEvent> => {
    await gate;
    seq += 1n;
    const e = buildEnvelope(input, seq, SESSION);
    events.push(e);
    return e;
  };
  return { append, events, release: () => release() };
}

function ev(fields: {
  record_id?: string;
  tool_name?: string;
  at_ms?: number;
  basis?: 'tool-start' | 'tool-end' | 'record-time';
  paths?: string[];
} = {}): NormalizedEvidence {
  return {
    evidence_key: {
      harness: 'claude-code',
      harness_session_id: 'h1',
      record_id: fields.record_id ?? 'r1',
    },
    adapter_version: 'test/1',
    tool_name: fields.tool_name ?? 'Write',
    timestamp: { at_ms: fields.at_ms ?? 1000, basis: fields.basis ?? 'record-time' },
    file_scope: { kind: 'paths', paths: fields.paths ?? ['src/a.ts'] },
  };
}

const clock = () => 42;

describe('evidence ingestion', () => {
  it('appends a new evidence record and returns its durable seq', async () => {
    const log = fakeLog();
    const ingestor = createEvidenceIngestor({ append: log.append, now: clock });
    const outcome = await ingestor.ingest(ev());
    assert.deepEqual(outcome, { status: 'appended', seq: 1n });
    assert.equal(log.events.length, 1);
    assert.equal(log.events[0]?.type, 'slipstream.harness.evidence.v1');
  });

  it('appends nothing when the identical record is re-ingested (log-derived dedup)', async () => {
    const log = fakeLog();
    const ingestor = createEvidenceIngestor({ append: log.append, now: clock });
    await ingestor.ingest(ev());
    const second = await ingestor.ingest(ev());
    assert.deepEqual(second, { status: 'duplicate' });
    assert.equal(log.events.length, 1);
  });

  it('appends a differing variant under the same key, never overwriting the first', async () => {
    const log = fakeLog();
    const ingestor = createEvidenceIngestor({ append: log.append, now: clock });
    const first = await ingestor.ingest(ev({ tool_name: 'Write' }));
    const conflicting = await ingestor.ingest(ev({ tool_name: 'Edit' }));
    assert.equal(first.status, 'appended');
    assert.equal(conflicting.status, 'appended');
    assert.equal(log.events.length, 2, 'both variants retained');
    // Re-reading the conflicting variant adds nothing more.
    const reread = await ingestor.ingest(ev({ tool_name: 'Edit' }));
    assert.deepEqual(reread, { status: 'duplicate' });
    assert.equal(log.events.length, 2);
  });

  it('appends exactly once when identical records are ingested concurrently', async () => {
    const log = gatedLog();
    const ingestor = createEvidenceIngestor({ append: log.append, now: clock });
    const p1 = ingestor.ingest(ev());
    const p2 = ingestor.ingest(ev());
    log.release();
    const [o1, o2] = await Promise.all([p1, p2]);
    const statuses = [o1.status, o2.status].sort();
    assert.deepEqual(statuses, ['appended', 'duplicate']);
    assert.equal(log.events.length, 1);
  });

  it('rejects with a retryable queue-full error past the pending bound', async () => {
    const log = gatedLog();
    const ingestor = createEvidenceIngestor({ append: log.append, now: clock, maxPending: 2 });
    const p1 = ingestor.ingest(ev({ record_id: 'r1' }));
    const p2 = ingestor.ingest(ev({ record_id: 'r2' }));
    const p3 = ingestor.ingest(ev({ record_id: 'r3' }));
    assert.deepEqual(await p3, { status: 'rejected', reason: 'queue-full', retryable: true });
    log.release();
    const [o1, o2] = await Promise.all([p1, p2]);
    assert.equal(o1.status, 'appended');
    assert.equal(o2.status, 'appended');
    assert.equal(log.events.length, 2);
  });

  it('rejects when the queued byte budget would be exceeded', async () => {
    const log = gatedLog();
    const size = Buffer.byteLength(JSON.stringify(ev({ record_id: 'r1' })));
    const ingestor = createEvidenceIngestor({
      append: log.append,
      now: clock,
      maxQueuedBytes: size,
    });
    const p1 = ingestor.ingest(ev({ record_id: 'r1' }));
    const p2 = ingestor.ingest(ev({ record_id: 'r2' }));
    assert.deepEqual(await p2, { status: 'rejected', reason: 'queue-full', retryable: true });
    log.release();
    assert.equal((await p1).status, 'appended');
    assert.equal(log.events.length, 1);
  });

  it('seeds the committed index from replayed evidence so a known variant dedups', async () => {
    const log = fakeLog();
    const ingestor = createEvidenceIngestor({ append: log.append, now: clock });
    const replayed = buildEnvelope(
      { type: 'slipstream.harness.evidence.v1', occurred_at_ms: 1000, data: ev() },
      7n,
      SESSION,
    );
    ingestor.seed([replayed]);
    const outcome = await ingestor.ingest(ev());
    assert.deepEqual(outcome, { status: 'duplicate' });
    assert.equal(log.events.length, 0, 'a replayed variant is not re-appended');
  });
});
