import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderEvent, replayFromDisk } from './tui.ts';
import { parseLine } from './log-reader.ts';

const UUID = '55555555-5555-4555-8555-555555555555';

describe('tui', () => {
  describe('renderEvent', () => {
    it('renders a content change and sanitizes control chars in the path', () => {
      const ev = parseLine(JSON.stringify({
        seq: '7',
        type: 'slipstream.file.changed.v1',
        data: {
          path: 'a\x1bb',
          after: { kind: 'content', sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567' },
        },
      }));
      const line = renderEvent(ev);
      assert.match(line, /^7 · slipstream\.file\.changed\.v1 · a�b · abcdef0/);
    });
    it('renders an unknown type without throwing', () => {
      const ev = parseLine(JSON.stringify({ seq: '8', type: 'future.v9', data: {} }));
      assert.match(renderEvent(ev), /^8 · future\.v9 · -/);
    });
  });

  describe('replayFromDisk', () => {
    it('returns rendered lines for the whole durable log', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
      await mkdir(join(dir, 'sessions', UUID), { recursive: true });
      const mk = (seq: number) => JSON.stringify({
        seq: String(seq),
        type: 'slipstream.file.changed.v1',
        data: { path: `f${seq}`, after: { kind: 'absent' } },
      }) + '\n';
      await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), mk(1) + mk(2), 'utf8');
      const lines = await replayFromDisk(dir, UUID);
      assert.equal(lines.length, 2);
      assert.match(lines[0]!, /^1 · /);
    });
  });
});
