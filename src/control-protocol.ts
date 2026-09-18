/**
 * The Slipstream daemon control protocol: newline-delimited JSON over an
 * owner-only `node:net` unix socket. This is a PRIVATE CONTROL channel — its
 * verbs (attach / detach / status / begin_task) WRITE public events and never
 * read or serve the feed. Readers keep serving the public HTTP/disk view; there
 * is no privileged back channel for reading.
 *
 * Framing is one JSON object per line. A length prefix would buy nothing here:
 * the real hazards are unbounded buffering of an unterminated line, a UTF-8
 * character split across socket chunks, and several frames arriving in one
 * chunk. The decoder below closes all three, and refuses a line past a byte cap
 * before it can accumulate.
 */

/** Client-facing control error codes (the subset this PR owns). `DAEMON_UNAVAILABLE`
 * is synthesized client-side; `INVALID_TITLE` originates in P2's beginTask;
 * `SESSION_ACTIVE` refuses a second attach while one session is already active
 * (this PR carries exactly one active capture). */
export type ControlErrorCode =
  | 'DAEMON_UNAVAILABLE'
  | 'SESSION_NOT_SELECTED'
  | 'SESSION_ACTIVE'
  | 'IDENTITY_UNRESOLVED'
  | 'CAPTURE_NOT_READY'
  | 'STORAGE_UNAVAILABLE'
  | 'INVALID_TITLE'
  | 'PROTOCOL';

export interface RequestEnvelope {
  v: 1;
  verb: string;
  [key: string]: unknown;
}

export interface OkResponse {
  v: 1;
  ok: true;
  [key: string]: unknown;
}

export interface ErrorResponse {
  v: 1;
  ok: false;
  code: ControlErrorCode;
  message: string;
}

export type ResponseEnvelope = OkResponse | ErrorResponse;

/** A framing/parse fault at the transport layer. The server answers a
 * best-effort `PROTOCOL` error then closes; the client surfaces it as-is. */
export class ProtocolError extends Error {
  readonly code = 'PROTOCOL';
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** One control line (the JSON object, excluding its trailing newline) must fit
 * in this many bytes. Generous for a title but far short of anything that could
 * exhaust memory. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

export function encodeMessage(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value) + '\n', 'utf8');
}

export interface LineDecoder {
  /** Feed raw socket bytes; returns the JSON value of each newly completed line
   * (blank lines skipped). Throws {@link ProtocolError} on invalid JSON or an
   * over-cap unterminated line. */
  push(chunk: Buffer): unknown[];
  /** Signal EOF. Throws {@link ProtocolError} if a partial line is buffered — an
   * incomplete final frame is a fault, never silently dropped. */
  end(): void;
}

export function createLineDecoder(maxBytes: number = MAX_MESSAGE_BYTES): LineDecoder {
  let buf: Buffer = Buffer.alloc(0);

  return {
    push(chunk: Buffer): unknown[] {
      // Keep raw bytes until a line is complete: a multibyte character split
      // across chunks is only decoded once all its bytes have arrived.
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      const out: unknown[] = [];
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(NEWLINE, start);
        if (nl === -1) break;
        const line = buf.subarray(start, nl);
        start = nl + 1;
        if (line.length === 0) continue; // tolerate blank separators
        if (line.length > maxBytes) throw new ProtocolError('control line exceeds byte cap');
        const text = line.toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new ProtocolError('control line is not valid JSON');
        }
        out.push(parsed);
      }
      buf = start === 0 ? buf : buf.subarray(start);
      // Refuse an unterminated line that has already outgrown the cap, before it
      // can accumulate without bound across future chunks.
      if (buf.length > maxBytes) throw new ProtocolError('control line exceeds byte cap');
      return out;
    },
    end(): void {
      if (buf.length > 0) throw new ProtocolError('stream ended mid-line');
    },
  };
}
