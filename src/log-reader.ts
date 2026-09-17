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

// Each batch retains at most 256 records / 256 KiB, plus one oversized record.
// A single record cannot be split on the wire; memory also depends on its size.
export const LOG_BATCH_RECORDS = 256;
const BATCH_BYTES = 256 * 1024;
const READ_BYTES = 64 * 1024;

export async function openLogCursor(logPath: string, after: bigint): Promise<LogCursor> {
  const handle: FileHandle = await open(logPath, 'r');
  let offset = 0; // sole committed byte position, advanced only over complete lines
  let lastSeq = after;
  let positioned = after === 0n;
  let window = Buffer.alloc(0);
  let windowStart = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  async function nextLine(): Promise<Buffer | null> {
    let pos = offset;
    const pieces: Buffer[] = [];
    for (;;) {
      if (pos < windowStart || pos >= windowStart + window.length) {
        const buffer = Buffer.allocUnsafe(READ_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, pos);
        window = buffer.subarray(0, bytesRead);
        windowStart = pos;
        if (!bytesRead) return null; // torn tail: offset stays at the line start
      }
      const start = pos - windowStart;
      const nl = window.indexOf(0x0a, start);
      if (nl >= 0) {
        pieces.push(window.subarray(start, nl));
        return Buffer.concat(pieces);
      }
      pieces.push(window.subarray(start));
      pos = windowStart + window.length;
    }
  }

  return {
    async readThrough(boundary: bigint): Promise<ReaderEvent[]> {
      const out: ReaderEvent[] = [];
      let bytes = 0;
      while (lastSeq < boundary && out.length < LOG_BATCH_RECORDS && bytes < BATCH_BYTES) {
        const slice = await nextLine();
        if (slice === null) break;
        let line: string;
        try { line = decoder.decode(slice); }
        catch { throw new LogCorruptError('invalid UTF-8 in log record'); }
        const ev = parseLine(line);
        const lineBytes = slice.length + 1;
        if (!positioned) {
          if (ev.seq <= after) { offset += lineBytes; continue; }
          positioned = true;
        }
        if (ev.seq !== lastSeq + 1n) {
          throw new LogCorruptError(`non-contiguous seq: expected ${lastSeq + 1n} got ${ev.seq}`);
        }
        out.push(ev);
        lastSeq = ev.seq;
        offset += lineBytes;
        bytes += lineBytes;
      }
      return out;
    },
    async close() { await handle.close(); },
  };
}
