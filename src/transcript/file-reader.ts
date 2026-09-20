/**
 * Incremental single-transcript reader (I/O plumbing around a pure adapter core).
 *
 * Idempotence comes entirely from the ingestor's log-derived dedup, so there is
 * no durable read cursor: an in-memory byte offset that always sits on a line
 * boundary is enough. Each poll drains from `offset` in bounded chunks up to EOF.
 * Complete lines are stepped through the core; the offset advances ONLY after
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
 *
 * These checks assume an append-only writer: the transcript only grows or is
 * atomically replaced (new inode, refused above), never shrinks and regrows in
 * place within a single poll interval. Claude Code and Codex both write
 * append-only JSONL, so the one case a size comparison cannot see — an in-place
 * shrink then regrow back to at-or-above the last observed size between two polls
 * — does not arise for either supported harness. A non-append-only source could
 * slip a rewrite past the size check; that residual is accepted, not fixed.
 */
import type { NormalizedEvidence } from '../evidence-ingest.ts';
import type { IngestOutcome } from '../evidence-ingest.ts';
import type { Diagnostic } from './types.ts';

const READ_CHUNK_BYTES = 1 << 20; // 1 MiB

// A fatal decoder so an invalid-UTF-8 line is rejected rather than silently decoded
// to replacement characters (which could fabricate a path). Reused across polls;
// safe because each call is a one-shot decode (no streaming state).
const LINE_DECODER = new TextDecoder('utf8', { fatal: true });

/** A file generation's identity: the (dev, ino) of the exact bytes discovery read
 * to derive a binding's session and scope. An atomic replace yields a new inode,
 * so a poll that finds a different {@link FileId} is reading content discovery has
 * not confirmed belongs to this binding. Held as `bigint` because a 64-bit inode
 * exceeds `Number`'s 2^53 exact range: two distinct high inodes collapsed to one
 * `Number` would let a replacement falsely pass the generation check. */
export interface FileId {
  dev: bigint;
  ino: bigint;
}

/** One atomic read: the file's generation ({@link FileId}), its full size, and the bytes
 * `[start, min(size, start + maxBytes))` — ALL taken from a single open handle.
 * Deriving the id and bytes from the same handle makes the generation check trustworthy: a stat
 * on a separate handle could validate one generation while a concurrent replace
 * supplies another generation's bytes to a second handle. */
export type TranscriptReadResult =
  | { ok: true; id: FileId; size: number; bytes: Buffer }
  | { ok: false; reason: 'missing' | 'inaccessible' };

export interface TranscriptFileIO {
  /** Open the file once, fstat it for its identity and full size, and read
   * `[start, min(size, start + maxBytes))` from that SAME handle (empty bytes when
   * `start >= size`). Rejects → the ok:false reason, never a partial read attributed
   * to the wrong generation. */
  readFrom(path: string, start: number, maxBytes: number): Promise<TranscriptReadResult>;
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
  /** Testability seam for exercising chunk boundaries with small fixtures. */
  readChunkBytes?: number;
}

export function createTranscriptFileReader(opts: TranscriptFileReaderOptions) {
  const { path, io, sink, stepper, generation } = opts;
  const readChunkBytes = opts.readChunkBytes ?? READ_CHUNK_BYTES;
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

  // The (dev, ino) of the bytes `rd` supplied is not the pinned generation: the file
  // at this path was replaced (an atomic rename-into-place) with content discovery has
  // NOT re-confirmed. Because the id and the bytes came from the SAME handle, this
  // catches a replace at any instant up to the read — there is no stat-then-open window
  // through which a replacement's bytes could be read while a prior generation's id was
  // validated. Ingesting them would credit the new file's records to the prior
  // generation's session and scope, so refuse: report `unconfirmed`, offset untouched.
  // The next discovery tick re-derives the binding for the new generation and, if it
  // too is a confirmed in-root member, recreates this reader against it.
  const isPinned = (rd: { id: FileId }): boolean =>
    rd.id.dev === generation.dev && rd.id.ino === generation.ino;

  // Returns true if backpressure held the offset at a line (retry next poll).
  const ingestBuffer = async (buf: Buffer): Promise<boolean> => {
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
          if (!ok) return true; // backpressure: hold offset at this line
        }
      }
      offset += lineBytes;
    }
    return false;
  };

  const poll = async (): Promise<FileReadResult> => {
    let backpressured = false;
    let readSize = readChunkBytes;
    for (;;) {
      const rd = await io.readFrom(path, offset, readSize);
      if (!rd.ok) {
        return { state: rd.reason === 'missing' ? 'missing' : 'inaccessible', issues, backpressured };
      }
      if (!isPinned(rd)) {
        return { state: 'unconfirmed', issues, backpressured: false };
      }
      if (rd.size < lastSize) {
        rereadFromZero();
        lastSize = 0;
        readSize = readChunkBytes;
        continue;
      }
      lastSize = rd.size;

      const chunkStart = offset;
      if (await ingestBuffer(rd.bytes)) { backpressured = true; break; }

      if (offset >= rd.size) break; // drained to EOF
      if (offset > chunkStart) { readSize = readChunkBytes; continue; }
      // No complete line consumed this read (offset === chunkStart).
      if (chunkStart + rd.bytes.length >= rd.size) break; // unterminated tail: hold
      readSize = rd.size - offset; // one line exceeds the window: read it whole next
    }
    const state: FileReadState = issues.length > 0 ? 'degraded' : 'readable';
    return { state, issues, backpressured };
  };

  return { poll };
}
