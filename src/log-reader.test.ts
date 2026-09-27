// src/log-reader.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCursor, parseLine, openLogCursor, LogCorruptError, LogReadLimitError, LogReadAbortedError } from './log-reader.ts';

const line = (seq: number, type = 'slipstream.file.changed.v1', extra = {}) =>
  JSON.stringify({ specversion: '1.0', id: String(seq), source: 'urn:slipstream:session:x',
    type, datacontenttype: 'application/json', seq: String(seq),
    time: '2026-01-01T00:00:00.000Z', data: { session_id: 'x', ...extra } }) + '\n';

async function logWith(...lines: string[]): Promise<string> {
  const p = join(await mkdtemp(join(tmpdir(), 'slip-log-')), 'events.jsonl');
  await writeFile(p, lines.join(''), 'utf8');
  return p;
}

describe('log-reader', () => {
  describe('parseCursor', () => {
    it('treats missing as 0n, parses decimals, rejects junk', () => {
      assert.equal(parseCursor(undefined), 0n);
      assert.equal(parseCursor('0'), 0n);
      assert.equal(parseCursor('42'), 42n);
      assert.equal(parseCursor('9007199254740993'), 9007199254740993n);
      assert.equal(parseCursor('-1'), null);
      assert.equal(parseCursor('01'), null);
      assert.equal(parseCursor('x'), null);
    });
  });

  describe('parseLine', () => {
    it('accepts an unknown event type but throws on invalid json', () => {
      const ev = parseLine(line(5, 'some.future.type.v9').trimEnd());
      assert.equal(ev.seq, 5n);
      assert.equal(ev.type, 'some.future.type.v9');
      assert.throws(() => parseLine('{not json'), LogCorruptError);
    });
  });

  describe('openLogCursor', () => {
    it('emits only (after, boundary] and never an unterminated trailing line', async () => {
      const p = await logWith(line(1), line(2), line(3));
      await appendFile(p, '{"seq":"4"'); // torn tail, no newline
      const cur = await openLogCursor(p, 1n);
      const first = await cur.readThrough(2n);
      assert.deepEqual(first.map((e) => e.seq), [2n]);
      const second = await cur.readThrough(3n);
      assert.deepEqual(second.map((e) => e.seq), [3n]); // 4 is torn -> never emitted
      await cur.close();
    });

    it('does not emit lines beyond the boundary even if present on disk', async () => {
      const p = await logWith(line(1), line(2), line(3));
      const cur = await openLogCursor(p, 0n);
      assert.deepEqual((await cur.readThrough(1n)).map((e) => e.seq), [1n]);
      assert.deepEqual((await cur.readThrough(3n)).map((e) => e.seq), [2n, 3n]);
      await cur.close();
    });

    it('enforces an exact per-call record and UTF-8 byte budget before completing an oversized line', async () => {
      const first = line(1);
      const p = await logWith(first, line(2, undefined, { pad: 'x'.repeat(200_000) }));
      const cur = await openLogCursor(p, 0n);
      try {
        assert.deepEqual((await cur.readThrough(2n, { maxRecords: 1 })).map((e) => e.seq), [1n]);
        await assert.rejects(cur.readThrough(2n, { maxBytes: 1024 }), LogReadLimitError);
      } finally { await cur.close(); }
    });

    it('stops a bounded read when its signal is aborted', async () => {
      const p = await logWith(line(1));
      const cur = await openLogCursor(p, 0n);
      const controller = new AbortController();
      controller.abort();
      try { await assert.rejects(cur.readThrough(1n, { signal: controller.signal }), LogReadAbortedError); }
      finally { await cur.close(); }
    });

    it('round-trips a multibyte char whose bytes straddle a 64KB chunk boundary', async () => {
      const emoji = '\u{1F600}'; // 4-byte UTF-8
      const line1 = line(1);
      // Find where the emoji lands in the JSON text when there is no padding,
      // so we can compute exactly how much ASCII padding shifts its first
      // byte to file offset 65535 (the last byte of the first 64KB chunk).
      const zeroPadLine = line(2, undefined, { pad: emoji });
      const emojiIndex = zeroPadLine.indexOf(emoji);
      const fixedPrefixBytes = Buffer.byteLength(zeroPadLine.slice(0, emojiIndex), 'utf8');
      const line1Bytes = Buffer.byteLength(line1, 'utf8');
      const padLength = 65535 - line1Bytes - fixedPrefixBytes;
      assert.ok(padLength >= 0, 'expected non-negative pad length');
      const padStr = 'a'.repeat(padLength);
      const expectedPad = padStr + emoji;
      const line2 = line(2, undefined, { pad: expectedPad });
      const line3 = line(3);
      const p = await logWith(line1, line2, line3);

      const straddleByte = line1Bytes + fixedPrefixBytes + padLength;
      assert.equal(straddleByte, 65535, 'emoji must start at the last byte of the first 64KB chunk');

      const cur = await openLogCursor(p, 0n);
      const events = await cur.readThrough(3n);
      await cur.close();

      const ev2 = events.find((e) => e.seq === 2n);
      assert.ok(ev2, 'expected seq 2 to be emitted');
      assert.equal(ev2!.data.pad, expectedPad);
      assert.ok(!ev2!.raw.includes('�'), 'raw line must not contain a replacement character');
    });

    it('throws LogCorruptError on a genuine blank terminated line between valid records', async () => {
      const p = await logWith(line(1), '\n', line(2));
      const cur = await openLogCursor(p, 0n);
      await assert.rejects(() => cur.readThrough(2n), LogCorruptError);
      await cur.close();
    });

    it('throws on a duplicate seq (1,1,2)', async () => {
      const p = await logWith(line(1), line(1), line(2));
      const cur = await openLogCursor(p, 0n);
      await assert.rejects(() => cur.readThrough(2n), LogCorruptError);
      await cur.close();
    });

    it('throws on a gap in seq (1,3)', async () => {
      const p = await logWith(line(1), line(3));
      const cur = await openLogCursor(p, 0n);
      await assert.rejects(() => cur.readThrough(3n), LogCorruptError);
      await cur.close();
    });

    it('throws on a reordered seq (1,3,2)', async () => {
      const p = await logWith(line(1), line(3), line(2));
      const cur = await openLogCursor(p, 0n);
      await assert.rejects(() => cur.readThrough(3n), LogCorruptError);
      await cur.close();
    });

    it('replays the correct contiguous suffix when after lands mid-log', async () => {
      const p = await logWith(line(1), line(2), line(3));
      const cur = await openLogCursor(p, 1n);
      assert.deepEqual((await cur.readThrough(3n)).map((e) => e.seq), [2n, 3n]);
      await cur.close();
    });

    it('returns the boundary record exactly once when stopping at it then resuming', async () => {
      const p = await logWith(line(1), line(2), line(3));
      const cur = await openLogCursor(p, 0n);
      assert.deepEqual((await cur.readThrough(2n)).map((e) => e.seq), [1n, 2n]);
      assert.deepEqual((await cur.readThrough(3n)).map((e) => e.seq), [3n]); // no false corruption
      await cur.close();
    });

    it('throws LogCorruptError on invalid UTF-8 and does not mis-parse the next record', async () => {
      const p = join(await mkdtemp(join(tmpdir(), 'slip-utf8-')), 'events.jsonl');
      const corrupt = Buffer.concat([
        Buffer.from('{"seq":"1","type":"t","data":{"path":"a'),
        Buffer.from([0xff]),                       // raw invalid UTF-8 byte
        Buffer.from('b"}}\n'),
        Buffer.from('{"seq":"2","type":"t","data":{}}\n'),
      ]);
      await writeFile(p, corrupt);
      const cur = await openLogCursor(p, 0n);
      await assert.rejects(() => cur.readThrough(2n), LogCorruptError);
      await cur.close();
    });
  });
});

