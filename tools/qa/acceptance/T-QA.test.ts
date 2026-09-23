import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criterion3 } from './T-QA.ts';
import type { AcceptanceContext } from './types.ts';
import type { ReaderClient, FiniteEvents, SseFrame, AnyRecord } from '../../qa-support.ts';

/** A reader whose finite replay is the canonical [1..durable] and whose SSE
 * stream replays a SCRIPTED seq list (per `after`), so a test can inject a
 * duplicated or reordered stream and prove criterion3 catches it. */
function fakeReader(durable: bigint, script: (after: bigint) => bigint[]): ReaderClient {
  const finiteEvents: AnyRecord[] = [];
  for (let s = 1n; s <= durable; s++) finiteEvents.push({ seq: s.toString() });
  return {
    raw: async () => { throw new Error('unused'); },
    sessions: async () => { throw new Error('unused'); },
    blob: async () => { throw new Error('unused'); },
    finite: async (_sid, after): Promise<FiniteEvents> => ({
      events: finiteEvents.filter((e) => BigInt(e.seq as string) > after),
      durableSeq: durable,
    }),
    follow: async (_sid, after, signal, onEvent: (f: SseFrame) => void): Promise<void> => {
      // A real follow(after) only ever delivers seqs strictly greater than `after`.
      for (const seq of script(after).filter((s) => s > after)) {
        if (signal.aborted) return;
        onEvent({ id: seq.toString(), event: 'slipstream', data: JSON.stringify({ seq: seq.toString() }) });
      }
    },
  };
}

function ctxWith(reader: ReaderClient): AcceptanceContext {
  return { worktree: '/x', sessionId: 'qa:test', reader, signal: new AbortController().signal };
}

describe('criterion3 SSE parity is delivery-order strict', () => {
  it('passes when SSE delivers the finite identities in order', async () => {
    const reader = fakeReader(3n, () => [1n, 2n, 3n]);
    const a = await criterion3(ctxWith(reader));
    assert.equal(a.id, 'finite-sse-agreement');
  });

  it('fails a DUPLICATED SSE delivery that a dedup would have masked', async () => {
    // [1,2,2,3] must NOT be accepted against finite [1,2,3].
    const reader = fakeReader(3n, (after) => (after === 0n ? [1n, 2n, 2n, 3n] : [2n, 3n]));
    await assert.rejects(() => criterion3(ctxWith(reader)), /disagree up to durable high-water/);
  });

  it('fails a REORDERED SSE delivery that a re-sort would have masked', async () => {
    // [2,1,3] must NOT be accepted against finite [1,2,3].
    const reader = fakeReader(3n, (after) => (after === 0n ? [2n, 1n, 3n] : [2n, 3n]));
    await assert.rejects(() => criterion3(ctxWith(reader)), /disagree up to durable high-water/);
  });

  it('rejects a data frame that carries no SSE id (resume token)', async () => {
    const reader: ReaderClient = {
      ...fakeReader(3n, () => [1n, 2n, 3n]),
      follow: async (_sid, _after, signal, onEvent): Promise<void> => {
        if (signal.aborted) return;
        onEvent({ event: 'slipstream', data: JSON.stringify({ seq: '1' }) }); // no id
      },
    };
    await assert.rejects(() => criterion3(ctxWith(reader)), /carried no id/);
  });

  it('reconnects from an INTERIOR cursor, not the earliest event, when enough events exist', async () => {
    // 5 finite identities: an interior cursor (index 2 of 5 → seq 3) must be used,
    // not finiteSeqs[0]. A reader that only tolerates resuming from the true
    // interior cursor (and fails any other `after`) proves which one was used.
    const finiteAll = [1n, 2n, 3n, 4n, 5n];
    const expectedCursor = 3n; // finiteSeqs[Math.floor(5 / 2)] = finiteSeqs[2]
    const reader: ReaderClient = {
      ...fakeReader(5n, () => finiteAll),
      follow: async (_sid, after, signal, onEvent): Promise<void> => {
        if (signal.aborted) return;
        if (after !== 0n && after !== expectedCursor) {
          throw new Error(`reconnect used cursor ${after}, expected interior cursor ${expectedCursor}`);
        }
        for (const seq of finiteAll.filter((s) => s > after)) {
          onEvent({ id: seq.toString(), event: 'slipstream', data: JSON.stringify({ seq: seq.toString() }) });
        }
      },
    };
    const a = await criterion3(ctxWith(reader));
    assert.equal(a.id, 'finite-sse-agreement');
    assert.equal((a.evidence as { reconnect_after: string }).reconnect_after, expectedCursor.toString());
  });

  it('falls back to the earliest cursor when too few events exist for an interior one', async () => {
    // With only 2 finite identities there is no meaningful interior cursor;
    // finiteSeqs[0] remains correct and must still be used.
    const reader = fakeReader(2n, () => [1n, 2n]);
    const a = await criterion3(ctxWith(reader));
    assert.equal((a.evidence as { reconnect_after: string }).reconnect_after, '1');
  });
});
