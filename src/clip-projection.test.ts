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
  const p = projectClips(bytes('a\n'), { kind: 'oversize' }, { changeSeq: SEQ });
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

test('a single line larger than the byte budget is never emitted: skipped', () => {
  // A minified/one-line file whose sole line exceeds 64 KiB has no whole-line
  // clip that fits. It must be skipped, not emitted past the locked ceiling.
  const p = projectClips({ kind: 'absent' }, bytes('x'.repeat(70000) + '\n'), { changeSeq: SEQ });
  assert.equal(p.status, 'skipped');
  assert.equal(p.fallback_reason, 'clip-too-large');
  assert.deepEqual(p.clips, []);
});

test('budget options can only tighten locked ceilings, never raise them', () => {
  // maxBytesPerSide above the locked 64 KiB is clamped down: the 70 KB line still
  // does not fit.
  const p = projectClips(
    { kind: 'absent' },
    bytes('x'.repeat(70000) + '\n'),
    { changeSeq: SEQ, maxBytesPerSide: 1_000_000 },
  );
  assert.equal(p.status, 'skipped');
  assert.equal(p.fallback_reason, 'clip-too-large');

  // maxLinesPerSide above the locked 300 is clamped down: only 300 lines emit.
  const many = Array.from({ length: 350 }, (_, i) => `line${i}`).join('\n') + '\n';
  const q = projectClips({ kind: 'absent' }, bytes(many), { changeSeq: SEQ, maxLinesPerSide: 400 });
  assert.equal(q.status, 'fallback');
  const span = q.clips[0]!.after.span!;
  assert.equal(span.line_end, 300);
  assert.equal(span.truncated, true);
});

test('a line-ending-only change is a real diff difference, not hidden', () => {
  // Before this fix line comparison stripped terminators, so an LF->CRLF change
  // produced no hunk and was silently rendered as a whole-file "no-line-change".
  const p = projectClips(bytes('a\nb\nc\n'), bytes('a\nb\r\nc\n'), { changeSeq: SEQ, context: 0 });
  assert.equal(p.status, 'fallback');
  assert.equal(p.clips[0]!.after.method, 'changed-range');
  assert.equal(p.clips[0]!.after.span!.line_start, 2);
});

test('dropping a final newline is a real diff difference, not hidden', () => {
  const p = projectClips(bytes('a\nb\nc\n'), bytes('a\nb\nc'), { changeSeq: SEQ, context: 0 });
  assert.equal(p.status, 'fallback');
  assert.equal(p.clips[0]!.after.method, 'changed-range');
  assert.equal(p.clips[0]!.after.span!.line_start, 3);
});

test('exact budget exhaustion discloses dropped later hunks via truncated', () => {
  // Two distant one-line edits; a per-side line budget of exactly one fits the
  // first hunk perfectly. The second must not vanish silently: the emitted span
  // is marked truncated to disclose the omission.
  const before = 'a\nb\nc\nd\ne\nf\n';
  const after = 'A\nb\nc\nd\ne\nF\n';
  const p = projectClips(bytes(before), bytes(after), { changeSeq: SEQ, context: 0, maxLinesPerSide: 1 });
  assert.equal(p.status, 'fallback');
  assert.equal(p.clips.length, 1);
  assert.equal(p.clips[0]!.after.span!.truncated, true);
  assert.equal(p.clips[0]!.before.span!.truncated, true);
});

test('a hunk dropped after a null-span insertion still discloses truncation', () => {
  // The budget is spent by hunk 1, hunk 2 is an insertion (null before span),
  // hunk 3 is dropped. Disclosure must land on the last NON-null before span
  // (hunk 1), not the trailing insertion's null span — otherwise the dropped
  // edit vanishes with every span reading truncated:false.
  const before = 'a\nb\nc\nk\nz\nq\n';
  const after = 'A\nk\nI\nz\nQ\n';
  const p = projectClips(bytes(before), bytes(after), { changeSeq: SEQ, context: 0, maxLinesPerSide: 3 });
  assert.equal(p.status, 'fallback');
  assert.equal(p.clips.some((c) => c.before.span?.truncated === true), true);
});

test('before gone with an after too large to clip is unavailable, not a cacheable skip', () => {
  // A missing before forces a whole-file render of after; if after cannot be
  // clipped within budget, the disposition is availability-dependent (a restored
  // before would diff and fit), so it must be `unavailable` (never cached), not a
  // stale `skipped`/`clip-too-large`.
  const after = 'x'.repeat(70000) + '\n';
  const p = projectClips({ kind: 'missing', reason: 'blob-gone' }, bytes(after), { changeSeq: SEQ });
  assert.equal(p.status, 'unavailable');
  assert.equal(p.fallback_reason, 'before-missing');
});

test('before present-but-oversize with an unclippable after stays a deterministic skip', () => {
  // Both sides present (before merely too big to parse); nothing fits the budget.
  // Deterministic given the blobs, so it is a cacheable skip, not unavailable.
  const after = 'x'.repeat(70000) + '\n';
  const p = projectClips({ kind: 'oversize' }, bytes(after), { changeSeq: SEQ });
  assert.equal(p.status, 'skipped');
  assert.equal(p.fallback_reason, 'clip-too-large');
});

test('an empty corresponding range (insertion) does not stop later hunks', () => {
  // Insert X at the top and edit d->D at the bottom. The insertion's before side
  // is an empty range (null span); it must not be mistaken for budget exhaustion
  // and swallow the later edit.
  const before = 'a\nb\nc\nd\n';
  const after = 'X\na\nb\nc\nD\n';
  const p = projectClips(bytes(before), bytes(after), { changeSeq: SEQ, context: 0 });
  assert.equal(p.status, 'fallback');
  assert.equal(p.clips.length, 2);
  assert.equal(p.clips[0]!.before.span, null); // insertion: nothing on the before side
  assert.equal(p.clips[1]!.after.span!.line_start, 5); // the D edit survived
});
