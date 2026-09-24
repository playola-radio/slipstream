/**
 * web-tree-sitter, given a JS string, reports node `startIndex`/`endIndex` in
 * UTF-16 code units — not UTF-8 bytes. The interface contract (STAGE-T-PREREQS
 * D10) requires whole-declaration spans as UTF-8-byte, half-open ranges, so
 * every parser index must be converted. This module owns that conversion and
 * nothing else: it never touches the WASM runtime, so it is verified by fast
 * pure unit tests whose expected byte offsets are hand-derived from the UTF-8
 * encoding rules, independent of the code here.
 */

/** Thrown when a UTF-16 index falls between the two units of a surrogate pair —
 * i.e. inside a single astral code point, where there is no UTF-8 byte boundary.
 * Parser node boundaries never land there; if one does, that is a defect we
 * surface loudly rather than silently rounding to a neighbouring byte. */
export class SurrogateBoundaryError extends Error {}

/** Maps each UTF-16 code-unit index [0..length] of a source string to the
 * cumulative UTF-8 byte offset before that index. `valid[i] === 0` marks a
 * surrogate-pair interior, which has no byte boundary. */
export interface Utf16ByteTable {
  readonly bytes: Uint32Array;
  readonly valid: Uint8Array;
  readonly length: number;
}

/** Build the conversion table in a single code-point pass. */
export function buildUtf16ToByteTable(source: string): Utf16ByteTable {
  const length = source.length; // UTF-16 code units
  const bytes = new Uint32Array(length + 1);
  const valid = new Uint8Array(length + 1).fill(1);
  let byte = 0;
  let i = 0;
  while (i < length) {
    bytes[i] = byte;
    const code = source.charCodeAt(i);
    const low = i + 1 < length ? source.charCodeAt(i + 1) : 0;
    if (code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      // Astral code point: two UTF-16 units, four UTF-8 bytes. The boundary
      // between the two units (index i+1) is inside the code point — no byte.
      valid[i + 1] = 0;
      bytes[i + 1] = byte;
      byte += 4;
      i += 2;
    } else {
      // Single UTF-16 unit (BMP scalar, or a lone surrogate). A lone surrogate
      // cannot be UTF-8-encoded; fatal UTF-8 decoding upstream rejects such
      // input before it reaches here, so we size it as a 3-byte BMP scalar.
      byte += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
      i += 1;
    }
  }
  bytes[length] = byte;
  return { bytes, valid, length };
}

/** Convert one UTF-16 code-unit index to its UTF-8 byte offset. */
export function utf16IndexToByte(table: Utf16ByteTable, index: number): number {
  if (index < 0 || index > table.length) {
    throw new RangeError(`UTF-16 index ${index} out of range [0, ${table.length}]`);
  }
  if (table.valid[index] === 0) {
    throw new SurrogateBoundaryError(`UTF-16 index ${index} falls inside a surrogate pair`);
  }
  return table.bytes[index]!;
}

export interface ByteRange {
  byteStart: number;
  byteEnd: number;
}

/** Convert a half-open UTF-16 range to a half-open UTF-8 byte range. */
export function utf16RangeToByteRange(table: Utf16ByteTable, startIndex: number, endIndex: number): ByteRange {
  return {
    byteStart: utf16IndexToByte(table, startIndex),
    byteEnd: utf16IndexToByte(table, endIndex),
  };
}
