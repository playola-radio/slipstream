import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmod, lstat, unlink, realpath } from 'node:fs/promises';
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
  /** The shared store root (e.g. `~/.slipstream`). The control socket always lives
   * at `<storeDir>/control.sock`; the store dir is asserted owner-only (0700), so
   * the socket's parent is protected without a separate check. */
  storeDir: string;
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
/** A connection must deliver one complete control request within this window;
 * otherwise it is dropped so it can never wedge shutdown. */
const REQUEST_TIMEOUT_MS = 10_000;

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Classify who, if anyone, holds a control socket that failed to bind. Only a
 * refused connection or a missing path proves the socket is stale and reclaimable;
 * every other error (EACCES, EMFILE, ...) is ambiguous and must fail closed, since
 * it does not prove the owner is dead (locked design, decision 4). */
function probeSocket(socketPath: string, timeoutMs: number): Promise<'live' | 'stale' | 'ambiguous'> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    const cleanup = () => { clearTimeout(timer); sock.removeAllListeners(); sock.destroy(); };
    const timer = setTimeout(() => { cleanup(); resolve('ambiguous'); }, timeoutMs);
    sock.on('connect', () => { cleanup(); resolve('live'); });
    sock.on('error', (err) => {
      cleanup();
      const code = (err as NodeJS.ErrnoException).code;
      resolve(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'stale' : 'ambiguous');
    });
  });
}

