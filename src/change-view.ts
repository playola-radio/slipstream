// Renders a `file.changed` event as the file's *current* content, line-numbered,
// with an `x` beside each changed line and a blank beside unchanged ones — the
// after-state, not a diff. Unchanged lines far from any change are elided, with
// a `⋯` marking each gap.
import { isValidHex, type RuntimeDescriptor } from './store-reader.ts';
import type { ReaderEvent } from './log-reader.ts';

// Control chars must never reach the terminal verbatim: C0 (0x00–0x1f), DEL, and
// C1 (0x80–0x9f, e.g. U+009B = CSI) are all replaced.
const sanitize = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '�');

// Above this size a content blob is summarized rather than fetched and printed,
// unless the caller passes `full`.
const MAX_RENDER_BYTES = 128 * 1024;
// Above this before×after line-cell product the O(n·m) alignment is skipped and
// content is shown unmarked, bounding time and memory even under `full`.
const MAX_ALIGN_CELLS = 8_000_000;

/** Split file text into display lines. A trailing newline is a line terminator,
 *  not an extra blank line; empty text is zero lines. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** For each after-line, true if it is NOT part of the longest common subsequence
 *  with the before-lines — i.e. it is new or replaced rather than carried over. */
export function markChanges(before: string[], after: string[]): boolean[] {
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
  const changed = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { changed[j] = false; i++; j++; }
    else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) i++;
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
  for (let k = 0; k < m; k++) {
    if (!changed[k]) continue;
    const lo = Math.max(0, k - context);
    const hi = Math.min(m - 1, k + context);
    for (let v = lo; v <= hi; v++) visible[v] = true;
  }
  const width = String(m).length;
  const out: string[] = [];
  let prev = -1;
  for (let k = 0; k < m; k++) {
    if (!visible[k]) continue;
    if (prev !== -1 && k > prev + 1) out.push('⋯');
    out.push(numberedLine(changed[k] ? 'x' : ' ', k + 1, width, after[k]!));
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
  | { kind: 'oversize'; size: number }
  | { kind: 'missing'; reason: string };

/** Resolve a content blob (by sha256) to its text, or to a non-text disposition.
 *  `maxBytes` bounds the actual bytes read regardless of declared size. Backed by
 *  HTTP or disk; injected so the renderer stays pure of I/O policy. */
export type BlobSource = (sha256: string, maxBytes: number) => Promise<BlobResult>;

export interface ChangeViewOptions { context: number; full: boolean }

type Snapshot =
  | { kind: 'content'; sha256: string; size: number }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'invalid' };

function parseSnapshot(v: unknown): Snapshot {
  if (typeof v !== 'object' || v === null) return { kind: 'invalid' };
  const s = v as Record<string, unknown>;
  if (s.kind === 'content') {
    if (typeof s.sha256 === 'string' && isValidHex(s.sha256)
      && typeof s.size === 'number' && Number.isInteger(s.size) && s.size >= 0) {
      return { kind: 'content', sha256: s.sha256, size: s.size };
    }
    return { kind: 'invalid' };
  }
  if (s.kind === 'absent') return { kind: 'absent' };
  if (s.kind === 'unavailable' && typeof s.reason === 'string') {
    return { kind: 'unavailable', reason: s.reason };
  }
  return { kind: 'invalid' };
}

function sizeSummary(before: Snapshot, afterSize: number): string {
  const a = human(afterSize);
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
  const path = typeof ev.data.path === 'string' ? sanitize(ev.data.path) : '(path unavailable)';
  // Surface the grouping hint on the header so the changes view has the same task
  // membership the disk/HTTP readers carry in `data` (parity, not a new view).
  const hint = typeof ev.data.task_hint_id === 'string' ? ` · task/${sanitize(ev.data.task_hint_id)}` : '';
  const header = `#${ev.seq.toString()} ${path}${hint}`;
  const note = (msg: string): string[] => [header, `  ${msg}`];
  const cap = opts.full ? Number.POSITIVE_INFINITY : MAX_RENDER_BYTES;

  const after = parseSnapshot(ev.data.after);
  if (after.kind === 'invalid') return note('(snapshot missing or malformed)');
  if (after.kind === 'absent') return note('(deleted)');
  if (after.kind === 'unavailable') return note(`(content unavailable: ${sanitize(after.reason)})`);

  if (!opts.full && after.size > MAX_RENDER_BYTES) {
    return note(`(large file, ${human(after.size)} — content hidden; rerun with --full)`);
  }

  const afterBlob = await getText(after.sha256, cap);
  if (afterBlob.kind === 'missing') return note(`(content unavailable: ${sanitize(afterBlob.reason)})`);
  if (afterBlob.kind === 'oversize') {
    return note(`(large file, ${human(afterBlob.size)} — content hidden; rerun with --full)`);
  }
  if (afterBlob.kind === 'binary') return note(`(binary, ${sizeSummary(before(ev), after.size)})`);

  const afterLines = splitLines(afterBlob.text);
  if (afterLines.length === 0) return note('(empty file)');

  const beforeSnap = before(ev);
  const beforeRes = await resolveBefore(beforeSnap, getText, opts, cap);
  if ('reason' in beforeRes) {
    if (opts.full) return [header, `  (${beforeRes.reason})`, ...renderUnmarked(afterLines)];
    return note(`(${beforeRes.reason}; rerun with --full)`);
  }

  const beforeLines = beforeRes.lines;
  if (beforeLines.length * afterLines.length > MAX_ALIGN_CELLS) {
    if (opts.full) return [header, '  (too large to align; showing content unmarked)', ...renderUnmarked(afterLines)];
    return note('(too large to compare line-by-line; rerun with --full)');
  }

  const body = renderMarkedLines(beforeLines, afterLines, opts.context);
  if (body.length === 0) {
    const removed = beforeLines.length - afterLines.length;
    const msg = removed > 0
      ? `(${removed} line${removed === 1 ? '' : 's'} removed)`
      : '(no line-level change; whitespace or newline only)';
    if (opts.full) return [header, `  ${msg}`, ...renderUnmarked(afterLines)];
    return note(msg);
  }
  // A new file has no baseline, so every line is marked; the note explains why.
  if (beforeSnap.kind === 'absent') return [header, '  (new file)', ...body];
  return [header, ...body];
}

function before(ev: ReaderEvent): Snapshot { return parseSnapshot(ev.data.before); }

async function resolveBefore(
  before: Snapshot,
  getText: BlobSource,
  opts: ChangeViewOptions,
  cap: number,
): Promise<{ lines: string[] } | { reason: string }> {
  if (before.kind === 'absent') return { lines: [] };
  if (before.kind === 'unavailable') return { reason: `before unavailable: ${sanitize(before.reason)}` };
  if (before.kind !== 'content') return { reason: 'before snapshot malformed' };
  if (!opts.full && before.size > MAX_RENDER_BYTES) return { reason: 'before too large to compare' };
  const blob = await getText(before.sha256, cap);
  if (blob.kind === 'missing') return { reason: `before unavailable: ${sanitize(blob.reason)}` };
  if (blob.kind === 'oversize') return { reason: 'before too large to compare' };
  if (blob.kind === 'binary') return { reason: 'before was binary' };
  return { lines: splitLines(blob.text) };
}

export type { RuntimeDescriptor };
