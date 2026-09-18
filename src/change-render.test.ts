import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReaderEvent } from './log-reader.ts';
import { renderChange, type BlobSource, type BlobResult } from './change-view.ts';

const CTX = { context: 3, full: false };

function ev(data: Record<string, unknown>, seq = 42n): ReaderEvent {
  return { seq, type: 'slipstream.file.changed.v1', raw: '', data };
}
function content(sha: string, size: number) { return { kind: 'content', sha256: sha, size }; }

function source(map: Record<string, BlobResult>, seen?: string[]): BlobSource {
  return async (sha: string) => { seen?.push(sha); return map[sha] ?? { kind: 'missing', reason: 'not-found' }; };
}

test('renderChange: a modified line is marked against the before-content', async () => {
  const e = ev({ path: 'src/foo.ts', before: content('bbb', 10), after: content('aaa', 10) });
  const out = await renderChange(e, source({
    bbb: { kind: 'text', text: 'a\nb\nc' },
    aaa: { kind: 'text', text: 'a\nX\nc' },
  }), CTX);
  assert.deepEqual(out, ['#42 src/foo.ts', '  1 a', 'x 2 X', '  3 c']);
});

test('renderChange: a brand-new file marks every line', async () => {
  const e = ev({ path: 'new.txt', before: { kind: 'absent' }, after: content('aaa', 6) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: 'one\ntwo' } }), CTX);
  assert.deepEqual(out, ['#42 new.txt', 'x 1 one', 'x 2 two']);
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
  const out = await renderChange(e, source({ aaa: { kind: 'binary' }, bbb: { kind: 'binary' } }), CTX);
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
  assert.deepEqual(out, ['#42 huge.log', 'x 1 hello']);
});

test('renderChange: an unavailable before-side shows content but marks nothing', async () => {
  const e = ev({ path: 'x.ts', before: { kind: 'unavailable', reason: 'baseline-unknown' }, after: content('aaa', 6) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: 'a\nb' } }), CTX);
  assert.deepEqual(out, [
    '#42 x.ts',
    '  (before unavailable: baseline-unknown; changed lines not marked)',
    '  1 a',
    '  2 b',
  ]);
});

test('renderChange: an empty after-file is reported as empty', async () => {
  const e = ev({ path: 'empty.txt', before: content('bbb', 3), after: content('aaa', 0) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: '' }, bbb: { kind: 'text', text: 'x' } }), CTX);
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

test('renderChange: a path with control characters is neutralized in the header', async () => {
  const e = ev({ path: 'a\x07b.txt', before: { kind: 'absent' }, after: content('aaa', 1) });
  const out = await renderChange(e, source({ aaa: { kind: 'text', text: 'z' } }), CTX);
  assert.equal(out[0], '#42 a�b.txt');
});