async function bindControl(server: Server, socketPath: string): Promise<void> {
  const listenOnce = () =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => { server.off('listening', onListening); reject(err); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(socketPath);
    });
  const closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await listenOnce();
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
      continue; // retry listen on the freed path
    }
    // Listening succeeded. Lock down permissions; if that fails, do not leak the
    // listener — close it before surfacing the error.
    try {
      await chmod(socketPath, 0o600); // owner-only; the parent dir was already asserted 0700
    } catch (err) {
      await closeServer();
      throw err;
    }
    return;
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const storeDir = opts.storeDir;
  const socketPath = join(storeDir, 'control.sock');

  await mkdirpDurable(storeDir);
  await assertOwnerOnly(storeDir, 'dir');

  // Everything teardown touches is declared before the store lock is acquired, so
  // an onCompromised callback that fires mid-startup never hits a temporal dead
  // zone (it may run with `reader` still undefined — teardown null-checks it).
  const registry = createBoundaryRegistry();
  let state: DaemonState = 'detached';
  let current:
    | { id: string; session: CaptureSession; worktree: string; harness: string; harnessSessionId: string }
    | undefined;
  const inflightTasks = new Set<Promise<unknown>>();
  const connections = new Set<Socket>();
  let attachInFlight: Promise<unknown> | undefined;
  let reader: ReaderServer | undefined;
  let torn = false;
  let compromised = false; // store lock lost
  let sessionCompromised = false; // current session lock lost mid-attach

  // Created without a connection handler: the listener is attached only once
  // startup is fully ready (reader running, lock held, not torn). A control verb
  // can therefore never dispatch during the bind/chmod window, when the reader
  // reference is not yet initialized and a store-lock compromise could orphan it.
  const server = createServer();
  const closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));

  /** Remove OUR control socket. Only ever called on the normal teardown path, while
   * the store lock is still held, so no successor can have bound the path; the
   * isSocket() guard is a belt-and-braces check against an unrelated file. On the
   * compromise path the caller skips this entirely (ownership is already lost). */
  async function unlinkOwnSocket(): Promise<void> {
    try {
      const st = await lstat(socketPath);
      if (st.isSocket()) await unlink(socketPath);
    } catch {
      // best-effort cleanup; the path is gone or unreadable, nothing more to do
    }
  }

  // Memoized so repeated stop() calls (and a compromise firing mid-shutdown) await
  // the one in-flight teardown instead of returning early while it is still running.
  let teardownPromise: Promise<void> | undefined;
  function teardown(): Promise<void> {
    return (teardownPromise ??= doTeardown());
  }

  async function doTeardown(): Promise<void> {
    torn = true;
    // Drop live control connections so server.close() cannot block on an idle or
    // half-sent request.
    for (const sock of connections) sock.destroy();
    await closeServer();
    // An attach whose capture is still starting must not outlive shutdown: wait for
    // it to settle (it self-stops once it observes `torn`), then stop whatever it or
    // an active session left installed.
    if (attachInFlight) await attachInFlight.catch(() => {});
    let stopErr: unknown;
    if (current) {
      // Do NOT swallow a failed stop: if capture could not be confirmed stopped,
      // shutdown must not report success. session.stop() still releases the session
      // lock and halts the engine even when it rethrows, so releasing the store
      // lock below is safe; we surface the failure once cleanup is complete.
      try {
        await current.session.stop();
      } catch (err) {
        stopErr = err;
      }
      current = undefined;
    }
    await reader?.close().catch(() => {});
    // Unlink the socket only while we still hold the store lock. On the compromise
    // path the lock is already lost, so a successor may have bound the path — an
    // isSocket() check proves type, not ownership, so deleting it could remove the
    // successor's socket. Leave it for the new owner instead.
    if (!compromised) await unlinkOwnSocket();
    await lock.release();
    if (stopErr) throw stopErr;
  }

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

  // Bring the reader up before accepting control traffic, so a verb can never be
  // dispatched against a reader that is not yet serving the public view.
  try {
    reader = await startReaderServer({ storeDir, registry });
  } catch (err) {
    await lock.release();
    throw err;
  }

  // A store-lock compromise during startReaderServer() already ran teardown while
  // `reader` was still undefined, so teardown could not close this server. Close it
  // here and abort before binding the control listener, so no listener leaks.
  if (torn || compromised) {
    await reader.close().catch(() => {});
    await lock.release().catch(() => {});
    throw new Error('slipstream daemon lost its store lock during startup');
  }

  try {
    await bindControl(server, socketPath);
  } catch (err) {
    await reader.close().catch(() => {});
    await lock.release();
    throw err;
  }

  // A compromise that landed during startup already triggered teardown; honor it
  // rather than handing back a daemon that is shutting down.
  if (torn || compromised) {
    await teardown();
    throw new Error('slipstream daemon lost its store lock during startup');
  }

  const readerRef = reader;

  function statusFields(): Record<string, unknown> {
    const fields: Record<string, unknown> = { state, reader_url: readerRef.url };
    if (current) {
      // session_id is capture SCOPE, never authorship. The declared identity is the
      // exact context the caller bound; semantic verification is the P4 forwarder's.
      fields.session_id = current.id;
      fields.worktree = current.worktree;
      fields.harness = current.harness;
      fields.harness_session_id = current.harnessSessionId;
      fields.durable_seq = current.session.health.snapshot().durable_seq;
    }
    return fields;
  }

  /** The active session lost its own lock. Stop presenting healthy, preserve the
   * boundary at the last durable seq, and refuse further mutations (decision 9).
   * `current` is retained so teardown can still stop the wedged session. */
  function handleSessionCompromise(id: string, reason: string): void {
    console.error(`slipstream daemon: session ${id} lost its lock: ${reason}`);
    if (current?.id === id && state === 'active') {
      registry.freeze(id, BigInt(current.session.health.snapshot().durable_seq));
      state = 'wedged';
      return;
    }
    if (state === 'attaching') sessionCompromised = true; // startup aborts below
  }

  async function startAndActivate(
    id: string,
    worktree: string,
    harness: string,
    harnessSessionId: string,
  ): Promise<Record<string, unknown> | ErrorFields> {
    let session: CaptureSession;
    let resolvedWorktree: string;
    try {
      // Canonicalize before binding: capture resolves the root with realpath, so a
      // symlinked or relative declared path must report the same durable root in
      // status rather than the caller's raw string (locked design, decision 5).
      resolvedWorktree = await realpath(worktree);
      session = await startCapture(
        { root: resolvedWorktree, storeDir, sessionId: id, onCompromised: (reason) => handleSessionCompromise(id, reason) },
        opts.captureDependencies,
      );
    } catch (err) {
      // Freeze at boundary 0 (capture never activated); never delete the entry,
      // which would let the reader fall back to disk for a half-written session.
      registry.freeze(id, 0n);
      if (state === 'attaching') state = 'detached';
      if (err instanceof StorageError) return errFields('STORAGE_UNAVAILABLE', err.message);
      return errFields('CAPTURE_NOT_READY', (err as Error).message);
    }
    if (torn || compromised || sessionCompromised || state !== 'attaching') {
      // Shutdown, store-lock loss, or a session compromise arrived while capture was
      // starting: do not publish this session. Stop it and hold the boundary.
      await session.stop().catch(() => {});
      registry.freeze(id, BigInt(session.health.snapshot().durable_seq));
      if (state === 'attaching') state = 'detached';
      return errFields('STORAGE_UNAVAILABLE', 'daemon could not complete the attach');
    }
    registry.activate(id, liveBoundary(session.health));
    current = { id, session, worktree: resolvedWorktree, harness, harnessSessionId };
    state = 'active';
    return { session_id: id };
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
      if (state === 'wedged') return errFields('STORAGE_UNAVAILABLE', 'daemon is wedged; restart it');
      return errFields('CAPTURE_NOT_READY', `cannot attach while ${state}`);
    }
    // Set attaching BEFORE the first await so a concurrent attach is refused.
    state = 'attaching';
    sessionCompromised = false;
    const id = randomUUID();
    // Reserve the registry entry (boundary 0) before startCapture creates the log
    // dir on disk, so the reader never over-publishes an uncommitted record from a
    // session that momentarily appears on disk mid-startup.
    registry.reserve(id);
    const p = startAndActivate(id, req.worktree, req.harness, req.harness_session_id);
    attachInFlight = p;
    try {
      return await p;
    } finally {
      if (attachInFlight === p) attachInFlight = undefined;
    }
  }

  async function detach(): Promise<Record<string, unknown> | ErrorFields> {
    if (state !== 'active' || !current) {
      return errFields('SESSION_NOT_SELECTED', 'no active session to detach');
    }
    const { id, session } = current;
    state = 'detaching'; // close admission synchronously; in-flight tasks still settle
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
    if (stopErr) {
      // Fail closed: never claim a clean detach or admit new capture. Retain
      // `current` so teardown can still attempt to release the session's resources.
      state = 'wedged';
      return errFields('STORAGE_UNAVAILABLE', `detach did not stop cleanly: ${(stopErr as Error).message}`);
    }
    current = undefined;
    state = 'detached';
    return { session_id: id };
  }

  async function beginTask(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (state === 'wedged') return errFields('STORAGE_UNAVAILABLE', 'capture is wedged; its storage is no longer trustworthy');
    if (state !== 'active' || !current) {
      if (state === 'attaching') return errFields('CAPTURE_NOT_READY', 'capture is still starting');
      if (state === 'detaching') return errFields('CAPTURE_NOT_READY', 'capture is detaching');
      return errFields('SESSION_NOT_SELECTED', 'no active session');
    }
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
    if (compromised) return { v: 1, ok: false, code: 'STORAGE_UNAVAILABLE', message: 'daemon lost its store lock' };
    let outcome: Record<string, unknown> | ErrorFields;
    switch (req.verb) {
      case 'status': outcome = statusFields(); break;
      case 'attach': outcome = await attach(req); break;
      case 'detach': outcome = await detach(); break;
      case 'begin_task': outcome = await beginTask(req); break;
      default: return { v: 1, ok: false, code: 'PROTOCOL', message: `unknown verb: ${String(req.verb)}` };
    }
    if (isErrorFields(outcome)) return { v: 1, ok: false, code: outcome.code, message: outcome.message };
    return { v: 1, ok: true, ...outcome };
  }

  function handleConnection(sock: Socket): void {
    connections.add(sock);
    const decoder = createLineDecoder();
    let handled = false;
    const answer = (res: ResponseEnvelope) => {
      handled = true;
      if (!sock.destroyed) sock.end(encodeMessage(res));
    };
    const deadline = setTimeout(() => { if (!handled) sock.destroy(); }, REQUEST_TIMEOUT_MS);

    sock.on('data', (chunk: Buffer) => {
      if (handled) return; // one request per connection: stop feeding the decoder
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        answer({ v: 1, ok: false, code: 'PROTOCOL', message: (err as Error).message });
        return;
      }
      if (messages.length === 0) return;
      handled = true; // one request per connection; ignore anything further
      const req = messages[0];
      if (typeof req !== 'object' || req === null || typeof (req as RequestEnvelope).verb !== 'string') {
        answer({ v: 1, ok: false, code: 'PROTOCOL', message: 'malformed control request' });
        return;
      }
      if ((req as { v?: unknown }).v !== 1) {
        // Reject an unknown protocol version before any mutation runs; a v:999 or a
        // missing version must never execute and return a v1 success.
        answer({ v: 1, ok: false, code: 'PROTOCOL', message: `unsupported control protocol version: ${String((req as { v?: unknown }).v)}` });
        return;
      }
      void dispatch(req as RequestEnvelope).then(answer).catch((err) => {
        answer({ v: 1, ok: false, code: 'STORAGE_UNAVAILABLE', message: (err as Error).message });
      });
    });
    sock.on('end', () => {
      if (handled) return;
      // Peer finished sending: an unterminated final frame is a fault, not a
      // silent drop.
      try {
        decoder.end();
      } catch (err) {
        answer({ v: 1, ok: false, code: 'PROTOCOL', message: (err as Error).message });
      }
    });
    sock.on('error', () => sock.destroy());
    sock.on('close', () => { clearTimeout(deadline); connections.delete(sock); });
  }

  // Startup is fully ready: reader running, lock held, not torn, readerRef bound.
  // Only now start dispatching control traffic (see createServer above).
  server.on('connection', handleConnection);

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
