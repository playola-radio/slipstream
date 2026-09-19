/**
 * The clip projection: a READER-DERIVED public projection over the immutable
 * before/after blobs of a `file.changed` event. It is NOT a log event, is never
 * appended, and is a pure function of (before bytes, after bytes,
 * projection_version) — so identical blobs always yield the identical result and
 * a dropped cache recomputes the same answer.
 *
 * This module is the pure core: no I/O, no threads, deterministic, work-capped.
 * The reader resolves each side to a {@link SideInput} (reading CAS blobs) and
 * calls {@link projectClips}. B2 adds tree-sitter function extraction HERE,
 * additively — a successful extraction is what flips a diffable file from
 * `fallback` to `ready`. Until then every diffable file is `fallback`, because
 * function-level clips are not yet available.
 *
 * Byte/line conventions (part of the published contract):
 *  - Spans reference the RAW blob bytes by ZERO-BASED HALF-OPEN byte offsets.
 *  - Lines split on `\n` (0x0a); a preceding `\r` stays in the line's bytes
 *    (CRLF is preserved). A trailing newline terminates the final line — no
 *    phantom empty last line. `line_start`/`line_end` are 1-based inclusive.
 *  - A span for line range [a,b] covers `[startOfLine(a), startOfLine(b+1))`,
 *    where `startOfLine(lastLine+1)` is the blob length; line b's terminator is
 *    included. `\n` is always a UTF-8 boundary, so spans land on UTF-8
 *    boundaries.
 *  - A `null` span means NO corresponding span on that side (created/deleted
 *    content), NEVER unreadable content. Unreadable/gone content is a non-`ready`
 *    status (or a per-side `unavailable` method) with an explicit reason.
 */

export const CLIP_PROJECTION_VERSION = 'clip.v1';

/** Fixed extraction budgets. May only be tightened by an explicit option (raising
 *  a ceiling is a product decision, out of scope). */
export const MAX_UTF8_BYTES = 1024 * 1024; // parse only UTF-8 <= 1 MiB
export const MAX_ALIGN_CELLS = 8_000_000; // before x after line-pair product cap
export const MAX_LINES_PER_SIDE = 300; // across the whole clip array, per side
export const MAX_BYTES_PER_SIDE = 64 * 1024; // across the whole clip array, per side
export const DEFAULT_CONTEXT = 20; // fallback = changed ranges +/- 20 lines

/** One side of a change resolved to bytes or an explicit non-content disposition.
 *  `absent` = the path did not exist; `unavailable` = observed but content not
 *  captured (snapshot reason); `missing` = the blob is gone (GC'd/absent from
 *  CAS); `oversize` = larger than the parse budget. `binary`/`not-utf8` is
 *  decided by this core from the bytes, not by the caller. */
export type SideInput =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'missing'; reason: string }
  | { kind: 'oversize'; size: number };

export interface Span {
  byte_start: number;
  byte_end: number;
  line_start: number;
  line_end: number;
  truncated: boolean;
}

export type ClipSideMethod = 'changed-range' | 'whole-file' | 'absent' | 'unavailable';

export interface ClipSide {
  span: Span | null;
  method: ClipSideMethod;
  reason?: string;
}

export interface Clip {
  before: ClipSide;
  after: ClipSide;
}

export type ClipStatus = 'ready' | 'fallback' | 'skipped' | 'unavailable';

export interface ClipProjection {
  change_seq: string;
  projection_version: string;
  status: ClipStatus;
  /** Present (required) for every status except `ready`. */
  fallback_reason?: string;
  clips: Clip[];
}

export interface ProjectOptions {
  changeSeq: string;
  context?: number;
  maxLinesPerSide?: number;
  maxBytesPerSide?: number;
  maxCells?: number;
  maxBytes?: number;
}

const FALLBACK_REASON = 'function-extraction-unavailable';

