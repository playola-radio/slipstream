import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeAll } from './log.ts';
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
          new Set(records.map((r) => r.path)),
          new Set(Array.from({ length: 50 }, (_, i) => `p${i}`)),
        );
      });
    });
  });

  describe('writeAll', () => {
    it('loops until the whole buffer is written when writes are short', async () => {
      const chunks: Buffer[] = [];
      // A handle that commits at most 3 bytes per call, exercising the loop.
      const handle = {
        write: async (buf: Buffer, offset: number, length: number) => {
          const bytesWritten = Math.min(3, length);
          chunks.push(Buffer.from(buf.subarray(offset, offset + bytesWritten)));
          return { bytesWritten, buffer: buf };
        },
      };
      await writeAll(handle as never, Buffer.from('abcdefghij'));
      assert.equal(Buffer.concat(chunks).toString(), 'abcdefghij');
      assert.ok(chunks.length >= 4); // 10 bytes at <=3 per call
    });

    it('throws rather than spin when a write makes no progress', async () => {
      const handle = { write: async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) }) };
      await assert.rejects(writeAll(handle as never, Buffer.from('x')), /no progress/);
    });
  });
});
