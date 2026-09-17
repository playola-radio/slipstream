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
 * - Unavailable content shows an explicit marker, never a fabricated size.
 */

export type Snap =
  | { kind: 'content'; size: number }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason?: string };

export type ChangeClass = 'new' | 'deleted' | 'modified';

export type FeedEvent =
  | { kind: 'change'; atMs: number | null; path: string; before: Snap; after: Snap }
  | { kind: 'gap'; atMs: number | null; reason: string }
  | { kind: 'other' }
  | { kind: 'malformed'; raw: string };

export function classifyChange(before: { kind: string }, after: { kind: string }): ChangeClass {
  const beforeAbsent = before.kind === 'absent';
  const afterAbsent = after.kind === 'absent';
  if (beforeAbsent && !afterAbsent) return 'new';
  if (afterAbsent && !beforeAbsent) return 'deleted';
  return 'modified';
}

export function sizeLabel(snap: Snap): string {
  if (snap.kind === 'content') return `${snap.size}B`;
  if (snap.kind === 'absent') return '0B';
  return '—';
}

export function formatClock(atMs: number | null): string {
  if (atMs === null || !Number.isFinite(atMs)) return '--:--:--';
  return new Date(atMs).toTimeString().slice(0, 8);
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
    return { kind: 'content', size: typeof obj.size === 'number' ? obj.size : 0 };
  }
  if (obj.kind === 'absent') return { kind: 'absent' };
  if (obj.kind === 'unavailable') {
    return { kind: 'unavailable', reason: typeof obj.reason === 'string' ? obj.reason : undefined };
  }
  return { kind: 'unavailable', reason: 'unknown' };
}

function timestampFrom(data: Record<string, unknown>, envelope: Record<string, unknown>): number | null {
  if (typeof data.observed_at_ms === 'number') return data.observed_at_ms;
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
    return { kind: 'malformed', raw: line };
  }
  const envelope = asObject(parsed);
  if (!envelope) return { kind: 'malformed', raw: line };

  const type = typeof envelope.type === 'string' ? envelope.type : '';
  // The flat brief shape carries fields at top level; the real log nests them
  // under `data`. Reading `data ?? envelope` handles both.
  const data = asObject(envelope.data) ?? envelope;

  if (type.includes('file.changed')) {
    return {
      kind: 'change',
      atMs: timestampFrom(data, envelope),
      path: typeof data.path === 'string' ? data.path : '<unknown path>',
      before: toSnap(data.before),
      after: toSnap(data.after),
    };
  }
  if (type.includes('capture.gap')) {
    return {
      kind: 'gap',
      atMs: timestampFrom(data, envelope),
      reason: typeof data.reason === 'string' ? data.reason : 'unknown',
    };
  }
  return { kind: 'other' };
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
      return paint(line, CLASS_COLOR[cls], color);
    }
    case 'gap':
      return paint(`${formatClock(ev.atMs)} ⚠ gap: ${ev.reason}`, ANSI.dim, color);
    case 'malformed':
      return paint(`--:--:-- ⚠ unparseable log line`, ANSI.dim, color);
    case 'other':
      return null;
  }
}
