// Renders a `file.changed` event as the file's *current* content, line-numbered,
// with an `x` beside each changed line and a blank beside unchanged ones — the
// after-state, not a diff. Unchanged lines far from any change are elided, with
// a `⋯` marking each gap.

import type { ReaderEvent } from './log-reader.ts';

const sanitize = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, '�');

// Above this size a content blob is summarized rather than fetched and printed,
// unless the caller passes `full`. Also bounds the line-alignment work.
const MAX_RENDER_BYTES = 128 * 1024;

/** Split file text into display lines. A trailing newline is a line terminator,
 *  not an extra blank line; empty text is zero lines. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** For each after-line, true if it is NOT part of the longest common subsequence
 *  with the before-lines — i.e. it is new or replaced rather than carried over. */
export function markChanges(before: string[], after: string[]): boolean[] {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = before[i] === after[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const changed = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { changed[j] = false; i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return changed;
}

/** Render after-content as numbered, marked display lines with `context` lines of
 *  unchanged context around each changed run and `⋯` between elided gaps. Returns
 *  [] when nothing changed. */
export function renderMarkedLines(before: string[], after: string[], context: number): string[] {
  const changed = markChanges(before, after);
  const m = after.length;
  const visible = new Array<boolean>(m).fill(false);
  let any = false;
  for (let k = 0; k < m; k++) {
    if (!changed[k]) continue;
    any = true;
    const lo = Math.max(0, k - context);
    const hi = Math.min(m - 1, k + context);
    for (let v = lo; v <= hi; v++) visible[v] = true;
  }
  if (!any) return [];
  const width = String(m).length;
  const out: string[] = [];
  let prev = -1;
  for (let k = 0; k < m; k++) {
    if (!visible[k]) continue;
    if (prev !== -1 && k > prev + 1) out.push('⋯');
    const mark = changed[k] ? 'x' : ' ';
    out.push(numberedLine(mark, k + 1, width, after[k]!));
    prev = k;
  }
  return out;
}

function numberedLine(mark: string, n: number, width: number, text: string): string {
  return `${mark} ${String(n).padStart(width)} ${sanitize(text)}`;
}

/** Render every after-line unmarked (used when the before-side can't be compared). */
function renderUnmarked(after: string[]): string[] {
  const width = String(after.length).length;
  return after.map((line, i) => numberedLine(' ', i + 1, width, line));
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type BlobResult =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'missing'; reason: string };

/** Resolve a content blob (by sha256) to its text, or to a non-text disposition.
 *  Backed by HTTP or disk; injected so the renderer stays pure of I/O policy. */
export type BlobSource = (sha256: string) => Promise<BlobResult>;

export interface ChangeViewOptions { context: number; full: boolean }

type Snapshot =
  | { kind: 'content'; sha256: string; size: number }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'invalid' };

function parseSnapshot(v: unknown): Snapshot {
  if (typeof v !== 'object' || v === null) return { kind: 'invalid' };
  const s = v as Record<string, unknown>;
  if (s.kind === 'content' && typeof s.sha256 === 'string' && typeof s.size === 'number') {
    return { kind: 'content', sha256: s.sha256, size: s.size };
  }
  if (s.kind === 'absent') return { kind: 'absent' };
  if (s.kind === 'unavailable' && typeof s.reason === 'string') {
    return { kind: 'unavailable', reason: s.reason };
  }
  return { kind: 'invalid' };
}

function sizeSummary(before: Snapshot, after: Snapshot): string {
  const a = after.kind === 'content' ? human(after.size) : '?';
  if (before.kind === 'content') return `${human(before.size)} → ${a}`;
  if (before.kind === 'absent') return `new, ${a}`;
  return a;
}

/** Render one `file.changed` event as a header line plus either the marked
 *  after-content or an honest one-line note about why it isn't shown. */
export async function renderChange(
  ev: ReaderEvent,
  getText: BlobSource,
  opts: ChangeViewOptions,
): Promise<string[]> {
  const path = typeof ev.data.path === 'string' ? sanitize(ev.data.path) : '-';
  const header = `#${ev.seq.toString()} ${path}`;
  const note = (msg: string): string[] => [header, `  ${msg}`];

  const before = parseSnapshot(ev.data.before);
  const after = parseSnapshot(ev.data.after);

  if (after.kind === 'invalid' || before.kind === 'invalid') return note('(snapshot missing or malformed)');
  if (after.kind === 'absent') return note('(deleted)');
  if (after.kind === 'unavailable') return note(`(content unavailable: ${sanitize(after.reason)})`);

  if (!opts.full && after.size > MAX_RENDER_BYTES) {
    return note(`(large file, ${human(after.size)} — content hidden; rerun with --full)`);
  }

  const afterBlob = await getText(after.sha256);
  if (afterBlob.kind === 'missing') return note(`(content unavailable: ${sanitize(afterBlob.reason)})`);
  if (afterBlob.kind === 'binary') return note(`(binary, ${sizeSummary(before, after)})`);

  const afterLines = splitLines(afterBlob.text);
  if (afterLines.length === 0) return note('(empty file)');

  const uncomparable = await beforeLinesOrReason(before, getText, opts);
  if ('reason' in uncomparable) {
    return [header, `  (${uncomparable.reason}; changed lines not marked)`, ...renderUnmarked(afterLines)];
  }

  const body = renderMarkedLines(uncomparable.lines, afterLines, opts.context);
  if (body.length === 0) return note('(no line-level change)');
  return [header, ...body];
}

async function beforeLinesOrReason(
  before: Snapshot,
  getText: BlobSource,
  opts: ChangeViewOptions,
): Promise<{ lines: string[] } | { reason: string }> {
  if (before.kind === 'absent') return { lines: [] };
  if (before.kind === 'unavailable') return { reason: `before unavailable: ${sanitize(before.reason)}` };
  if (before.kind !== 'content') return { reason: 'before snapshot malformed' };
  if (!opts.full && before.size > MAX_RENDER_BYTES) return { reason: 'before too large to compare' };
  const blob = await getText(before.sha256);
  if (blob.kind === 'missing') return { reason: `before unavailable: ${sanitize(blob.reason)}` };
  if (blob.kind === 'binary') return { reason: 'before was binary' };
  return { lines: splitLines(blob.text) };
}
