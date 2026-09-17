// src/log-reader.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCursor, parseLine, openLogCursor, LogCorruptError } from './log-reader.ts';

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
  });
});