export function projectClips(
  before: SideInput,
  after: SideInput,
  opts: ProjectOptions,
): ClipProjection {
  const limits = {
    context: opts.context ?? DEFAULT_CONTEXT,
    maxLines: opts.maxLinesPerSide ?? MAX_LINES_PER_SIDE,
    maxBytes: opts.maxBytesPerSide ?? MAX_BYTES_PER_SIDE,
    maxCells: opts.maxCells ?? MAX_ALIGN_CELLS,
    maxUtf8Bytes: opts.maxBytes ?? MAX_UTF8_BYTES,
  };
  const a = resolveSide(after, limits.maxUtf8Bytes);
  const b = resolveSide(before, limits.maxUtf8Bytes);

  const build = (status: ClipStatus, reason: string, clips: Clip[]): ClipProjection => ({
    change_seq: opts.changeSeq,
    projection_version: CLIP_PROJECTION_VERSION,
    status,
    fallback_reason: reason,
    clips,
  });
  const skipped = (reason: string) => build('skipped', reason, []);
  const unavailable = (reason: string) => build('unavailable', reason, []);
  const fallback = (clips: Clip[]) => build('fallback', FALLBACK_REASON, clips);

  // The after side drives the primary disposition: if we cannot show the result
  // state, nothing else matters.
  if (a.kind === 'gone') return unavailable(`after-${a.origin}`);
  if (a.kind === 'skip') return skipped(a.reason);

  if (a.kind === 'absent') {
    if (b.kind === 'text') {
      return fallback(clipArray([{ before: wholeRange(), after: nullSide('absent') }], b, a, limits));
    }
    if (b.kind === 'absent') return skipped('no-content');
    if (b.kind === 'gone') return unavailable(`before-${b.origin}`);
    return skipped(b.reason); // before oversize/not-utf8 while after deleted
  }

  // after is text from here on.
  if (b.kind === 'text') {
    if (b.lines.length * a.lines.length > limits.maxCells) {
      return fallback(clipArray([wholeFileClip('diff-too-large')], b, a, limits));
    }
    const hunks = diffHunks(b.lines, a.lines, limits.context);
    if (hunks.length === 0) {
      if (equalBytes(b.bytes, a.bytes)) return skipped('no-change');
      return fallback(clipArray([wholeFileClip('no-line-change')], b, a, limits));
    }
    const plans = hunks.map((h): ClipPlan => ({
      before: { kind: 'range', range: h.before, method: 'changed-range' },
      after: { kind: 'range', range: h.after, method: 'changed-range' },
    }));
    return fallback(clipArray(plans, b, a, limits));
  }

  // after text, before not text: cannot diff, show after whole-file.
  if (b.kind === 'absent') {
    return fallback(clipArray([{ before: nullSide('absent'), after: wholeRange() }], b, a, limits));
  }
  const beforeReason = b.kind === 'gone' ? `before-${b.origin}` : `before-${b.reason}`;
  return fallback(
    clipArray([{ before: nullSide('unavailable', beforeReason), after: wholeRange() }], b, a, limits),
  );
}

// --- side resolution -------------------------------------------------------

interface TextSide {
  kind: 'text';
  bytes: Uint8Array;
  starts: number[]; // byte offset of each line start; length === line count
  len: number;
  lines: string[]; // per-line content (terminators stripped) for diffing
}
type ResolvedSide =
  | TextSide
  | { kind: 'absent' }
  | { kind: 'gone'; origin: 'missing' | 'unavailable'; reason: string }
  | { kind: 'skip'; reason: string };

function resolveSide(side: SideInput, maxUtf8Bytes: number): ResolvedSide {
  switch (side.kind) {
    case 'absent':
      return { kind: 'absent' };
    case 'oversize':
      return { kind: 'skip', reason: 'oversize' };
    case 'missing':
      return { kind: 'gone', origin: 'missing', reason: side.reason };
    case 'unavailable':
      return { kind: 'gone', origin: 'unavailable', reason: side.reason };
    case 'bytes': {
      const bytes = side.bytes;
      if (bytes.length > maxUtf8Bytes) return { kind: 'skip', reason: 'oversize' };
      const text = decodeUtf8(bytes);
      if (text === null) return { kind: 'skip', reason: 'not-utf8' };
      const starts = indexLineStarts(bytes);
      const lines = lineContents(text);
      return { kind: 'text', bytes, starts, len: bytes.length, lines };
    }
  }
}

