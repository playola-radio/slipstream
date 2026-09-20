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
 * The reader is pinned to ONE file generation: the (dev, ino) discovery read to
 * confirm this binding's membership and scope. A poll that finds a different
 * inode is a replacement discovery has not yet re-confirmed — ingesting it would
 * credit the new file's records to the prior generation's session and scope — so
 * the reader refuses it (`unconfirmed`) and defers to the next discovery tick,
 * which re-derives the binding for the new generation and, if it too is a
 * confirmed in-root member, recreates this reader against it. Within the pinned
 * generation, a size below the last observed size is an in-place rewrite/truncation
 * (a partial tail replaced by shorter content); the offset and join state reset and
 * it rereads from zero. Tracking the last observed size, not just the offset,
 * catches a shrink to at-or-above the line-boundary offset that an offset-only
 * check would miss.
 */
import type { NormalizedEvidence } from '../evidence-ingest.ts';
import type { IngestOutcome } from '../evidence-ingest.ts';
import type { Diagnostic } from './types.ts';

// A fatal decoder so an invalid-UTF-8 line is rejected rather than silently decoded
// to replacement characters (which could fabricate a path). Reused across polls;
// safe because each call is a one-shot decode (no streaming state).
const LINE_DECODER = new TextDecoder('utf8', { fatal: true });

/** A file generation's identity: the (dev, ino) of the exact bytes discovery read
 * to derive a binding's session and scope. An atomic replace yields a new inode,
 * so a poll that finds a different {@link FileId} is reading content discovery has
 * not confirmed belongs to this binding. */
export interface FileId {
  dev: number;
  ino: number;
}

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

export type FileReadState = 'readable' | 'degraded' | 'missing' | 'inaccessible' | 'unconfirmed';

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
  /** The file generation discovery confirmed for this binding's session and scope.
   * A poll that finds a different inode refuses to ingest it (`unconfirmed`). */
  generation: FileId;
}

export function createTranscriptFileReader(opts: TranscriptFileReaderOptions) {
  const { path, io, sink, stepper, generation } = opts;
  let offset = 0;
  let lastSize = 0;
  let issues: Diagnostic[] = [];

  const rereadFromZero = (): void => {
    offset = 0;
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
    // A different inode at this path is a replacement (an atomic rename-into-place)
    // whose membership and scope discovery has NOT re-confirmed. Ingesting it would
    // credit the new file's records to the prior generation's session and scope, so
    // refuse it: report `unconfirmed` and leave the offset untouched. The next
    // discovery tick re-derives the binding for the new generation and, if it too is
    // a confirmed in-root member, recreates this reader against it.
    if (st.dev !== generation.dev || st.ino !== generation.ino) {
      return { state: 'unconfirmed', issues, backpressured: false };
    }
    // A file smaller than we last saw it was truncated/rewritten in place within the
    // pinned generation, even when it still sits at or above the line-boundary offset
    // (a partial tail replaced by shorter content). Reread from zero. (`size < lastSize`
    // subsumes `size < offset`, since the offset never runs past the last observed size.)
    if (st.size < lastSize) {
      rereadFromZero();
    }
    lastSize = st.size;
    let backpressured = false;
    if (st.size > offset) {
      let buf: Buffer;
      try {
        buf = await io.read(path, offset, st.size);
      } catch {
        return { state: 'inaccessible', issues, backpressured: false };
      }
      // Split on newline BYTES, not decoded characters: invalid UTF-8 decodes to
      // a 3-byte replacement char, so measuring a decoded line's length would
      // advance the cursor past bytes that were never there and skip live records.
      // Bytes after the last newline are an incomplete line, left for a later poll.
      let lineStart = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0x0a) continue;
        const lineBytes = i - lineStart + 1; // through the newline
        const slice = buf.subarray(lineStart, i);
        lineStart = i + 1;
        let decoded: string;
        try {
          decoded = LINE_DECODER.decode(slice);
        } catch {
          // Invalid UTF-8: decoding it lossily would coin replacement characters and
          // could fabricate a path, so disclose it malformed and advance past it.
          issues.push({ kind: 'malformed', detail: 'transcript line was not valid UTF-8' });
          offset += lineBytes;
          continue;
        }
        const trimmed = decoded.trim();
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
