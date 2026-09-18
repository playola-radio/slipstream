import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { renderEvent, replayFromDisk, sseDataLine, runTui } from './tui.ts';
import { parseLine } from './log-reader.ts';
import { blobPath } from './store-reader.ts';

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
    it('sanitizes control chars in the event type', () => {
      const ev = parseLine(JSON.stringify({ seq: '9', type: 'evil\x1b[2Jtype', data: {} }));
      const line = renderEvent(ev);
      assert.ok(!line.includes('\x1b'), 'escape must not reach the terminal');
      assert.match(line, /^9 · evil�\[2Jtype/);
    });
    it('sanitizes control chars in an unavailable snapshot reason', () => {
      const ev = parseLine(JSON.stringify({
        seq: '10', type: 'slipstream.file.changed.v1',
        data: { path: 'f', after: { kind: 'unavailable', reason: 'bad\x1breason' } },
      }));
      assert.ok(!renderEvent(ev).includes('\x1b'));
    });
  });

  describe('sseDataLine', () => {
    it('extracts a data: line whose payload contains a literal U+2028', () => {
      const json = JSON.stringify({
        seq: '3', type: 'slipstream.file.changed.v1', data: { path: 'a b', after: { kind: 'absent' } },
      });
      const frame = `id: 3\nevent: slipstream\ndata: ${json}`;
      const data = sseDataLine(frame);
      assert.equal(data, json); // not truncated/dropped at the U+2028
      assert.match(renderEvent(parseLine(data!)), /^3 · /);
    });
  });

  describe('replayFromDisk', () => {
    it('emits rendered lines for the whole durable log', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
      await mkdir(join(dir, 'sessions', UUID), { recursive: true });
      const mk = (seq: number) => JSON.stringify({
        seq: String(seq),
        type: 'slipstream.file.changed.v1',
        data: { path: `f${seq}`, after: { kind: 'absent' } },
      }) + '\n';
      await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), mk(1) + mk(2), 'utf8');
      const lines: string[] = [];
      await replayFromDisk(dir, UUID, l => lines.push(l));
      assert.equal(lines.length, 2);
      assert.match(lines[0]!, /^1 · /);
    });
  });
});

it('does not send a token from a non-loopback descriptor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
  await mkdir(join(dir, 'runtime'));
  await writeFile(join(dir, 'runtime', 'bad.json'),
    JSON.stringify({ url: 'http://example.com', token: 'secret' }), { mode: 0o600 });
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const lines: string[] = [];
  try {
    await runTui(['--store', dir, '--session', UUID], l => lines.push(l));
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.match(lines.join(''), /no .*reader/);
  } finally { fetchMock.mock.restore(); }
});

it('reports a stale reader connection without throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
  await mkdir(join(dir, 'runtime'));
  await writeFile(join(dir, 'runtime', 'a.json'),
    JSON.stringify({ url: 'http://localhost:1234', token: 'secret' }), { mode: 0o600 });
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('connection refused'); });
  const lines: string[] = [];
  try {
    await runTui(['--store', dir, '--session', UUID], l => lines.push(l));
    assert.match(lines.join(''), /unavailable.*--disk/);
  } finally { fetchMock.mock.restore(); }
});

it('changes view renders a marked content block from the CAS on disk', async () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  const writeBlob = async (hex: string, text: string) => {
    const p = blobPath(dir, hex);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
  };
  await writeBlob(A, 'a\nb\nc');
  await writeBlob(B, 'a\nX\nc');
  await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), JSON.stringify({
    seq: '1', type: 'slipstream.file.changed.v1',
    data: { path: 'f', before: { kind: 'content', sha256: A, size: 5 }, after: { kind: 'content', sha256: B, size: 5 } },
  }) + '\n');
  const lines: string[] = [];
  await replayFromDisk(dir, UUID, l => lines.push(l), { context: 3, full: false });
  assert.deepEqual(lines, ['#1 f', '  1 a', 'x 2 X', '  3 c', '']);
});

it('changes view renders a file with more lines than the spread-arg limit', async () => {
  // A file whose rendered block exceeds the max function-argument count must not
  // crash: replay pushes lines one at a time rather than spreading the array.
  const A = 'a'.repeat(64);
  const N = 130000;
  const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  const p = blobPath(dir, A);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, Array.from({ length: N }, () => 'x').join('\n'));
  await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), JSON.stringify({
    seq: '1', type: 'slipstream.file.changed.v1',
    data: { path: 'big.txt', before: { kind: 'absent' }, after: { kind: 'content', sha256: A, size: N * 2 } },
  }) + '\n');
  const lines: string[] = [];
  await replayFromDisk(dir, UUID, l => lines.push(l), { context: 3, full: true });
  assert.equal(lines.length, N + 3); // header + '(new file)' note + N marked lines + trailing ''
  assert.equal(lines[0], '#1 big.txt');
  assert.equal(lines[1], '  (new file)');
  assert.match(lines[2]!, /^x +1 x$/);
});

it('disk replay consumes every bounded batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), Array.from({ length: 700 }, (_, i) =>
    JSON.stringify({ seq: String(i + 1), type: 'test', data: {} }) + '\n').join(''));
  const lines: string[] = [];
  await replayFromDisk(dir, UUID, l => lines.push(l));
  assert.equal(lines.length, 700);
  assert.match(lines[699]!, /^700 · /);
});

it('runTui reports invalid --context values without rendering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), JSON.stringify({
    seq: '1', type: 'slipstream.file.changed.v1',
    data: { path: 'f', after: { kind: 'absent' } },
  }) + '\n');
  const lines: string[] = [];
  await runTui(['--store', dir, '--session', UUID, '--disk', '--changes', '--context', 'abc'], l => lines.push(l));
  assert.deepEqual(lines, ['usage: --context must be a non-negative integer']);
});

it('runTui reports a trailing --context without rendering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), JSON.stringify({
    seq: '1', type: 'slipstream.file.changed.v1',
    data: { path: 'f', after: { kind: 'absent' } },
  }) + '\n');
  const lines: string[] = [];
  await runTui(['--store', dir, '--session', UUID, '--disk', '--changes', '--context'], l => lines.push(l));
  assert.deepEqual(lines, ['usage: --context must be a non-negative integer']);
});

it('runTui uses a valid --context value in changes view', async () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  const writeBlob = async (hex: string, text: string) => {
    const p = blobPath(dir, hex);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
  };
  await writeBlob(A, 'a\nb\nc');
  await writeBlob(B, 'a\nX\nc');
  await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), JSON.stringify({
    seq: '1', type: 'slipstream.file.changed.v1',
    data: { path: 'f', before: { kind: 'content', sha256: A, size: 5 }, after: { kind: 'content', sha256: B, size: 5 } },
  }) + '\n');
  const lines: string[] = [];
  await runTui(['--store', dir, '--session', UUID, '--disk', '--changes', '--context', '0'], l => lines.push(l));
  assert.deepEqual(lines, ['#1 f', 'x 2 X', '']);
});
