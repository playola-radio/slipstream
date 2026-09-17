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

  async function readNewComplete(): Promise<{ lines: string[]; consumed: number }> {
    const chunkSize = 64 * 1024;
    const buf = Buffer.alloc(chunkSize);
    let acc = '';
    let read = offset;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, chunkSize, read);
      if (bytesRead === 0) break;
      acc += buf.toString('utf8', 0, bytesRead);
      read += bytesRead;
      if (bytesRead < chunkSize) break;
    }
    const lastNl = acc.lastIndexOf('\n');
    if (lastNl < 0) return { lines: [], consumed: 0 };
    const complete = acc.slice(0, lastNl);
    const consumed = Buffer.byteLength(complete + '\n', 'utf8');
    return { lines: complete.split('\n'), consumed };
  }

  return {
    async readThrough(boundary: bigint): Promise<ReaderEvent[]> {
      if (boundary <= after) return [];
      const { lines } = await readNewComplete();
      const out: ReaderEvent[] = [];
      let advance = offset;
      for (const line of lines) {
        if (line === '') { advance += 1; continue; } // stray blank line's LF
        const ev = parseLine(line);
        const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
        if (!positioned) {
          if (ev.seq <= after) { advance += lineBytes; continue; }
          positioned = true;
        }
        if (ev.seq > boundary) break;      // stop; do not advance past boundary
        out.push(ev);
        advance += lineBytes;
      }
      offset = advance;
      return out;
    },
    async close() { await handle.close(); },
  };
}
