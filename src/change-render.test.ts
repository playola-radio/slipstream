import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReaderEvent } from './log-reader.ts';
import { renderChange, type BlobSource, type BlobResult } from './change-view.ts';

const CTX = { context: 3, full: false };

function ev(data: Record<string, unknown>, seq = 42n): ReaderEvent {
  return { seq, type: 'slipstream.file.changed.v1', raw: '', data };
}
// Expand a short fixture label ('aaa', 'bbb') into a valid 64-hex-char sha256 so
// it survives parseSnapshot's isValidHex check. Labels must differ in char 0.
const hex = (label: string): string => label[0]!.repeat(64);
function content(label: string, size: number) { return { kind: 'content', sha256: hex(label), size }; }

function source(map: Record<string, BlobResult>, seen?: string[]): BlobSource {
  const byHex: Record<string, BlobResult> = {};
  for (const k of Object.keys(map)) byHex[hex(k)] = map[k]!;
  return async (sha: string) => { seen?.push(sha); return byHex[sha] ?? { kind: 'missing', reason: 'not-found' }; };
}

test('renderChange: a modified line is marked against the before-content', async () => {
  const e = ev({ path: 'src/foo.ts', before: content('bbb', 10), after: content('aaa', 10) });
  const out = await renderChange(e, source({
    bbb: { kind: 'text', text: 'a\nb\nc' },
    aaa: { kind: 'text', text: 'a\nX\nc' },
  }), CTX);
  assert.deepEqual(out, ['#42 src/foo.ts', '  1 a', 'x 2 X', '  3 c']);
});

test('renderChange: a brand-new file marks every line under a "(new file)" note', async () => {
  const e = ev({ path: 'new.txt', before: { kind: 'absent' }, after: content('aaa', 6) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: 'one\ntwo' } }), CTX);
  assert.deepEqual(out, ['#42 new.txt', '  (new file)', 'x 1 one', 'x 2 two']);
});

test('renderChange: a deleted file is reported, not diffed', async () => {
  const e = ev({ path: 'gone.txt', before: content('bbb', 5), after: { kind: 'absent' } });
  const out = await renderChange(e, source({}), CTX);
  assert.deepEqual(out, ['#42 gone.txt', '  (deleted)']);
});

test('renderChange: an unavailable after-side states the reason', async () => {
  const e = ev({ path: 'big.bin', before: { kind: 'absent' }, after: { kind: 'unavailable', reason: 'oversize' } });
  const out = await renderChange(e, source({}), CTX);
  assert.deepEqual(out, ['#42 big.bin', '  (content unavailable: oversize)']);
});

test('renderChange: a binary after-side is summarized by size, not printed', async () => {
  const e = ev({ path: 'img.png', before: content('bbb', 10), after: content('aaa', 20) });
  const out = await renderChange(e, source({ aaa: { kind: 'binary' } }), CTX);
  assert.deepEqual(out, ['#42 img.png', '  (binary, 10 B → 20 B)']);
});

test('renderChange: an oversize after-side is summarized without fetching the blob', async () => {
  const seen: string[] = [];
  const e = ev({ path: 'huge.log', before: { kind: 'absent' }, after: content('aaa', 200000) });
  const out = await renderChange(e, source({}, seen), CTX);
  assert.deepEqual(out, ['#42 huge.log', '  (large file, 195.3 KB — content hidden; rerun with --full)']);
  assert.deepEqual(seen, []); // never downloaded
});

test('renderChange: --full forces an oversize file to render', async () => {
  const e = ev({ path: 'huge.log', before: { kind: 'absent' }, after: content('aaa', 200000) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: 'hello' } }), { context: 3, full: true });
  assert.deepEqual(out, ['#42 huge.log', '  (new file)', 'x 1 hello']);
});

test('renderChange: an uncomparable before-side is a single note by default', async () => {
  const e = ev({ path: 'x.ts', before: { kind: 'unavailable', reason: 'baseline-unknown' }, after: content('aaa', 6) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: 'a\nb' } }), CTX);
  assert.deepEqual(out, ['#42 x.ts', '  (before unavailable: baseline-unknown; rerun with --full)']);
});