it('bounds batches across a large replay, H, and the follow seam', async () => {
  const count = 1600;
  const p = await logWith(...Array.from({ length: count }, (_, i) => line(i + 1)));
  const cur = await openLogCursor(p, 0n);
  const seen: bigint[] = [];
  let peak = 0;
  try {
    for (;;) {
      const batch = await cur.readThrough(BigInt(count - 1));
      peak = Math.max(peak, batch.length);
      assert.ok(batch.length <= 256, `buffered ${batch.length} records`);
      if (!batch.length) break;
      seen.push(...batch.map(e => e.seq));
    }
    assert.deepEqual(seen, Array.from({ length: count - 1 }, (_, i) => BigInt(i + 1)));
    assert.ok(peak > 0);
    assert.deepEqual((await cur.readThrough(BigInt(count))).map(e => e.seq), [BigInt(count)]);
    await appendFile(p, line(count + 1).trimEnd());
    assert.deepEqual(await cur.readThrough(BigInt(count + 1)), []);
    await appendFile(p, '\n');
    assert.deepEqual((await cur.readThrough(BigInt(count + 1))).map(e => e.seq), [BigInt(count + 1)]);
  } finally { await cur.close(); }
});

it('does not parse a complete uncommitted record after H', async () => {
  const p = await logWith(line(1), 'not committed JSON\n');
  const cur = await openLogCursor(p, 0n);
  try { assert.deepEqual((await cur.readThrough(1n)).map(e => e.seq), [1n]); }
  finally { await cur.close(); }
});
