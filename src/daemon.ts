import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { startCapture, InvalidTitleError, type CaptureSession } from './session.ts';
import { StorageError, mkdirpDurable, assertOwnerOnly } from './storage.ts';
import { acquireSessionLock, SessionOwnedError, type SessionLock } from './lock.ts';
import { startReaderServer, type ReaderServer } from './http-reader.ts';
import { createBoundaryRegistry } from './boundary-registry.ts';
import { liveBoundary } from './reader-runtime.ts';
import {
  createLineDecoder,
  encodeMessage,
  type RequestEnvelope,
  type ResponseEnvelope,
  type ControlErrorCode,
} from './control-protocol.ts';

/**
 * The one shared daemon (D3). It owns the shared store, exactly ONE public reader,
 * at most ONE active capture session, and the boundary registry that keeps the two
 * honest as a session attaches and detaches beneath the long-lived reader.
 *
 * It speaks the PRIVATE control protocol (attach / detach / status / begin_task).
 * Every verb WRITES public events or reports state; none reads or serves the feed
 * — readers get the feed through the public HTTP view like any other client. There
 * is no privileged back channel for reading.
 *
 * Singleton-ness rests on two independent guards: the store lock (a live owner
 * makes {@link acquireSessionLock} throw {@link SessionOwnedError}) and, because a
 * lock can be stale-reclaimed while its owner is merely paused, a connect-probe of
 * the control socket on EADDRINUSE — a socket that still answers is a live daemon,
 * one that refuses the connection is stale and reclaimable, and one that neither
 * answers nor refuses is ambiguous and we fail closed rather than guess it dead.
 */
export interface DaemonOptions {
  /** The shared store root (e.g. `~/.slipstream`). */
  storeDir: string;
  /** Defaults to `<storeDir>/control.sock`. */
  socketPath?: string;
  /** Injected capture dependencies (tests drive a fake platform through here). */
  captureDependencies?: Parameters<typeof startCapture>[1];
}

export interface Daemon {
  socketPath: string;
  readerUrl: string;
  readerToken: string;
  stop(): Promise<void>;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(socketPath: string) {
    super(`a slipstream daemon is already running at ${socketPath}`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

type DaemonState = 'detached' | 'attaching' | 'active' | 'detaching' | 'wedged';

const PROBE_TIMEOUT_MS = 1000;

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Classify who, if anyone, holds a control socket that failed to bind. */
function probeSocket(socketPath: string, timeoutMs: number): Promise<'live' | 'stale' | 'ambiguous'> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    const cleanup = () => { clearTimeout(timer); sock.removeAllListeners(); sock.destroy(); };
    const timer = setTimeout(() => { cleanup(); resolve('ambiguous'); }, timeoutMs);
    sock.on('connect', () => { cleanup(); resolve('live'); });
    sock.on('error', () => { cleanup(); resolve('stale'); });
  });
}