/** Decode UTF-8 strictly; a NUL byte (binary marker) or an invalid sequence
 *  returns null. Mirrors the binary/not-text detection used elsewhere. */
function decodeUtf8(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Byte offset of each line start. A `\n` starts a new line at the next byte
 *  unless it is the final byte (then it only terminates the last line). Empty
 *  input is zero lines. */
function indexLineStarts(bytes: Uint8Array): number[] {
  if (bytes.length === 0) return [];
  const starts = [0];
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x0a) starts.push(i + 1);
  }
  return starts;
}

/** Per-line content strings with the trailing `\r?\n` removed, matching the
 *  diff granularity of change-view's splitLines. Used only for line comparison;
 *  spans are always computed from raw bytes. */
function lineContents(text: string): string[] {
  if (text === '') return [];
  const parts = text.split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );
}

// --- diff ------------------------------------------------------------------

interface LineRange { s0: number; e0: number } // half-open, 0-based line indices
interface Hunk { before: LineRange; after: LineRange }

/** Line-level LCS diff grouped into hunks of changed lines +/- `context`
 *  unchanged lines. Hunks whose context windows would touch are merged. */
function diffHunks(before: string[], after: string[], context: number): Hunk[] {
  const n = before.length;
  const m = after.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = before[i] === after[j]
        ? dp[(i + 1) * w + (j + 1)]! + 1
        : Math.max(dp[(i + 1) * w + j]!, dp[i * w + (j + 1)]!);
    }
  }
  // Raw change blocks between matched (equal) line pairs.
  const blocks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let pi = 0;
  let pj = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      if (i > pi || j > pj) blocks.push({ before: { s0: pi, e0: i }, after: { s0: pj, e0: j } });
      i++; j++; pi = i; pj = j;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) {
      i++;
    } else {
      j++;
    }
  }
  if (pi < n || pj < m) blocks.push({ before: { s0: pi, e0: n }, after: { s0: pj, e0: m } });

  // Merge blocks separated by <= 2*context equal lines, then pad with context.
  const merged: Hunk[] = [];
  for (const blk of blocks) {
    const last = merged[merged.length - 1];
    if (last && blk.before.s0 - last.before.e0 <= 2 * context) {
      last.before.e0 = blk.before.e0;
      last.after.e0 = blk.after.e0;
    } else {
      merged.push({ before: { ...blk.before }, after: { ...blk.after } });
    }
  }
  return merged.map((h) => ({
    before: { s0: Math.max(0, h.before.s0 - context), e0: Math.min(n, h.before.e0 + context) },
    after: { s0: Math.max(0, h.after.s0 - context), e0: Math.min(m, h.after.e0 + context) },
  }));
}

// --- clip assembly with per-side budget ------------------------------------

type SidePlan =
  // `range: null` on a whole-file plan means "the entire side"; the exact range
  // is resolved from the side's line count at materialization.
  | { kind: 'range'; range: LineRange | null; method: 'changed-range' | 'whole-file'; reason?: string }
  | { kind: 'null'; method: 'absent' | 'unavailable'; reason?: string };
interface ClipPlan { before: SidePlan; after: SidePlan }

function nullSide(method: 'absent' | 'unavailable', reason?: string): SidePlan {
  return reason === undefined ? { kind: 'null', method } : { kind: 'null', method, reason };
}
function wholeRange(): SidePlan {
  return { kind: 'range', range: null, method: 'whole-file' };
}
function wholeFileClip(reason: string): ClipPlan {
  return {
    before: { kind: 'range', range: null, method: 'whole-file', reason },
    after: { kind: 'range', range: null, method: 'whole-file', reason },
  };
}

