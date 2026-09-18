import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLines, markChanges, renderMarkedLines } from './change-view.ts';

test('splitLines: empty text is zero lines', () => {
  assert.deepEqual(splitLines(''), []);
});

test('splitLines: trailing newline is a terminator, not an extra empty line', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
});

test('splitLines: CRLF trailing newline is a terminator, not displayed content', () => {
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
});

test('splitLines: interior blank line is preserved', () => {
  assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b']);
});

test('splitLines: no trailing newline keeps the last line', () => {
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
});

test('markChanges: identical content marks nothing changed', () => {
  assert.deepEqual(markChanges(['a', 'b', 'c'], ['a', 'b', 'c']), [false, false, false]);
});

test('markChanges: a modified middle line is the only change', () => {
  assert.deepEqual(markChanges(['a', 'b', 'c'], ['a', 'X', 'c']), [false, true, false]);
});

test('markChanges: a brand-new file marks every after-line changed', () => {
  assert.deepEqual(markChanges([], ['a', 'b']), [true, true]);
});

test('markChanges: an appended line is the only change', () => {
  assert.deepEqual(markChanges(['a', 'b'], ['a', 'b', 'c']), [false, false, true]);
});

test('markChanges: an inserted run is marked, surviving lines are not', () => {
  assert.deepEqual(
    markChanges(['a', 'b'], ['a', 'X', 'Y', 'b']),
    [false, true, true, false],
  );
});

test('renderMarkedLines: numbers every after-line with x/space markers', () => {
  const out = renderMarkedLines(['a', 'b', 'c'], ['a', 'X', 'c'], 3);
  assert.deepEqual(out, [
    '  1 a',
    'x 2 X',
    '  3 c',
  ]);
});

test('renderMarkedLines: a new file marks all lines and numbers them', () => {
  const out = renderMarkedLines([], ['one', 'two'], 3);
  assert.deepEqual(out, [
    'x 1 one',
    'x 2 two',
  ]);
});

test('renderMarkedLines: context hides lines far from any change', () => {
  const before = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
  const after = before.slice();
  after[4] = 'CHANGED'; // line 5
  const out = renderMarkedLines(before, after, 2);
  // context 2 => show lines 3..7 only (width 2 => unchanged lines get 3 leading spaces)
  assert.deepEqual(out, [
    '   3 line3',
    '   4 line4',
    'x  5 CHANGED',
    '   6 line6',
    '   7 line7',
  ]);
});

test('renderMarkedLines: a separator marks the gap between two distant hunks', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  const after = before.slice();
  after[2] = 'A'; // line 3
  after[15] = 'B'; // line 16
  const out = renderMarkedLines(before, after, 1);
  assert.deepEqual(out, [
    '   2 line2',
    'x  3 A',
    '   4 line4',
    '⋯',
    '  15 line15',
    'x 16 B',
    '  17 line17',
  ]);
});

test('renderMarkedLines: adjacent hunks merge without a separator', () => {
  const before = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
  const after = before.slice();
  after[3] = 'A'; // line 4
  after[6] = 'B'; // line 7 — windows (with context 2) touch/overlap
  const out = renderMarkedLines(before, after, 2);
  assert.deepEqual(out, [
    '   2 line2',
    '   3 line3',
    'x  4 A',
    '   5 line5',
    '   6 line6',
    'x  7 B',
    '   8 line8',
    '   9 line9',
  ]);
});

test('renderMarkedLines: identical content renders nothing', () => {
  assert.deepEqual(renderMarkedLines(['a'], ['a'], 3), []);
});

test('renderMarkedLines: control characters in content are neutralized', () => {
  const out = renderMarkedLines([], ['\x1b[31mred\x07'], 3);
  assert.deepEqual(out, ['x 1 �[31mred�']);
});