async function bindControl(server: Server, socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => { server.off('listening', onListening); reject(err); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(socketPath);
      });
      await chmod(socketPath, 0o600); // owner-only; the parent dir was already asserted 0700
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === 1) throw err;
      const verdict = await probeSocket(socketPath, PROBE_TIMEOUT_MS);
      if (verdict === 'live') throw new DaemonAlreadyRunningError(socketPath);
      if (verdict === 'ambiguous') {
        throw new Error(
          `control socket ${socketPath} is unresponsive; refusing to start (a paused daemon may still own it). Remove it manually only if you are sure no daemon is running.`,
        );
      }
      // Stale: reclaim ONLY an actual socket file, never a regular file or directory
      // squatting the path — deleting an arbitrary object would be a data-loss bug.
      const st = await lstat(socketPath);
      if (!st.isSocket()) {
        throw new Error(`refusing to remove non-socket object at control path ${socketPath}`);
      }
      await unlink(socketPath);
      // loop: retry listen on the freed path
    }
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const storeDir = opts.storeDir;
  const socketPath = opts.socketPath ?? join(storeDir, 'control.sock');

  await mkdirpDurable(storeDir);
  await assertOwnerOnly(storeDir, 'dir');

  let compromised = false;
  let lock: SessionLock;
  try {
    lock = await acquireSessionLock(storeDir, {
      onCompromised: (reason) => {
        compromised = true;
        console.error(`slipstream daemon: store lock lost: ${reason}`);
        void teardown();
      },
    });
  } catch (err) {
    if (err instanceof SessionOwnedError) throw new DaemonAlreadyRunningError(socketPath);
    throw err;
  }

  const registry = createBoundaryRegistry();

  // Per-session state. This PR carries exactly one active capture at a time.
  let state: DaemonState = 'detached';
  let current: { id: string; session: CaptureSession } | undefined;
  let admitting = false; // whether begin_task may start new work on `current`
  const inflightTasks = new Set<Promise<unknown>>();

  const server = createServer((sock) => handleConnection(sock));

  try {
    await bindControl(server, socketPath);
  } catch (err) {
    await lock.release();
    throw err;
  }

  let reader: ReaderServer;
  try {
    reader = await startReaderServer({ storeDir, registry });
  } catch (err) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => {});
    await lock.release();
    throw err;
  }

  let torn = false;
  async function teardown(): Promise<void> {
    if (torn) return;
    torn = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (current) {
      await current.session.stop().catch(() => {});
      current = undefined;
    }
    await reader.close().catch(() => {});
    await lock.release();
    await unlink(socketPath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }

  function statusFields(): Record<string, unknown> {
    const fields: Record<string, unknown> = { state, reader_url: reader.url };
    if (current) {
      fields.session_id = current.id;
      fields.durable_seq = current.session.health.snapshot().durable_seq;
    }
    return fields;
  }

  async function attach(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (!nonEmptyString(req.worktree) || !nonEmptyString(req.harness) || !nonEmptyString(req.harness_session_id)) {
      // Structural fail-closed identity gate (honesty): an ambiguous or partial
      // identity refuses attachment rather than guessing. Semantic verification
      // that the declared harness is a live real process is the P4 forwarder's job.
      return errFields('IDENTITY_UNRESOLVED', 'attach requires non-empty worktree, harness, and harness_session_id');
    }
    if (state !== 'detached') {
      if (state === 'active') return errFields('SESSION_ACTIVE', 'a session is already attached; detach it first');
      return errFields('CAPTURE_NOT_READY', `cannot attach while ${state}`);
    }
    // Set attaching BEFORE the first await so a concurrent attach is refused.
    state = 'attaching';
    const id = randomUUID();
    // Reserve the registry entry (boundary 0) before startCapture creates the log
    // dir on disk, so the reader never over-publishes an uncommitted record from a
    // session that momentarily appears on disk mid-startup.
    registry.reserve(id);
    let session: CaptureSession;
    try {
      session = await startCapture({ root: req.worktree, storeDir, sessionId: id }, opts.captureDependencies);
    } catch (err) {
      // Freeze at the last-known durable boundary (0 — capture never activated);
      // never delete the entry, which would let the reader fall back to disk for a
      // session that failed mid-write.
      registry.freeze(id, 0n);
      state = 'detached';
      if (err instanceof StorageError) return errFields('STORAGE_UNAVAILABLE', err.message);
      return errFields('CAPTURE_NOT_READY', (err as Error).message);
    }
    registry.activate(id, liveBoundary(session.health));
    current = { id, session };
    admitting = true;
    state = 'active';
    return { session_id: id };
  }

  async function detach(): Promise<Record<string, unknown> | ErrorFields> {
    if (state !== 'active' || !current) {
      return errFields('SESSION_NOT_SELECTED', 'no active session to detach');
    }
    const { id, session } = current;
    state = 'detaching';
    admitting = false; // close admission synchronously; in-flight tasks still settle
    await Promise.allSettled([...inflightTasks]);
    let stopErr: unknown;
    try {
      await session.stop();
    } catch (err) {
      stopErr = err;
    }
    // Pin the reader at the final durable seq the session reached (honest even if
    // stop() failed — health still holds the last durable value).
    registry.freeze(id, BigInt(session.health.snapshot().durable_seq));
    current = undefined;
    if (stopErr) {
      state = 'wedged'; // fail closed: never claim a clean detach or admit new capture
      return errFields('STORAGE_UNAVAILABLE', `detach did not stop cleanly: ${(stopErr as Error).message}`);
    }
    state = 'detached';
    return { session_id: id };
  }

  async function beginTask(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (state !== 'active' || !current) {
      if (state === 'attaching') return errFields('CAPTURE_NOT_READY', 'capture is still starting');
      return errFields('SESSION_NOT_SELECTED', 'no active session');
    }
    if (!admitting) return errFields('CAPTURE_NOT_READY', 'capture is detaching');
    const { id, session } = current;
    if (req.session_id !== undefined && req.session_id !== id) {
      // The optional target guards a retry after detach+attach-B from misrouting to
      // a different session than the caller declared.
      return errFields('SESSION_NOT_SELECTED', `session_id ${String(req.session_id)} is not the selected session`);
    }
    if (!nonEmptyString(req.title)) return errFields('INVALID_TITLE', 'begin_task requires a non-empty title');
    if (!nonEmptyString(req.request_id)) return errFields('CAPTURE_NOT_READY', 'begin_task requires a non-empty request_id');
    // Start the append synchronously (no await before add) so a concurrent detach
    // sees this task in flight and drains it.
    const promise = session.beginTask({ title: req.title, requestId: req.request_id });
    inflightTasks.add(promise);
    try {
      const result = await promise;
      return {
        session_id: result.session_id,
        task_id: result.task_id,
        event_id: result.event_id,
        seq: result.seq,
      };
    } catch (err) {
      if (err instanceof InvalidTitleError) return errFields('INVALID_TITLE', err.message);
      if (err instanceof StorageError) return errFields('STORAGE_UNAVAILABLE', err.message);
      return errFields('CAPTURE_NOT_READY', (err as Error).message);
    } finally {
      inflightTasks.delete(promise);
    }
  }

  async function dispatch(req: RequestEnvelope): Promise<ResponseEnvelope> {
    const id = req.id;
    if (compromised) return { v: 1, id, ok: false, code: 'STORAGE_UNAVAILABLE', message: 'daemon lost its store lock' };
    let outcome: Record<string, unknown> | ErrorFields;
    switch (req.verb) {
      case 'status': outcome = statusFields(); break;
      case 'attach': outcome = await attach(req); break;
      case 'detach': outcome = await detach(); break;
      case 'begin_task': outcome = await beginTask(req); break;
      default: return { v: 1, id, ok: false, code: 'PROTOCOL', message: `unknown verb: ${String(req.verb)}` };
    }
    if (isErrorFields(outcome)) return { v: 1, id, ok: false, code: outcome.code, message: outcome.message };
    return { v: 1, id, ok: true, ...outcome };
  }

  function handleConnection(sock: Socket): void {
    const decoder = createLineDecoder();
    let handled = false;
    const answer = (res: ResponseEnvelope) => { if (!sock.destroyed) sock.end(encodeMessage(res)); };
    sock.on('data', (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        if (!handled) { handled = true; answer({ v: 1, ok: false, code: 'PROTOCOL', message: (err as Error).message }); }
        return;
      }
      if (handled || messages.length === 0) return;
      handled = true;
      const req = messages[0];
      if (typeof req !== 'object' || req === null || typeof (req as RequestEnvelope).verb !== 'string') {
        answer({ v: 1, ok: false, code: 'PROTOCOL', message: 'malformed control request' });
        return;
      }
      void dispatch(req as RequestEnvelope).then(answer).catch((err) => {
        answer({ v: 1, id: (req as RequestEnvelope).id, ok: false, code: 'STORAGE_UNAVAILABLE', message: (err as Error).message });
      });
    });
    sock.on('error', () => sock.destroy());
  }

  return {
    socketPath,
    readerUrl: reader.url,
    readerToken: reader.token,
    stop: teardown,
  };
}

interface ErrorFields { __error: true; code: ControlErrorCode; message: string }
function errFields(code: ControlErrorCode, message: string): ErrorFields {
  return { __error: true, code, message };
}
function isErrorFields(v: Record<string, unknown> | ErrorFields): v is ErrorFields {
  return (v as ErrorFields).__error === true;
}
