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
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 15000;

/** The request reached the wire but its outcome is unknowable — the mutation may
 * or may not have committed. The caller must not retry blindly. */
export class OutcomeUnknownError extends Error {
  readonly code = 'OUTCOME_UNKNOWN';
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeUnknownError';
  }
}

function daemonUnavailable(message: string): ResponseEnvelope {
  return { v: 1, ok: false, code: 'DAEMON_UNAVAILABLE', message };
}

export function sendControlRequest(opts: ControlRequestOptions): Promise<ResponseEnvelope> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const responseTimeoutMs = opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;

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

    timer = setTimeout(() => failTransport('daemon did not respond before the deadline'), connectTimeoutMs);

    sock.on('connect', () => {
      sock.write(encodeMessage(opts.request), (err) => {
        if (err) { failTransport(`control write failed: ${err.message}`); return; }
        sent = true;
        clearTimeout(timer);
        timer = setTimeout(
          () => failTransport('no response before the deadline; the request may have committed'),
          responseTimeoutMs,
        );
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
      finish(() => resolve(messages[0] as ResponseEnvelope));
    });

    sock.on('error', (err) => failTransport((err as NodeJS.ErrnoException).message));
    sock.on('close', () => failTransport('connection closed before a response arrived'));
  });
}
