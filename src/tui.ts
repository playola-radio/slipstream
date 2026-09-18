import { openLogCursor, parseLine, type ReaderEvent } from './log-reader.ts';
import { onDiskHighWater, sessionLogPath, listSessions, readRuntimeDescriptor, type RuntimeDescriptor } from './store-reader.ts';
import { renderChange, type BlobSource, type ChangeViewOptions } from './change-view.ts';
import { diskBlobSource, httpBlobSource } from './blob-source.ts';

const sanitize = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '�');

/** Turns one event into the lines to print. Default is the one-line summary; the
 *  changes view expands a `file.changed` event into a marked content block. */
type EventRenderer = (ev: ReaderEvent) => Promise<string[]>;

const oneLine: EventRenderer = async (ev) => [renderEvent(ev)];

function makeRenderer(blob: BlobSource, view: ChangeViewOptions): EventRenderer {
  return async (ev) => {
    if (ev.type !== 'slipstream.file.changed.v1') return [renderEvent(ev)];
    return [...await renderChange(ev, blob, view), ''];
  };
}

function snapshotLabel(snap: unknown): string {
  if (typeof snap !== 'object' || snap === null) return '-';
  const s = snap as Record<string, unknown>;
  if (s.kind === 'content' && typeof s.sha256 === 'string') return sanitize(s.sha256.slice(0, 7));
  if (s.kind === 'absent') return 'absent';
  if (s.kind === 'unavailable') return `unavailable:${sanitize(String(s.reason))}`;
  return '-';
}

export function renderEvent(ev: ReaderEvent): string {
  const d = ev.data;
  const path = typeof d.path === 'string' ? sanitize(d.path) : '-';
  // Every externally-supplied display string is sanitized: a terminal escape in
  // the event type or a reason must never reach the terminal.
  const parts = [ev.seq.toString(), sanitize(ev.type), path];
  if (ev.type === 'slipstream.file.changed.v1') {
    parts.push(snapshotLabel(d.after));
    // Surface the grouping hint the disk/HTTP readers carry in `data`, so a TUI
    // reader sees which task a change belongs to (parity, not a new view).
    if (typeof d.task_hint_id === 'string') parts.push(`task/${sanitize(d.task_hint_id)}`);
  } else if (ev.type === 'slipstream.task.started.v1') {
    // The declaration boundary: show its task and title in the path slot (a
    // declaration names no path) so a TUI reader can correlate it with the
    // `task/<id>` hint stamped on the changes that follow.
    parts[2] = typeof d.task_id === 'string' ? `task/${sanitize(d.task_id)}` : '-';
    if (typeof d.title === 'string') parts.push(sanitize(d.title));
  } else if (ev.type === 'slipstream.capture.gap.v1') {
    parts.push(`gap:${sanitize(String(d.reason ?? 'unknown'))}`);
  }
  return parts.join(' · ');
}

export async function replayFromDisk(
  storeDir: string,
  id: string,
  out: (line: string) => void,
  view?: ChangeViewOptions,
): Promise<void> {
  const render = view ? makeRenderer(diskBlobSource(storeDir), view) : oneLine;
  const logPath = sessionLogPath(storeDir, id);
  const H = await onDiskHighWater(logPath);
  const cursor = await openLogCursor(logPath, 0n);
  try {
    for (;;) {
      const batch = await cursor.readThrough(H);
      if (!batch.length) return;
      for (const ev of batch) for (const line of await render(ev)) out(line);
    }
  }
  finally { await cursor.close(); }
}

/** Extract the SSE `data:` payload from a frame by real line delimiters (never a
 *  `.`-regex, which would drop a payload containing a literal U+2028/U+2029). */
export function sseDataLine(frame: string): string | undefined {
  for (const line of frame.split('\n')) {
    if (line.startsWith('data: ')) return line.slice(6);
  }
  return undefined;
}

export async function runTui(argv: string[], out: (line: string) => void): Promise<void> {
  const disk = argv.includes('--disk');
  const store = argFor(argv, '--store');
  const session = argFor(argv, '--session');
  const context = parseContext(argv);
  if (context === undefined) {
    out('usage: --context must be a non-negative integer');
    return;
  }
  const view = argv.includes('--changes')
    ? { context, full: argv.includes('--full') }
    : undefined;
  if (!store) {
    out('usage: slipstream view --store <dir> [--session <id>] [--disk] [--changes] [--context N] [--full]');
    return;
  }
  if (!session) {
    for (const s of await listSessions(store)) out(`${s.id}  durable=${s.durableSeq}${s.removed ? '  (removed)' : ''}`);
    return;
  }
  if (disk) { await replayFromDisk(store, session, out, view); return; }
  await followHttp(store, session, out, view);
}

const DEFAULT_CONTEXT = 3;

function parseContext(argv: string[]): number | undefined {
  const i = argv.indexOf('--context');
  if (i < 0) return DEFAULT_CONTEXT;
  const raw = argv[i + 1];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function argFor(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function followHttp(store: string, session: string, out: (l: string) => void, view?: ChangeViewOptions): Promise<void> {
  const desc: RuntimeDescriptor | null = await readRuntimeDescriptor(store);
  if (!desc) { out('no usable reader (runtime descriptor missing or invalid); try --disk'); return; }
  const render = view ? makeRenderer(httpBlobSource(desc), view) : oneLine;
  const url = new URL(`v1/sessions/${session}/events?after=0&follow=true`, desc.url);
  let res: Response;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${desc.token}` }, redirect: 'error',
      signal: ac.signal,
    });
  } catch { out('reader unavailable (connection failed or stale descriptor); try --disk'); return; }
  finally { clearTimeout(timer); }
  if (!res.ok || !res.body) { out(`reader responded ${res.status}`); return; }
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let acc = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    acc += decoder.decode(value, { stream: true });
    let i;
    while ((i = acc.indexOf('\n\n')) >= 0) {
      const frame = acc.slice(0, i); acc = acc.slice(i + 2);
      const data = sseDataLine(frame);
      if (data !== undefined) for (const line of await render(parseLine(data))) out(line);
    }
  }
}
