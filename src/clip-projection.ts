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
  | { kind: 'oversize' };

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
  // Options may only TIGHTEN a locked ceiling, never raise it: clamp each to its
  // constant. Raising a budget is a product decision, out of scope (see D4).
  const limits = {
    context: opts.context ?? DEFAULT_CONTEXT,
    maxLines: Math.min(opts.maxLinesPerSide ?? MAX_LINES_PER_SIDE, MAX_LINES_PER_SIDE),
    maxBytes: Math.min(opts.maxBytesPerSide ?? MAX_BYTES_PER_SIDE, MAX_BYTES_PER_SIDE),
    maxCells: Math.min(opts.maxCells ?? MAX_ALIGN_CELLS, MAX_ALIGN_CELLS),
    maxUtf8Bytes: Math.min(opts.maxBytes ?? MAX_UTF8_BYTES, MAX_UTF8_BYTES),
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
  // Materialize plans within budget. If not even one bounded clip fits (e.g. a
  // single line wider than the byte ceiling), skip rather than invent or exceed.
  const asFallback = (plans: ClipPlan[]): ClipProjection => {
    const clips = clipArray(plans, b, a, limits);
    return clips.length > 0 ? fallback(clips) : skipped('clip-too-large');
  };

  // The after side drives the primary disposition: if we cannot show the result
  // state, nothing else matters.
  if (a.kind === 'gone') return unavailable(`after-${a.origin}`);
  if (a.kind === 'skip') return skipped(a.reason);

  if (a.kind === 'absent') {
    if (b.kind === 'text') {
      return asFallback([{ before: wholeRange(), after: nullSide('absent') }]);
    }
    if (b.kind === 'absent') return skipped('no-content');
    if (b.kind === 'gone') return unavailable(`before-${b.origin}`);
    return skipped(b.reason); // before oversize/not-utf8 while after deleted
  }

  // after is text from here on.
  if (b.kind === 'text') {
    if (b.lines.length * a.lines.length > limits.maxCells) {
      return asFallback([wholeFileClip('diff-too-large')]);
    }
    const hunks = diffHunks(b.lines, a.lines, limits.context);
    if (hunks.length === 0) {
      if (equalBytes(b.bytes, a.bytes)) return skipped('no-change');
      return asFallback([wholeFileClip('no-line-change')]);
    }
    const plans = hunks.map((h): ClipPlan => ({
      before: { kind: 'range', range: h.before, method: 'changed-range' },
      after: { kind: 'range', range: h.after, method: 'changed-range' },
    }));
    return asFallback(plans);
  }

  // after text, before not text: cannot diff, show after whole-file.
  if (b.kind === 'absent') {
    return asFallback([{ before: nullSide('absent'), after: wholeRange() }]);
  }
  const beforeReason = b.kind === 'gone' ? `before-${b.origin}` : `before-${b.reason}`;
  const clips = clipArray(
    [{ before: nullSide('unavailable', beforeReason), after: wholeRange() }], b, a, limits,
  );
  if (clips.length > 0) return fallback(clips);
  // Nothing of the after side fits the budget. When the before side is genuinely
  // gone (GC'd/uncaptured), this outcome is availability-dependent — a restored
  // before blob would diff and likely fit — so surface it as `unavailable` (never
  // cached) rather than a stale `skipped`. A present-but-unparseable before
  // (oversize/binary) is deterministic, so it stays a cacheable skip.
  return b.kind === 'gone' ? unavailable(beforeReason) : skipped('clip-too-large');
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
  | { kind: 'gone'; origin: 'missing' | 'unavailable' }
  | { kind: 'skip'; reason: string };

function resolveSide(side: SideInput, maxUtf8Bytes: number): ResolvedSide {
  switch (side.kind) {
    case 'absent':
      return { kind: 'absent' };
    case 'oversize':
      return { kind: 'skip', reason: 'oversize' };
    case 'missing':
      return { kind: 'gone', origin: 'missing' };
    case 'unavailable':
      return { kind: 'gone', origin: 'unavailable' };
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
 *  returns null. `ignoreBOM` keeps a leading BOM in the text so a BOM-only change
 *  is a real diff difference, matching the raw-byte spans. Mirrors the
 *  binary/not-text detection used elsewhere. */
function decodeUtf8(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
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

/** Per-line content strings that PRESERVE terminators (a trailing `\r` and the
 *  `\n`) and final-newline presence, so a line-ending or trailing-newline change
 *  is a real diff difference rather than a silently hidden one. Used only for
 *  line comparison; spans are always computed from raw bytes. The result length
 *  matches {@link indexLineStarts}. */
function lineContents(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const trailingNewline = parts[parts.length - 1] === '';
  if (trailingNewline) parts.pop();
  return parts.map((p, i) => (i < parts.length - 1 || trailingNewline ? p + '\n' : p));
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

/** Per-side materialization outcome. `ok` = span fit in full (or the side has no
 *  span); `empty` = the corresponding range is zero-length (an insertion/deletion
 *  side — a null span, NOT budget exhaustion); `partial` = the span was clipped
 *  short by the budget; `dropped` = nothing more fits and this clip cannot be
 *  emitted. */
type SideOutcome = 'ok' | 'empty' | 'partial' | 'dropped';
interface Materialized { side: ClipSide; outcome: SideOutcome }

/** Materialize clip plans into clips, enforcing the per-side line/byte caps
 *  across the whole array. When a side's budget clips a span short, or prevents
 *  a later hunk from being emitted at all, the last emitted span on that side is
 *  marked `truncated` so the omission is disclosed rather than silent. */
function clipArray(plans: ClipPlan[], before: ResolvedSide, after: ResolvedSide, limits: {
  maxLines: number; maxBytes: number;
}): Clip[] {
  const beforeBudget: Budget = { lines: limits.maxLines, bytes: limits.maxBytes };
  const afterBudget: Budget = { lines: limits.maxLines, bytes: limits.maxBytes };
  const clips: Clip[] = [];
  let beforeTrunc = false;
  let afterTrunc = false;
  for (const plan of plans) {
    const b = materialize(plan.before, before, beforeBudget);
    const a = materialize(plan.after, after, afterBudget);
    if (b.outcome === 'dropped' || a.outcome === 'dropped') {
      if (b.outcome === 'dropped') beforeTrunc = true;
      if (a.outcome === 'dropped') afterTrunc = true;
      break;
    }
    clips.push({ before: b.side, after: a.side });
    if (b.outcome === 'partial') beforeTrunc = true;
    if (a.outcome === 'partial') afterTrunc = true;
    if (b.outcome === 'partial' || a.outcome === 'partial') break;
  }
  if (beforeTrunc) markLastSpanTruncated(clips, 'before');
  if (afterTrunc) markLastSpanTruncated(clips, 'after');
  return clips;
}

/** Disclose truncation on the last emitted span of a side. The last CLIP may be
 *  a null-span insertion/deletion on that side, so walk back to the last clip
 *  that actually has a span there — otherwise a dropped later hunk would go
 *  silently undisclosed. */
function markLastSpanTruncated(clips: Clip[], side: 'before' | 'after'): void {
  for (let i = clips.length - 1; i >= 0; i--) {
    const span = clips[i]![side].span;
    if (span) { span.truncated = true; return; }
  }
}

function materialize(plan: SidePlan, side: ResolvedSide, budget: Budget): Materialized {
  if (plan.kind === 'null') return { side: sideOf(plan.method, null, plan.reason), outcome: 'ok' };
  if (side.kind !== 'text') {
    // whole-file plan against a non-text side is a bug in the caller.
    return { side: { span: null, method: 'unavailable', reason: 'internal-error' }, outcome: 'ok' };
  }
  const range: LineRange = plan.range ?? { s0: 0, e0: side.starts.length };
  if (range.e0 - range.s0 <= 0) {
    // A zero-length corresponding range (the empty side of an insertion/deletion):
    // a null span, not budget exhaustion. Later hunks must still be processed.
    return { side: sideOf(plan.method, null, plan.reason), outcome: 'empty' };
  }
  const clamped = clampToBudget(range, side, budget);
  if (clamped === null) return { side: sideOf(plan.method, null, plan.reason), outcome: 'dropped' };
  budget.lines -= clamped.line_end - clamped.line_start + 1;
  budget.bytes -= clamped.byte_end - clamped.byte_start;
  return { side: sideOf(plan.method, clamped, plan.reason), outcome: clamped.truncated ? 'partial' : 'ok' };
}

function sideOf(method: ClipSideMethod, span: Span | null, reason: string | undefined): ClipSide {
  return reason === undefined ? { span, method } : { span, method, reason };
}

/** Trim a line range to the remaining line/byte budget, on whole-line
 *  granularity. The caller guarantees a non-empty range. Returns null when
 *  nothing fits — either the line budget is spent, or even a single line exceeds
 *  the byte budget (the locked 64 KiB clip ceiling is never exceeded, so a
 *  minified line wider than the ceiling yields no clip rather than an oversized
 *  one). */
function clampToBudget(range: LineRange, side: TextSide, budget: Budget): Span | null {
  const total = range.e0 - range.s0; // > 0, guaranteed by caller
  if (budget.lines <= 0) return null;
  let take = Math.min(total, budget.lines);
  const byteStart = lineStartByte(side, range.s0);
  let byteEnd = lineStartByte(side, range.s0 + take);
  while (take > 1 && byteEnd - byteStart > budget.bytes) {
    take--;
    byteEnd = lineStartByte(side, range.s0 + take);
  }
  if (byteEnd - byteStart > budget.bytes) return null; // even one line exceeds the byte budget
  const truncated = take < total;
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
