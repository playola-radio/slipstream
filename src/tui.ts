import { openLogCursor, parseLine, type ReaderEvent } from './log-reader.ts';
import { onDiskHighWater, sessionLogPath, listSessions, readRuntimeDescriptor } from './store-reader.ts';

const sanitize = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '�');

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
  if (ev.type === 'slipstream.file.changed.v1') parts.push(snapshotLabel(d.after));
  else if (ev.type === 'slipstream.capture.gap.v1') parts.push(`gap:${sanitize(String(d.reason ?? 'unknown'))}`);
  return parts.join(' · ');
}

export async function replayFromDisk(storeDir: string, id: string): Promise<string[]> {
  const logPath = sessionLogPath(storeDir, id);
  const H = await onDiskHighWater(logPath);
  const cursor = await openLogCursor(logPath, 0n);
  try { return (await cursor.readThrough(H)).map(renderEvent); }
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
  if (!store) { out('usage: slipstream view --store <dir> [--session <id>] [--disk]'); return; }
  if (!session) {
    for (const s of await listSessions(store)) out(`${s.id}  durable=${s.durableSeq}${s.removed ? '  (removed)' : ''}`);
    return;
  }
  if (disk) { for (const line of await replayFromDisk(store, session)) out(line); return; }
  await followHttp(store, session, out);
}

function argFor(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function followHttp(store: string, session: string, out: (l: string) => void): Promise<void> {
  const desc = await readRuntimeDescriptor(store);
  if (!desc) { out('no running reader (runtime descriptor not found); try --disk'); return; }
  const url = new URL(`v1/sessions/${session}/events?after=0&follow=true`, desc.url);
  const res = await fetch(url, { headers: { authorization: `Bearer ${desc.token}` } });
  if (!res.ok || !res.body) { out(`reader responded ${res.status}`); return; }
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let acc = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    acc += decoder.decode(value, { stream: true });
    let i;
    while ((i = acc.indexOf('\n\n')) >= 0) {
      const frame = acc.slice(0, i); acc = acc.slice(i + 2);
      const data = sseDataLine(frame);
      if (data !== undefined) out(renderEvent(parseLine(data)));
    }
  }
}
