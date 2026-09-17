/**
 * Pure record-classification and line-formatting for the live-feed viewer.
 *
 * This tool reads only the public artifact — the `events.jsonl` capture log —
 * and never the daemon internals. To stay standalone (the log must outlive any
 * one client), it defines its own minimal view of the record shape rather than
 * importing the daemon's types.
 *
 * Honesty constraints carried over from the log itself:
 * - A prior `unavailable` state is never upgraded to a confident "new".
 * - `capture.gap` records are rendered, never dropped, so coverage gaps stay
 *   visible.
 * - Unavailable content shows its explicit reason, never a fabricated size; a
 *   missing/invalid size shows `?B`, never `0B`.
 */

export type Snap =
  | { kind: 'content'; size: number | null }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason: string | null };

export type ChangeClass = 'new' | 'deleted' | 'modified';

export type FeedEvent =
  | { kind: 'change'; atMs: number | null; path: string; before: Snap; after: Snap }
  | { kind: 'gap'; atMs: number | null; reason: string }
  | { kind: 'other' }
  | { kind: 'malformed' };

// The real log uses these CloudEvents type names; the brief's flat example uses
// the short aliases. Matching an exact set (not a substring) means an unknown or
// future-versioned type is ignored rather than misread as a v1 change.
const CHANGE_TYPES = new Set(['slipstream.file.changed.v1', 'file.changed']);
const GAP_TYPES = new Set(['slipstream.capture.gap.v1', 'capture.gap']);

export function classifyChange(before: { kind: string }, after: { kind: string }): ChangeClass {
  const beforeAbsent = before.kind === 'absent';
  const afterAbsent = after.kind === 'absent';
  if (beforeAbsent && !afterAbsent) return 'new';
  if (afterAbsent && !beforeAbsent) return 'deleted';
  return 'modified';
}

export function sizeLabel(snap: Snap): string {
  if (snap.kind === 'content') return snap.size === null ? '?B' : `${snap.size}B`;
  if (snap.kind === 'absent') return '0B';
  return `⟨${snap.reason ?? 'unavailable'}⟩`;
}

/** True only for a value that maps to a real wall-clock instant. */
function validMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

export function formatClock(atMs: number | null): string {
  const ms = validMs(atMs);
  if (ms === null) return '--:--:--';
  return new Date(ms).toTimeString().slice(0, 8);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a snapshot loosely; anything unrecognized becomes an honest "unavailable". */
function toSnap(value: unknown): Snap {
  const obj = asObject(value);
  if (!obj) return { kind: 'unavailable', reason: 'missing' };
  if (obj.kind === 'content') {
    const size = typeof obj.size === 'number' && Number.isFinite(obj.size) && obj.size >= 0 ? obj.size : null;
    return { kind: 'content', size };
  }
  if (obj.kind === 'absent') return { kind: 'absent' };
  if (obj.kind === 'unavailable') {
    return { kind: 'unavailable', reason: typeof obj.reason === 'string' ? obj.reason : null };
  }
  return { kind: 'unavailable', reason: 'unknown' };
}

function timestampFrom(data: Record<string, unknown>, envelope: Record<string, unknown>): number | null {
  const direct = validMs(data.observed_at_ms);
  if (direct !== null) return direct;
  if (typeof envelope.time === 'string') {
    const parsed = Date.parse(envelope.time);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Parse one JSONL line into a normalized feed event. Never throws. */
export function parseLine(line: string): FeedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'malformed' };
  }
  const envelope = asObject(parsed);
  if (!envelope) return { kind: 'malformed' };

  const type = typeof envelope.type === 'string' ? envelope.type : '';
  // The flat brief shape carries fields at top level; the real log nests them
  // under `data`. Reading `data ?? envelope` handles both.
  const data = asObject(envelope.data) ?? envelope;

  if (CHANGE_TYPES.has(type)) {
    return {
      kind: 'change',
      atMs: timestampFrom(data, envelope),
      path: typeof data.path === 'string' ? data.path : '<unknown path>',
      before: toSnap(data.before),
      after: toSnap(data.after),
    };
  }
  if (GAP_TYPES.has(type)) {
    return {
      kind: 'gap',
      atMs: timestampFrom(data, envelope),
      reason: typeof data.reason === 'string' ? data.reason : 'unknown',
    };
  }
  return { kind: 'other' };
}

/**
 * Neutralize terminal control characters in text read from the log. Filenames
 * and unavailable-reason strings can legally contain ESC and other C0 controls;
 * printing them verbatim would let a watched path rewrite the terminal or forge
 * feed lines. Applied to the whole assembled line, so every log-derived field
 * (path, sizes, reason) is covered uniformly. The arrow and box glyphs the
 * viewer itself adds are non-control code points and pass through untouched.
 */
function sanitize(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
} as const;

const CLASS_COLOR: Record<ChangeClass, string> = {
  new: ANSI.green,
  deleted: ANSI.red,
  modified: ANSI.yellow,
};

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

export interface FormatOptions {
  color: boolean;
}

/** Render a normalized event as one display line, or null to skip it. */
export function formatEvent(ev: FeedEvent, opts: FormatOptions): string | null {
  const { color } = opts;
  switch (ev.kind) {
    case 'change': {
      const cls = classifyChange(ev.before, ev.after);
      const line = `${formatClock(ev.atMs)} ${ev.path} ${sizeLabel(ev.before)} → ${sizeLabel(ev.after)} [${cls}]`;
      return paint(sanitize(line), CLASS_COLOR[cls], color);
    }
    case 'gap':
      return paint(sanitize(`${formatClock(ev.atMs)} ⚠ gap: ${ev.reason}`), ANSI.dim, color);
    case 'malformed':
      return paint(`--:--:-- ⚠ unparseable log line`, ANSI.dim, color);
    case 'other':
      return null;
  }
}
