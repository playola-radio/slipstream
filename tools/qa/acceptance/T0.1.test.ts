import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prefixClaim, negativeControlClaim, corpusClaim } from './T0.1.ts';
import type { AcceptanceContext } from './types.ts';
import type { ReaderClient, FiniteEvents, SseFrame, AnyRecord } from '../../qa-support.ts';

const SOURCE = 'urn:slipstream:session:qa';

function record(seq: bigint, extra: Record<string, unknown> = {}): AnyRecord {
  return { source: SOURCE, seq: seq.toString(), type: 'slipstream.file.changed.v1', data: { path: `f${seq}` }, ...extra };
}

/** Finite replay serves `finite`; SSE replays `sse` (records strictly after `after`). */
function fakeReader(finite: AnyRecord[], durable: bigint, sse: AnyRecord[]): ReaderClient {
  return {
    raw: async () => { throw new Error('unused'); },
    sessions: async () => { throw new Error('unused'); },
    blob: async () => { throw new Error('unused'); },
    finite: async (): Promise<FiniteEvents> => ({ events: finite, durableSeq: durable }),
    follow: async (_sid, after, signal, onEvent: (f: SseFrame) => void): Promise<void> => {
      for (const r of sse.filter((e) => BigInt(e.seq as string) > after)) {
        if (signal.aborted) return;
        onEvent({ id: r.seq as string, event: 'slipstream', data: JSON.stringify(r) });
      }
    },
  };
}

function ctxWith(reader: ReaderClient): AcceptanceContext {
  return { worktree: '/x', sessionId: 'qa:test', reader, signal: new AbortController().signal };
}

describe('T0.1 prefix claim', () => {
  const three = [record(1n), record(2n), record(3n)];

  it('passes when SSE delivers every finite identity through H with identical records', async () => {
    const a = await prefixClaim(ctxWith(fakeReader(three, 3n, [...three, record(4n)])));
    assert.equal(a.id, 'fold-prefix-agreement');
  });

  it('fails when SSE skips an identity at or below H', async () => {
    const reader = fakeReader(three, 3n, [record(1n), record(3n)]);
    await assert.rejects(() => prefixClaim(ctxWith(reader)), /did not deliver every identity/);
  });

  it('fails when the finite replay itself is missing an identity below H', async () => {
    const reader = fakeReader([record(1n), record(3n)], 3n, three);
    await assert.rejects(() => prefixClaim(ctxWith(reader)), /not contiguous/);
  });

  it('fails when SSE carries different content at a shared identity', async () => {
    const reader = fakeReader(three, 3n, [record(1n), record(2n, { time: 'other' }), record(3n)]);
    await assert.rejects(() => prefixClaim(ctxWith(reader)), /conflicting-records/);
  });
});

describe('T0.1 negative control', () => {
  it('reports corruption for an in-memory conflicting copy of a live record', () => {
    const a = negativeControlClaim([record(1n), record(2n)]);
    assert.deepEqual(a.evidence, { result: 'corrupt', source: SOURCE, seq: '2' });
  });

  it('refuses to run without a live record to perturb', () => {
    assert.throws(() => negativeControlClaim([]), /no live record/);
  });
});

describe('T0.1 corpus claim', () => {
  it('matches every hand-written case', async () => {
    const a = await corpusClaim();
    const evidence = a.evidence as { cases: number; names: string[] };
    assert.equal(evidence.cases, evidence.names.length);
    assert.ok(evidence.names.includes('revision-and-gap'));
  });
});
