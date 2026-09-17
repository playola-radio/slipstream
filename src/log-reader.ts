// src/log-reader.ts
import { open, type FileHandle } from 'node:fs/promises';

export interface ReaderEvent { seq: bigint; type: string; raw: string; data: Record<string, unknown> }
export class LogCorruptError extends Error {}

const CURSOR_RE = /^(0|[1-9][0-9]*)$/;
const SEQ_RE = /^[1-9][0-9]*$/;

export function parseCursor(raw: string | undefined): bigint | null {
  if (raw === undefined) return 0n;
  if (!CURSOR_RE.test(raw)) return null;
  return BigInt(raw);
}

export function parseLine(line: string): ReaderEvent {
  let obj: unknown;
  try { obj = JSON.parse(line); }
  catch { throw new LogCorruptError(`invalid JSON: ${line.slice(0, 80)}`); }
  if (typeof obj !== 'object' || obj === null) throw new LogCorruptError('line is not an object');
  const rec = obj as Record<string, unknown>;
  const seq = rec.seq; const type = rec.type; const data = rec.data;
  if (typeof seq !== 'string' || !SEQ_RE.test(seq)) throw new LogCorruptError('bad seq');
  if (typeof type !== 'string') throw new LogCorruptError('bad type');
  if (typeof data !== 'object' || data === null) throw new LogCorruptError('bad data');
  return { seq: BigInt(seq), type, raw: line, data: data as Record<string, unknown> };
}

export interface LogCursor {
  readThrough(boundary: bigint): Promise<ReaderEvent[]>;
  close(): Promise<void>;
}

export async function openLogCursor(logPath: string, after: bigint): Promise<LogCursor> {
  const handle: FileHandle = await open(logPath, 'r');
  let offset = 0;          // byte offset of the next unread byte on disk
  let positioned = after === 0n; // have we skipped past `after` yet?
  let lastSeq = after;     // highest emitted seq; enforces strict contiguity

  // Byte-exact: split the complete region on the newline byte and return each
  // line's ORIGINAL byte slice, so offsets never depend on a re-encoded string.
  async function readNewComplete(): Promise<{ slices: Buffer[] }> {
    const chunkSize = 64 * 1024;
    const buf = Buffer.alloc(chunkSize);
    const chunks: Buffer[] = [];
    let read = offset;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, chunkSize, read);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      read += bytesRead;
      if (bytesRead < chunkSize) break;
    }
    const all = Buffer.concat(chunks);
    const lastNl = all.lastIndexOf(0x0a);
    if (lastNl < 0) return { slices: [] };
    const complete = all.subarray(0, lastNl); // bytes before the final newline
    const slices: Buffer[] = [];
    let start = 0;
    for (let i = 0; i < complete.length; i++) {
      if (complete[i] === 0x0a) { slices.push(complete.subarray(start, i)); start = i + 1; }
    }
    slices.push(complete.subarray(start));
    return { slices };
  }

  return {
    async readThrough(boundary: bigint): Promise<ReaderEvent[]> {
      if (boundary <= after) return [];
      const { slices } = await readNewComplete();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const out: ReaderEvent[] = [];
      let advance = offset;
      for (const slice of slices) {
        let line: string;
        try { line = decoder.decode(slice); }
        catch { throw new LogCorruptError('invalid UTF-8 in log record'); }
        const ev = parseLine(line);
        const lineBytes = slice.length + 1; // original bytes + the newline
        if (!positioned) {
          if (ev.seq <= after) { advance += lineBytes; continue; }
          positioned = true;
        }
        if (ev.seq !== lastSeq + 1n) {
          throw new LogCorruptError(`non-contiguous seq: expected ${lastSeq + 1n} got ${ev.seq}`);
        }
        if (ev.seq > boundary) break;      // stop; do not advance or update lastSeq
        out.push(ev);
        lastSeq = ev.seq;
        advance += lineBytes;
      }
      offset = advance;
      return out;
    },
    async close() { await handle.close(); },
  };
}
