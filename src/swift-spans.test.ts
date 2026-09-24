import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUtf16ToByteTable, utf16IndexToByte, utf16RangeToByteRange, SurrogateBoundaryError } from './swift-spans.ts';

// Expected byte offsets below are hand-derived from the UTF-8 encoding rules,
// NOT produced by the converter under test — so a bug in the converter cannot
// make these tests agree with it (see Codex review concern #3).

test('ascii: one UTF-16 unit == one byte', () => {
  const t = buildUtf16ToByteTable('func');
  assert.equal(utf16IndexToByte(t, 0), 0);
  assert.equal(utf16IndexToByte(t, 4), 4);
});

test('astral emoji: surrogate pair spans 4 UTF-8 bytes; interior index is rejected', () => {
  // '😀' = U+1F600 = UTF-16 [0xD83D,0xDE00] (2 units), UTF-8 F0 9F 98 80 (4 bytes)
  const src = '😀func';
  const t = buildUtf16ToByteTable(src);
  assert.equal(utf16IndexToByte(t, 0), 0); // start of emoji
  assert.equal(utf16IndexToByte(t, 2), 4); // 'f' — after the 4 emoji bytes
  assert.equal(utf16IndexToByte(t, 6), 8); // end of 'func'
  // index 1 is the low surrogate — inside the code point, no byte boundary
  assert.throws(() => utf16IndexToByte(t, 1), SurrogateBoundaryError);
});

test('combining mark: base + U+0301 is two units, three bytes', () => {
  // 'e'(1 byte) + combining acute U+0301 (UTF-8 CC 81, 2 bytes)
  const src = 'é';
  const t = buildUtf16ToByteTable(src);
  assert.equal(utf16IndexToByte(t, 0), 0);
  assert.equal(utf16IndexToByte(t, 1), 1);
  assert.equal(utf16IndexToByte(t, 2), 3);
});

test('CJK: one BMP unit is three UTF-8 bytes', () => {
  // '中' U+4E2D = UTF-8 E4 B8 AD (3 bytes)
  const t = buildUtf16ToByteTable('中x');
  assert.equal(utf16IndexToByte(t, 1), 3);
  assert.equal(utf16IndexToByte(t, 2), 4);
});

test('CRLF: each newline unit is one byte', () => {
  const t = buildUtf16ToByteTable('a\r\nb');
  assert.equal(utf16IndexToByte(t, 1), 1); // after 'a'
  assert.equal(utf16IndexToByte(t, 2), 2); // after '\r'
  assert.equal(utf16IndexToByte(t, 3), 3); // after '\n'
  assert.equal(utf16IndexToByte(t, 4), 4);
});

test('leading BOM: U+FEFF is one unit, three bytes', () => {
  // '﻿' = UTF-8 EF BB BF (3 bytes)
  const t = buildUtf16ToByteTable('﻿func');
  assert.equal(utf16IndexToByte(t, 0), 0);
  assert.equal(utf16IndexToByte(t, 1), 3); // 'f' after the BOM
  assert.equal(utf16IndexToByte(t, 5), 7);
});

test('range conversion returns a half-open byte range', () => {
  const src = '😀func';
  const t = buildUtf16ToByteTable(src);
  assert.deepEqual(utf16RangeToByteRange(t, 2, 6), { byteStart: 4, byteEnd: 8 });
});

test('out-of-range indices throw', () => {
  const t = buildUtf16ToByteTable('ab');
  assert.throws(() => utf16IndexToByte(t, -1), RangeError);
  assert.throws(() => utf16IndexToByte(t, 3), RangeError);
});

test('table byte length equals the UTF-8 byte length of the source', () => {
  for (const src of ['', 'func', '😀', 'é', '中', '﻿x', 'a\r\nb']) {
    const t = buildUtf16ToByteTable(src);
    assert.equal(utf16IndexToByte(t, src.length), Buffer.byteLength(src, 'utf8'));
  }
});
