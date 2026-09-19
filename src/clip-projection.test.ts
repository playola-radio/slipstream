import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectClips,
  CLIP_PROJECTION_VERSION,
  type SideInput,
} from './clip-projection.ts';

const bytes = (s: string): SideInput => ({ kind: 'bytes', bytes: Buffer.from(s, 'utf8') });
const SEQ = '42';

test('new file: before absent, after whole-file clip with correct byte/line offsets', () => {
  const p = projectClips({ kind: 'absent' }, bytes('line1\nline2\nline3\n'), { changeSeq: SEQ });
  assert.equal(p.status, 'fallback');
  assert.equal(p.projection_version, CLIP_PROJECTION_VERSION);
  assert.equal(p.change_seq, SEQ);
  assert.equal(p.fallback_reason, 'function-extraction-unavailable');
  assert.equal(p.clips.length, 1);
  const clip = p.clips[0]!;
  assert.deepEqual(clip.before, { span: null, method: 'absent' });
  assert.equal(clip.after.method, 'whole-file');
  assert.deepEqual(clip.after.span, {
    byte_start: 0,
    byte_end: 18,
    line_start: 1,
    line_end: 3,
    truncated: false,
  });
});

test('deletion: after absent, before whole-file clip', () => {
  const p = projectClips(bytes('a\nb\n'), { kind: 'absent' }, { changeSeq: SEQ });
  assert.equal(p.status, 'fallback');
  assert.equal(p.clips.length, 1);
  const clip = p.clips[0]!;
  assert.equal(clip.before.method, 'whole-file');
  assert.deepEqual(clip.before.span, {
    byte_start: 0,
    byte_end: 4,
    line_start: 1,
    line_end: 2,
    truncated: false,
  });
  assert.deepEqual(clip.after, { span: null, method: 'absent' });
});

test('edit: changed-range hunk with context, paired before/after byte offsets', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\n';
  const after = 'a\nb\nc\nD\ne\nf\ng\n';
  const p = projectClips(bytes(before), bytes(after), { changeSeq: SEQ, context: 1 });
  assert.equal(p.status, 'fallback');
  assert.equal(p.clips.length, 1);
  const clip = p.clips[0]!;
  assert.equal(clip.before.method, 'changed-range');
  assert.equal(clip.after.method, 'changed-range');
  // Change is line 4 (d->D); ±1 context => lines 3..5 on both sides.
  assert.deepEqual(clip.before.span, {
    byte_start: 4, byte_end: 10, line_start: 3, line_end: 5, truncated: false,
  });
  assert.deepEqual(clip.after.span, {
    byte_start: 4, byte_end: 10, line_start: 3, line_end: 5, truncated: false,
  });
});

test('two distant edits produce two separate hunks', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
  const after = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n';
  const p = projectClips(bytes(before), bytes(after), { changeSeq: SEQ, context: 1 });
  assert.equal(p.status, 'fallback');
  assert.equal(p.clips.length, 2);
});

test('multibyte UTF-8 byte offsets count bytes not characters', () => {
  const p = projectClips({ kind: 'absent' }, bytes('é\nx\n'), { changeSeq: SEQ });
  const span = p.clips[0]!.after.span!;
  assert.equal(span.byte_start, 0);
  assert.equal(span.byte_end, 5); // é=2 bytes +\n, x +\n
  assert.equal(span.line_end, 2);
});

test('CRLF: carriage return is retained in the line bytes', () => {
  const p = projectClips({ kind: 'absent' }, bytes('a\r\nb\r\n'), { changeSeq: SEQ });
  const span = p.clips[0]!.after.span!;
  assert.equal(span.byte_end, 6);
  assert.equal(span.line_end, 2);
});

test('absent both sides: skipped no-content', () => {
  const p = projectClips({ kind: 'absent' }, { kind: 'absent' }, { changeSeq: SEQ });
  assert.equal(p.status, 'skipped');
  assert.equal(p.fallback_reason, 'no-content');
  assert.deepEqual(p.clips, []);
});

test('after oversize: skipped oversize', () => {
  const p = projectClips(bytes('a\n'), { kind: 'oversize', size: 2_000_000 }, { changeSeq: SEQ });
  assert.equal(p.status, 'skipped');
  assert.equal(p.fallback_reason, 'oversize');
  assert.deepEqual(p.clips, []);
});

test('after missing: unavailable', () => {
  const p = projectClips(bytes('a\n'), { kind: 'missing', reason: 'blob-gone' }, { changeSeq: SEQ });
  assert.equal(p.status, 'unavailable');
  assert.equal(p.fallback_reason, 'after-missing');
  assert.deepEqual(p.clips, []);
});

test('after unavailable snapshot: unavailable', () => {
  const p = projectClips(bytes('a\n'), { kind: 'unavailable', reason: 'oversize' }, { changeSeq: SEQ });
  assert.equal(p.status, 'unavailable');
  assert.equal(p.fallback_reason, 'after-unavailable');
  assert.deepEqual(p.clips, []);
});

test('after non-UTF8/binary bytes: skipped not-utf8', () => {
  const p = projectClips({ kind: 'absent' }, { kind: 'bytes', bytes: Buffer.from([0xff, 0xfe, 0x00]) }, { changeSeq: SEQ });
  assert.equal(p.status, 'skipped');
  assert.equal(p.fallback_reason, 'not-utf8');
});

test('before missing, after present: whole-file after, before unavailable side', () => {
  const p = projectClips({ kind: 'missing', reason: 'blob-gone' }, bytes('a\nb\n'), { changeSeq: SEQ });
  assert.equal(p.status, 'fallback');
  assert.equal(p.clips.length, 1);
  const clip = p.clips[0]!;
  assert.deepEqual(clip.before, { span: null, method: 'unavailable', reason: 'before-missing' });
  assert.equal(clip.after.method, 'whole-file');
});

test('diff too large: whole-file both sides, diff-too-large reason', () => {
  const p = projectClips(bytes('a\nb\n'), bytes('c\nd\n'), { changeSeq: SEQ, maxCells: 1 });
  assert.equal(p.status, 'fallback');
  assert.equal(p.clips.length, 1);
  const clip = p.clips[0]!;
  assert.equal(clip.before.method, 'whole-file');
  assert.equal(clip.before.reason, 'diff-too-large');
  assert.equal(clip.after.method, 'whole-file');
  assert.equal(clip.after.reason, 'diff-too-large');
});

test('budget: per-side line cap truncates the span and stops', () => {
  const p = projectClips(
    { kind: 'absent' },
    bytes('l1\nl2\nl3\nl4\nl5\n'),
    { changeSeq: SEQ, maxLinesPerSide: 2 },
  );
  assert.equal(p.status, 'fallback');
  const span = p.clips[0]!.after.span!;
  assert.equal(span.line_start, 1);
  assert.equal(span.line_end, 2);
  assert.equal(span.truncated, true);
});

test('identical content: skipped no-change', () => {
  const p = projectClips(bytes('a\nb\n'), bytes('a\nb\n'), { changeSeq: SEQ });
  assert.equal(p.status, 'skipped');
  assert.equal(p.fallback_reason, 'no-change');
});
