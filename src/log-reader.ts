// src/log-reader.ts
import { open, type FileHandle } from 'node:fs/promises';

export interface ReaderEvent { seq: bigint; type: string; raw: string; data: Record<string, unknown> }
export class LogCorruptError extends Error {}
/** Optional bounded scans can stop before materializing an oversized record. */
export class LogReadLimitError extends Error {}
export class LogReadAbortedError extends Error {}

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
  readThrough(boundary: bigint, limits?: { maxRecords?: number; maxBytes?: number; signal?: AbortSignal }): Promise<ReaderEvent[]>;
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
  // Preserve a BOM on every line so JSON parsing rejects it, as recovery does.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  async function nextLine(maxBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
    let pos = offset;
    const pieces: Buffer[] = [];
    let lineBytes = 0;
    for (;;) {
      if (signal?.aborted) throw new LogReadAbortedError('log read aborted');
      if (lineBytes >= maxBytes) throw new LogReadLimitError('log record exceeds scan byte budget');
      if (pos < windowStart || pos >= windowStart + window.length) {
        const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, maxBytes - lineBytes + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, pos);
        window = buffer.subarray(0, bytesRead);
        windowStart = pos;
        if (!bytesRead) return null; // torn tail: offset stays at the line start
      }
      const start = pos - windowStart;
      const nl = window.indexOf(0x0a, start);
      if (nl >= 0) {
        if (lineBytes + nl - start + 1 > maxBytes) throw new LogReadLimitError('log record exceeds scan byte budget');
        pieces.push(window.subarray(start, nl));
        return Buffer.concat(pieces);
      }
      lineBytes += window.length - start;
      if (lineBytes >= maxBytes) throw new LogReadLimitError('log record exceeds scan byte budget');
      pieces.push(window.subarray(start));
      pos = windowStart + window.length;
    }
  }

  return {
    async readThrough(boundary: bigint, limits = {}): Promise<ReaderEvent[]> {
      const out: ReaderEvent[] = [];
      let bytes = 0;
      while (lastSeq < boundary && out.length < Math.min(LOG_BATCH_RECORDS, limits.maxRecords ?? LOG_BATCH_RECORDS)
        && bytes < BATCH_BYTES && bytes < (limits.maxBytes ?? Infinity)) {
        let slice: Buffer | null;
        try { slice = await nextLine((limits.maxBytes ?? Infinity) - bytes, limits.signal); }
        catch (error) {
          // Offset already advanced for records in this batch. Return them before
          // reporting the limit on the next call, so a retry cannot skip them.
          if (out.length > 0 && (error instanceof LogReadLimitError || error instanceof LogReadAbortedError)) return out;
          throw error;
        }
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
