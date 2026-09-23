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
});