test('renderChange: --full dumps unmarked content when the before-side is uncomparable', async () => {
  const e = ev({ path: 'x.ts', before: { kind: 'unavailable', reason: 'baseline-unknown' }, after: content('aaa', 6) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: 'a\nb' } }), { context: 3, full: true });
  assert.deepEqual(out, [
    '#42 x.ts',
    '  (before unavailable: baseline-unknown)',
    '  1 a',
    '  2 b',
  ]);
});

test('renderChange: a deletion-only change reports how many lines were removed', async () => {
  const e = ev({ path: 'x.ts', before: content('bbb', 8), after: content('aaa', 4) });
  const out = await renderChange(e, source({
    bbb: { kind: 'text', text: 'a\nb\nc\nd' },
    aaa: { kind: 'text', text: 'a\nd' },
  }), CTX);
  assert.deepEqual(out, ['#42 x.ts', '  (2 lines removed)']);
});

test('renderChange: a missing path uses a placeholder header token', async () => {
  const e = ev({ before: { kind: 'absent' }, after: content('aaa', 1) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: 'z' } }), CTX);
  assert.equal(out[0], '#42 (path unavailable)');
});

test('renderChange: a blob whose actual bytes exceed the cap is reported as oversize', async () => {
  const e = ev({ path: 'liar.txt', before: { kind: 'absent' }, after: content('aaa', 10) });
  const out = await renderChange(e, source({ aaa: { kind: 'oversize', size: 200000 } }), CTX);
  assert.deepEqual(out, ['#42 liar.txt', '  (large file, 195.3 KB — content hidden; rerun with --full)']);
});

test('renderChange: an empty after-file is reported as empty', async () => {
  const e = ev({ path: 'empty.txt', before: content('bbb', 3), after: content('aaa', 0) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: '' } }), CTX);
  assert.deepEqual(out, ['#42 empty.txt', '  (empty file)']);
});

test('renderChange: a missing after-blob is reported as unavailable with its reason', async () => {
  const e = ev({ path: 'x.ts', before: { kind: 'absent' }, after: content('aaa', 6) });
  const out = await renderChange(e, source({ aaa: { kind: 'missing', reason: 'io-error' } }), CTX);
  assert.deepEqual(out, ['#42 x.ts', '  (content unavailable: io-error)']);
});

test('renderChange: a malformed snapshot is reported, never guessed', async () => {
  const e = ev({ path: 'x.ts', before: { kind: 'absent' }, after: { kind: 'bogus' } });
  const out = await renderChange(e, source({}), CTX);
  assert.deepEqual(out, ['#42 x.ts', '  (snapshot missing or malformed)']);
});

test('renderChange: an after-snapshot with a non-hex sha256 is malformed, never fetched', async () => {
  const seen: string[] = [];
  const e = ev({ path: 'x.ts', before: { kind: 'absent' }, after: { kind: 'content', sha256: 'nothex', size: 4 } });
  const out = await renderChange(e, source({}, seen), CTX);
  assert.deepEqual(out, ['#42 x.ts', '  (snapshot missing or malformed)']);
  assert.deepEqual(seen, []);
});

test('renderChange: an after-snapshot with a negative size is malformed', async () => {
  const e = ev({ path: 'x.ts', before: { kind: 'absent' }, after: { kind: 'content', sha256: 'a'.repeat(64), size: -1 } });
  const out = await renderChange(e, source({}), CTX);
  assert.deepEqual(out, ['#42 x.ts', '  (snapshot missing or malformed)']);
});

test('renderChange: a path with control characters is neutralized in the header', async () => {
  const e = ev({ path: 'a\x07b.txt', before: { kind: 'absent' }, after: content('aaa', 1) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: 'z' } }), CTX);
  assert.equal(out[0], '#42 a�b.txt');
});
