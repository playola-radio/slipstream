import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withLog } from './test/helpers.ts';

const gap = (path: string, observed_at_ms: number) =>
  ({ type: 'capture.gap', path, reason: 'coalesced', observed_at_ms }) as const;

describe('log', () => {
  describe('append', () => {
    it('writes one JSON object per line', async () => {
      await withLog(async ({ log, read }) => {
        await log.append(gap('a', 1));
        await log.append(gap('b', 2));
        const records = await read();
        assert.equal(records.length, 2);
        assert.equal(records[0]?.path, 'a');
        assert.equal(records[1]?.path, 'b');
      });
    });

    it('assigns contiguous sequence numbers starting at 1', async () => {
      await withLog(async ({ log, read }) => {
        await log.append(gap('a', 1));
        await log.append(gap('b', 2));
        const records = await read();
        assert.equal(records[0]?.seq, 1);
        assert.equal(records[1]?.seq, 2);
      });
    });

    it('stamps a commit time on every record', async () => {
      await withLog(async ({ log, read }) => {
        const before = Date.now();
        await log.append(gap('a', 1));
        const [rec] = await read();
        assert.ok(rec && rec.committed_at_ms >= before && rec.committed_at_ms <= Date.now());
      });
    });

    it('serializes concurrent appends without interleaving or lost lines', async () => {
      await withLog(async ({ log, read }) => {
        await Promise.all(Array.from({ length: 50 }, (_, i) => log.append(gap(`p${i}`, i))));
        const records = await read();
        assert.equal(records.length, 50);
        assert.deepEqual(
          records.map((r) => r.seq),
          Array.from({ length: 50 }, (_, i) => i + 1),
        );
      });
    });
  });
});
