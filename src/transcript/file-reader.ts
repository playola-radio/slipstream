/**
 * Incremental single-transcript reader (I/O plumbing around a pure adapter core).
 *
 * Idempotence comes entirely from the ingestor's log-derived dedup, so there is
 * no durable read cursor: an in-memory byte offset that always sits on a line
 * boundary is enough. Each poll re-reads only `[offset, size)`; complete lines
 * are stepped through the core, and the offset advances past a line ONLY after
 * every record it produced is durably appended or reported duplicate. A retryable
 * queue-full rejection (or an append failure) stops advancement so the line is
 * retried next poll — reprocessing is safe because dedup drops what already
 * landed. A blank or unparseable line advances (it must never wedge the reader);
 * only backpressure holds the offset.
 *
 * Rotation/rewrite (inode change, or a size below the offset) resets the offset
 * and the core's join state to a fresh generation and rereads from zero.
 */
import type { NormalizedEvidence } from '../evidence-ingest.ts';
import type { IngestOutcome } from '../evidence-ingest.ts';
import type { Diagnostic } from './types.ts';

export type StatResult =
  | { ok: true; size: number; dev: number; ino: number }
  | { ok: false; reason: 'missing' | 'inaccessible' };

export interface TranscriptFileIO {
  stat(path: string): Promise<StatResult>;
  /** Read bytes `[start, end)`. Rejects if the file cannot be read. */
  read(path: string, start: number, end: number): Promise<Buffer>;
}

export interface EvidenceSink {
  ingest(evidence: NormalizedEvidence): Promise<IngestOutcome>;
}

/** A stateful wrapper over a pure adapter core, bound to one file's join state. */
export interface Stepper {
  reset(): void;
  step(record: unknown): { evidence: NormalizedEvidence[]; diagnostics: Diagnostic[] };
}

export type FileReadState = 'readable' | 'degraded' | 'missing' | 'inaccessible';

export interface FileReadResult {
  state: FileReadState;
  /** Content issues observed this generation (malformed/unsupported records). */
  issues: Diagnostic[];
  /** Whether backpressure left unprocessed complete lines behind this poll. */
  backpressured: boolean;
}

export interface TranscriptFileReaderOptions {
  path: string;
  io: TranscriptFileIO;
  sink: EvidenceSink;
  stepper: Stepper;
}

export function createTranscriptFileReader(opts: TranscriptFileReaderOptions) {
  const { path, io, sink, stepper } = opts;
  let offset = 0;
  let dev: number | undefined;
  let ino: number | undefined;
  let issues: Diagnostic[] = [];

  const resetGeneration = (st: { dev: number; ino: number }): void => {
    offset = 0;
    dev = st.dev;
    ino = st.ino;
    issues = [];
    stepper.reset();
  };

  // Ingest every record for one line; false means a retryable stop (advance held).
  const ingestLine = async (records: readonly NormalizedEvidence[]): Promise<boolean> => {
    for (const record of records) {
      let outcome: IngestOutcome;
      try {
        outcome = await sink.ingest(record);
      } catch {
        return false; // append failure — retry the whole line next poll
      }
      if (outcome.status === 'rejected') return false;
    }
    return true;
  };

  const poll = async (): Promise<FileReadResult> => {
    const st = await io.stat(path);
    if (!st.ok) {
      return { state: st.reason === 'missing' ? 'missing' : 'inaccessible', issues, backpressured: false };
    }
    if (dev === undefined || st.dev !== dev || st.ino !== ino || st.size < offset) {
      resetGeneration(st);
    }
    let backpressured = false;
    if (st.size > offset) {
      let buf: Buffer;
      try {
        buf = await io.read(path, offset, st.size);
      } catch {
        return { state: 'inaccessible', issues, backpressured: false };
      }
      const text = buf.toString('utf8');
      const parts = text.split('\n');
      // The final element has no trailing newline: an incomplete line we leave
      // for a later poll (do not advance past it).
      for (let i = 0; i < parts.length - 1; i++) {
        const line = parts[i]!;
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + '\n'
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          let record: unknown;
          try {
            record = JSON.parse(trimmed);
          } catch {
            issues.push({ kind: 'malformed', detail: 'transcript line was not valid JSON' });
            offset += lineBytes;
            continue;
          }
          const out = stepper.step(record);
          if (out.diagnostics.length > 0) issues.push(...out.diagnostics);
          if (out.evidence.length > 0) {
            const ok = await ingestLine(out.evidence);
            if (!ok) {
              backpressured = true;
              break; // hold the offset at this line; retry next poll
            }
          }
        }
        offset += lineBytes;
      }
    }
    const state: FileReadState = issues.length > 0 ? 'degraded' : 'readable';
    return { state, issues, backpressured };
  };

  return { poll };
}
