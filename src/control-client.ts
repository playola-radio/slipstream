import { connect } from 'node:net';
import {
  createLineDecoder,
  encodeMessage,
  type RequestEnvelope,
  type ResponseEnvelope,
} from './control-protocol.ts';

/**
 * The client half of the daemon control channel: connect, send exactly one
 * request, await exactly one response, close. It exists so the CLI (and P4's
 * forwarder) speak to the daemon without reimplementing framing or the honesty
 * rule below.
 *
 * The honesty rule is the whole point. A control verb like begin_task MUTATES
 * durable state, so the client must never claim more than it knows:
 *   - A failure BEFORE the request is transmitted (no such socket, connection
 *     refused, connect deadline) is proof nothing ran ⇒ a synthesized
 *     `DAEMON_UNAVAILABLE` response ("the daemon isn't there, try again").
 *   - A failure AFTER the request is transmitted (response deadline, the
 *     connection dropping, an unparseable reply) is genuinely ambiguous — the
 *     daemon may have committed the mutation before we lost the answer ⇒
 *     {@link OutcomeUnknownError}, NEVER `DAEMON_UNAVAILABLE`. Reporting "nothing
 *     happened" here would be a lie a retry could turn into a double-commit.
 */

export interface ControlRequestOptions {
  socketPath: string;
  request: RequestEnvelope;
  /** Deadline to establish the connection (before the request is sent). */
  connectTimeoutMs?: number;
  /** Deadline to receive the response (after the request is sent). */
  responseTimeoutMs?: number;
  /** Optional absolute deadline shared with work done before this request. */
  deadlineAtMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 15000;

/** The request reached the wire but its outcome is unknowable — the mutation may
 * or may not have committed. The caller must not retry blindly. */
export class OutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeUnknownError';
  }
}

function daemonUnavailable(message: string): ResponseEnvelope {
  return { v: 1, ok: false, code: 'DAEMON_UNAVAILABLE', message };
}

/** A reply is only usable if it is a well-formed response envelope. Anything else
 * on the wire (a bare `null`, a success object missing `ok`, a wrong protocol
 * version) means we cannot read the daemon's answer — ambiguous after send, never
 * a silent success. */
function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.ok !== 'boolean') return false;
  if (v.ok === false) return typeof v.code === 'string' && typeof v.message === 'string';
  return true;
}

export function sendControlRequest(opts: ControlRequestOptions): Promise<ResponseEnvelope> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const responseTimeoutMs = opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  if (opts.deadlineAtMs !== undefined && opts.deadlineAtMs <= Date.now()) {
    return Promise.resolve(daemonUnavailable('daemon request deadline elapsed before connecting'));
  }
  const remaining = (phaseTimeoutMs: number): number => opts.deadlineAtMs === undefined
    ? phaseTimeoutMs : Math.min(phaseTimeoutMs, Math.max(0, opts.deadlineAtMs - Date.now()));

  return new Promise<ResponseEnvelope>((resolve, reject) => {
    const decoder = createLineDecoder();
    let sent = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const sock = connect(opts.socketPath);

    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.destroy();
      act();
    };
    // Before the request is on the wire, a fault means the daemon is unreachable;
    // after, the outcome is unknowable. `sent` is the sole switch between them.
    const failTransport = (message: string): void =>
      sent
        ? finish(() => reject(new OutcomeUnknownError(message)))
        : finish(() => resolve(daemonUnavailable(message)));

    timer = setTimeout(() => failTransport('daemon did not respond before the deadline'), remaining(connectTimeoutMs));

    sock.on('connect', () => {
      // The connection is up: from here on, bytes may reach the daemon, so any
      // later fault is ambiguous, not proof of nothing sent. Flip `sent` before
      // the write starts and re-arm the timer as a response deadline.
      clearTimeout(timer);
      sent = true;
      timer = setTimeout(
        () => failTransport('no response before the deadline; the request may have committed'),
        remaining(responseTimeoutMs),
      );
      sock.write(encodeMessage(opts.request), (err) => {
        if (err) failTransport(`control write failed: ${err.message}`);
      });
    });

    sock.on('data', (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        // A malformed reply after send: the daemon acted but we cannot read its
        // answer — ambiguous, not "unavailable".
        finish(() => reject(new OutcomeUnknownError(`unreadable control response: ${(err as Error).message}`)));
        return;
      }
      if (messages.length === 0) return; // response not yet complete
      const reply = messages[0];
      if (!isResponseEnvelope(reply)) {
        finish(() => reject(new OutcomeUnknownError('daemon reply was not a valid control response')));
        return;
      }
      finish(() => resolve(reply));
    });

    sock.on('error', (err) => failTransport((err as NodeJS.ErrnoException).message));
    sock.on('close', () => failTransport('connection closed before a response arrived'));
  });
}