interface Budget { lines: number; bytes: number }

/** Materialize clip plans into clips, enforcing the per-side line/byte caps
 *  across the whole array. Once a side's budget is exhausted the crossing span
 *  is truncated and no further clips are emitted. */
function clipArray(plans: ClipPlan[], before: ResolvedSide, after: ResolvedSide, limits: {
  maxLines: number; maxBytes: number;
}): Clip[] {
  const beforeBudget: Budget = { lines: limits.maxLines, bytes: limits.maxBytes };
  const afterBudget: Budget = { lines: limits.maxLines, bytes: limits.maxBytes };
  const clips: Clip[] = [];
  for (const plan of plans) {
    const beforeSpan = materialize(plan.before, before, beforeBudget, clips.length === 0);
    const afterSpan = materialize(plan.after, after, afterBudget, clips.length === 0);
    if (beforeSpan.dropped && afterSpan.dropped) break;
    clips.push({ before: beforeSpan.side, after: afterSpan.side });
    if (beforeSpan.exhausted || afterSpan.exhausted) break;
  }
  return clips;
}

interface Materialized { side: ClipSide; exhausted: boolean; dropped: boolean }

function materialize(plan: SidePlan, side: ResolvedSide, budget: Budget, first: boolean): Materialized {
  if (plan.kind === 'null') {
    const s: ClipSide = plan.reason === undefined
      ? { span: null, method: plan.method }
      : { span: null, method: plan.method, reason: plan.reason };
    return { side: s, exhausted: false, dropped: false };
  }
  if (side.kind !== 'text') {
    // whole-file plan against a non-text side is a bug in the caller.
    return { side: { span: null, method: 'unavailable', reason: 'internal-error' }, exhausted: false, dropped: true };
  }
  const range: LineRange = plan.range ?? { s0: 0, e0: side.starts.length };
  const clamped = clampToBudget(range, side, budget, first);
  if (clamped === null) {
    const s: ClipSide = plan.reason === undefined
      ? { span: null, method: plan.method }
      : { span: null, method: plan.method, reason: plan.reason };
    return { side: s, exhausted: true, dropped: true };
  }
  budget.lines -= clamped.line_end - clamped.line_start + 1;
  budget.bytes -= clamped.byte_end - clamped.byte_start;
  const s: ClipSide = plan.reason === undefined
    ? { span: clamped, method: plan.method }
    : { span: clamped, method: plan.method, reason: plan.reason };
  return { side: s, exhausted: clamped.truncated, dropped: false };
}

/** Trim a line range to the remaining line/byte budget, on whole-line
 *  granularity. Returns null when nothing fits (budget already spent). When this
 *  is the first clip and a single line alone exceeds the byte budget it is still
 *  emitted (bounded by the 1 MiB file cap) and marked truncated, so the client
 *  always sees something. */
function clampToBudget(range: LineRange, side: TextSide, budget: Budget, first: boolean): Span | null {
  const total = range.e0 - range.s0;
  if (total <= 0) return null;
  if (budget.lines <= 0) return null;
  let take = Math.min(total, budget.lines);
  let byteEnd = lineStartByte(side, range.s0 + take);
  const byteStart = lineStartByte(side, range.s0);
  while (take > 1 && byteEnd - byteStart > budget.bytes) {
    take--;
    byteEnd = lineStartByte(side, range.s0 + take);
  }
  const overBytes = byteEnd - byteStart > budget.bytes;
  if (overBytes && !first) return null; // one line still too big and budget is used
  const truncated = take < total || overBytes;
  return {
    byte_start: byteStart,
    byte_end: byteEnd,
    line_start: range.s0 + 1,
    line_end: range.s0 + take,
    truncated,
  };
}

function lineStartByte(side: TextSide, line0: number): number {
  return line0 < side.starts.length ? side.starts[line0]! : side.len;
}
