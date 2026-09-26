import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmod, lstat, unlink, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { startCapture, InvalidTitleError, type CaptureSession, type TranscriptRuntime } from './session.ts';
import { QuestionError } from './questions.ts';
import { verifyClaudeRootTranscript } from './claude-root-transcript.ts';
import type { ResolvedConfig } from './config.ts';
import type { HarnessName } from './event.ts';
import { StorageError, mkdirpDurable, assertOwnerOnly } from './storage.ts';
import { acquireSessionLock, SessionOwnedError, type SessionLock } from './lock.ts';
import { startReaderServer, type ReaderServer } from './http-reader.ts';
import { isValidSessionId, listSessions } from './store-reader.ts';
import {
  publishTombstone,
  removeSessionHistory,
  sessionExists,
  reclaimUnreferencedBlobs,
} from './maintenance.ts';
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
 * It speaks the PRIVATE control protocol (attach / detach / status / begin_task /
 * delete_session / gc). Every verb WRITES public events, maintains the store, or
 * reports state; none reads or serves the feed — readers get the feed through the
 * public HTTP view like any other client. There is no privileged back channel for
 * reading. delete_session and gc are DETACHED-ONLY: they run only when no capture
 * is active and never while a session is attaching or detaching.
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
  /** Allows an identity-path resolution race to be exercised deterministically. */
  identityRealpath?: (path: string) => Promise<string>;
  /** The resolved enrichment + transcript config (Fork 4). Absent means built-in
   * defaults: no harness is `configured`, so no transcript is read. */
  config?: ResolvedConfig;
}

const HARNESSES: readonly HarnessName[] = ['claude-code', 'codex'];
const SUPPORTED_CODEX_VERSIONS = new Set(['0.154.0', '0.155.1']);
const MAX_CODEX_META_BYTES = 64 * 1024;

class RootIdentityError extends Error {}

/** Verify the selected transcript's own first record once at attach. It binds
 * the reported session and worktree without treating either as authorship. */
async function verifyCodexRootTranscript(path: string, sessionId: string, worktree: string): Promise<void> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      if (!(await handle.stat()).isFile()) throw new Error('transcript is not a file');
      const buffer = Buffer.alloc(MAX_CODEX_META_BYTES + 1);
      let total = 0; let end = -1;
      while (total < buffer.length && end < 0) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        end = buffer.subarray(total, total + bytesRead).indexOf(0x0a);
        if (end >= 0) end += total;
        total += bytesRead;
      }
      if (end < 0 || end > MAX_CODEX_META_BYTES) throw new Error('transcript metadata exceeds limit');
      bytes = buffer.subarray(0, end);
    } finally { await handle.close(); }
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (record.type !== 'session_meta' || !payload
      || payload.originator !== 'codex_sdk_ts'
      || (payload.source !== 'exec' && payload.source !== 'vscode')
      || !SUPPORTED_CODEX_VERSIONS.has(String(payload.cli_version))
      || payload.session_id !== sessionId || typeof payload.cwd !== 'string'
      || await realpath(payload.cwd) !== worktree) throw new Error('transcript metadata does not match selected root');
  } catch { throw new RootIdentityError('root Codex transcript is missing, mismatched, or from an unsupported runtime'); }
}

/** Build the per-session transcript runtime from resolved config: only harnesses
 * the operator declared `configured` are read. */
function transcriptRuntimeFrom(config: ResolvedConfig | undefined): TranscriptRuntime | undefined {
  if (!config) return undefined;
  const harnesses = HARNESSES.filter((h) => config.policy.sources[h] === 'configured');
  if (harnesses.length === 0) return undefined;
  return {
    harnesses,
    homes: config.transcript.homes,
    codexScanLimit: config.transcript.codexScanLimit,
  };
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

export const PROBE_TIMEOUT_MS = 1000;
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
export function probeSocket(socketPath: string, timeoutMs: number): Promise<'live' | 'stale' | 'ambiguous'> {
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
  const identityRealpath = opts.identityRealpath ?? realpath;
  const socketPath = join(storeDir, 'control.sock');

  await mkdirpDurable(storeDir);
  await assertOwnerOnly(storeDir, 'dir');

  // Guard the store lock's stale-reclaim against a paused-but-live owner: a lock
  // unrefreshed for STALE_MS is reclaimable even if its owner is only paused, and
  // reclaiming it makes that owner shut down when it resumes. The control socket
  // distinguishes a paused owner (still answers via the listen backlog) from a
  // dead one (connection refused). Probe before we can reclaim; abort without
  // touching the lock if a daemon still answers.
  const startupVerdict = await probeSocket(socketPath, PROBE_TIMEOUT_MS);
  if (startupVerdict === 'live') throw new DaemonAlreadyRunningError(socketPath);
  if (startupVerdict === 'ambiguous') {
    throw new Error(
      `control socket ${socketPath} is unresponsive; refusing to start (a paused daemon may still own it). Remove it manually only if you are sure no daemon is running.`,
    );
  }
  // 'stale' (connection refused / socket absent): no live daemon; the store lock's
  // own stale logic and bindControl may proceed.

  // Everything teardown touches is declared before the store lock is acquired, so
  // an onCompromised callback that fires mid-startup never hits a temporal dead
  // zone (it may run with `reader` still undefined — teardown null-checks it).
  const registry = createBoundaryRegistry();
  let state: DaemonState = 'detached';
  let current:
    | { id: string; session: CaptureSession; worktree: string; harness: string; harnessSessionId: string; rootTranscript?: string }
    | undefined;
  const inflightTasks = new Set<Promise<unknown>>();
  const connections = new Set<Socket>();
  let attachInFlight: Promise<unknown> | undefined;
  // At most one detached-only maintenance op (delete_session / gc) runs at a time.
  // The slot is claimed synchronously in runMaintenance before its first await, and
  // attach refuses while it is held — so a single-threaded turn makes maintenance
  // and attach mutually exclusive without a lock.
  let maintenanceInFlight: Promise<unknown> | undefined;
  let reader: ReaderServer | undefined;
  let torn = false;
  let compromised = false; // store lock lost
  let sessionCompromised = false; // current session lock lost mid-attach
  let abortStopError: unknown; // a failed stop of a session aborted mid-attach
  // Gates DISPATCH, not acceptance: connections are tracked and given a deadline
  // from the moment they arrive (so bind/chmod-window sockets can never orphan or
  // hang shutdown), but no verb runs until startup is fully ready — which is also
  // when `readerRef` is initialized, so an early request can never hit its TDZ.
  let ready = false;

  const server = createServer((sock) => handleConnection(sock));
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
    // A maintenance op in flight has already seen `torn` (gc aborts its sweep); wait
    // for it to settle so a durable tombstone or blob unlink is not racing shutdown.
    if (maintenanceInFlight) await maintenanceInFlight.catch(() => {});
    // An attach aborted mid-startup may have failed to stop its half-built session
    // (it runs in startAndActivate, which sets abortStopError). Surface that too so
    // shutdown never reports success over a capture that could not be confirmed
    // stopped.
    let stopErr: unknown = abortStopError;
    if (current) {
      // Drain in-flight task declarations before stopping, exactly like detach:
      // `torn` is already set, so beginTask admits no new work, and the append of
      // any task that slipped in before shutdown must not race the session log
      // closing under session.stop().
      await Promise.allSettled([...inflightTasks]);
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
        void teardown().catch((teardownErr) => {
          console.error('slipstream daemon: teardown after store-lock loss failed:', teardownErr);
        });
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
  // rather than handing back a daemon that is shutting down. bindControl may have
  // (re)bound the listener AFTER teardown ran — e.g. a compromise during its
  // stale-socket probe, when the server was not yet listening for teardown to
  // close — so close the listener explicitly here before awaiting the memoized
  // teardown, which would otherwise no-op and leak it.
  if (torn || compromised) {
    // Destroy tracked connections before the explicit close: one accepted after
    // teardown's own destruction sweep (e.g. during this retry's chmod window)
    // could otherwise keep closeServer()'s promise from resolving if its peer
    // holds the send side open, hanging startup rejection indefinitely.
    for (const sock of connections) sock.destroy();
    await closeServer();
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
      if (current.rootTranscript) fields.root_transcript = current.rootTranscript;
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
    rootTranscript?: string,
  ): Promise<Record<string, unknown> | ErrorFields> {
    let session: CaptureSession;
    let resolvedWorktree: string;
    let resolvedTranscript: string | undefined;
    try {
      // Canonicalize before binding: capture resolves the root with realpath, so a
      // symlinked or relative declared path must report the same durable root in
      // status rather than the caller's raw string (locked design, decision 5).
      resolvedWorktree = await realpath(worktree);
      if (rootTranscript !== undefined) {
        if (harness !== 'codex' && harness !== 'claude-code') {
          throw new RootIdentityError('root_transcript requires a supported harness');
        }
        try { resolvedTranscript = await realpath(rootTranscript); }
        catch {
          throw new RootIdentityError(harness === 'claude-code'
            ? 'root Claude transcript is unavailable; check its path or retry attach after the first root tool call'
            : 'root Codex transcript cannot be resolved');
        }
        if (harness === 'codex') {
          await verifyCodexRootTranscript(resolvedTranscript, harnessSessionId, resolvedWorktree);
        } else {
          const verified = await verifyClaudeRootTranscript(resolvedTranscript, harnessSessionId, resolvedWorktree);
          if (!verified.ok) {
            throw new RootIdentityError(verified.reason === 'not-yet'
              ? 'root Claude transcript has no complete identity yet; retry attach after the first root tool call'
              : verified.reason === 'gap'
                ? 'root Claude transcript head exceeds the verification bounds; select a new root early in its session'
                : `root Claude transcript identity is ${verified.reason}`);
          }
        }
      }
      const transcript = transcriptRuntimeFrom(opts.config);
      session = await startCapture(
        {
          root: resolvedWorktree,
          storeDir,
          sessionId: id,
          onCompromised: (reason) => handleSessionCompromise(id, reason),
          ...(opts.config ? { enrichmentPolicy: opts.config.policy } : {}),
          ...(transcript ? { transcript } : {}),
        },
        opts.captureDependencies,
      );
    } catch (err) {
      // Freeze at boundary 0 (capture never activated); never delete the entry,
      // which would let the reader fall back to disk for a half-written session.
      registry.freeze(id, 0n);
      if (state === 'attaching') state = 'detached';
      if (err instanceof StorageError) return errFields('STORAGE_UNAVAILABLE', err.message);
      if (err instanceof RootIdentityError) return errFields('IDENTITY_UNRESOLVED', err.message);
      return errFields('CAPTURE_NOT_READY', (err as Error).message);
    }
    if (torn || compromised || sessionCompromised || state !== 'attaching') {
      // Shutdown, store-lock loss, or a session compromise arrived while capture was
      // starting: do not publish this session. Stop it and hold the boundary. A
      // failed stop here is recorded (not swallowed) so teardown can surface it.
      try {
        await session.stop();
      } catch (err) {
        abortStopError ??= err;
      }
      registry.freeze(id, BigInt(session.health.snapshot().durable_seq));
      if (state === 'attaching') state = 'detached';
      return errFields('STORAGE_UNAVAILABLE', 'daemon could not complete the attach');
    }
    registry.activate(id, liveBoundary(session.health));
    current = { id, session, worktree: resolvedWorktree, harness, harnessSessionId, rootTranscript: resolvedTranscript };
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
    if (req.root_transcript !== undefined && !nonEmptyString(req.root_transcript)) {
      return errFields('IDENTITY_UNRESOLVED', 'root_transcript must be a non-empty existing path');
    }
    if (state !== 'detached') {
      if (state === 'active') return errFields('SESSION_ACTIVE', 'a session is already attached; detach it first');
      if (state === 'wedged') return errFields('STORAGE_UNAVAILABLE', 'daemon is wedged; restart it');
      return errFields('CAPTURE_NOT_READY', `cannot attach while ${state}`);
    }
    // Refuse to attach over an in-flight maintenance op. This check and the
    // `state === 'detached'` guard in runMaintenance are the two halves of the same
    // mutual exclusion: both are synchronous, so whichever claims its slot first in
    // this turn locks the other out. (Kept before `state = 'attaching'` so a refused
    // attach leaves the state machine untouched.)
    if (maintenanceInFlight) return errFields('CAPTURE_NOT_READY', 'a maintenance operation is running; retry shortly');
    // Set attaching BEFORE the first await so a concurrent attach is refused.
    state = 'attaching';
    sessionCompromised = false;
    const id = randomUUID();
    // Reserve the registry entry (boundary 0) before startCapture creates the log
    // dir on disk, so the reader never over-publishes an uncommitted record from a
    // session that momentarily appears on disk mid-startup.
    registry.reserve(id);
    const p = startAndActivate(id, req.worktree, req.harness, req.harness_session_id, req.root_transcript as string | undefined);
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
    if (req.session_id !== undefined && req.session_id !== current.id) {
      // The optional target guards a retry after detach+attach-B from misrouting to
      // a different session than the caller declared.
      return errFields('SESSION_NOT_SELECTED', `session_id ${String(req.session_id)} is not the selected session`);
    }
    // Selection guard (locked design, decision X): the caller ships its verified
    // identity triple and only the selected session's exact triple may declare.
    // The P4 forwarder always sends the triple; a missing one is a contract
    // violation, so fail closed rather than declare into whatever is selected.
    if (!nonEmptyString(req.harness) || !nonEmptyString(req.harness_session_id) || !nonEmptyString(req.worktree)) {
      return errFields('IDENTITY_UNRESOLVED', 'begin_task requires harness, harness_session_id, and worktree');
    }
    if (!nonEmptyString(req.title)) return errFields('INVALID_TITLE', 'begin_task requires a non-empty title');
    if (!nonEmptyString(req.request_id)) return errFields('CAPTURE_NOT_READY', 'begin_task requires a non-empty request_id');
    // Canonicalize the declared worktree with the SAME realpath policy as attach
    // (startAndActivate), so a symlinked or relative declared path matches the
    // durable root capture actually watches.
    let declaredWorktree: string;
    try {
      declaredWorktree = await realpath(req.worktree);
    } catch {
      declaredWorktree = req.worktree; // an unresolvable path cannot match the canonical root
    }
    // Re-verify selection AFTER the realpath await: a concurrent detach, teardown,
    // or store-lock loss may have changed state or swapped the session while we
    // canonicalized. From here through inflightTasks.add there is no await, so
    // neither a detach nor a teardown can slip between these checks and the append
    // (they either observe the task in flight and drain it, or are observed here).
    // Teardown fails closed without touching `state`, so check `torn`/`compromised`
    // explicitly — otherwise a request could append after the daemon has already
    // begun shutting down or lost its store lock.
    if (compromised || torn) {
      return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    }
    if (state !== 'active' || !current) {
      return errFields('SESSION_NOT_SELECTED', 'the selected session changed before the declaration committed');
    }
    // Re-apply the optional session_id target guard after the await, exactly like
    // the pre-await check: a concurrent detach+attach may have swapped in a session
    // sharing the triple, and a request explicitly addressed to the prior session
    // must not commit into its replacement.
    if (req.session_id !== undefined && req.session_id !== current.id) {
      return errFields('SESSION_NOT_SELECTED', `session_id ${String(req.session_id)} is not the selected session`);
    }
    if (
      req.harness !== current.harness ||
      req.harness_session_id !== current.harnessSessionId ||
      declaredWorktree !== current.worktree
    ) {
      return errFields('SESSION_NOT_SELECTED', 'the declared identity is not the selected session');
    }
    const { session } = current;
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

  /** Queue a question on the selected capture. `askQuestion` installs its own
   * request reservation synchronously; install the daemon-level lifetime promise
   * in the same turn so detach and shutdown drain source reads and appends. */
  async function ask(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'daemon storage ownership is unavailable');
    if (state === 'wedged') return errFields('STORAGE_UNAVAILABLE', 'capture is wedged; its storage is no longer trustworthy');
    if (state !== 'active' || !current) {
      if (state === 'attaching' || state === 'detaching') return errFields('CAPTURE_NOT_READY', 'capture is not ready to accept questions');
      return errFields('SESSION_NOT_SELECTED', 'no active session');
    }
    if (current.harness !== 'claude-code' && current.harness !== 'codex') {
      return errFields('SESSION_NOT_SELECTED', 'the selected capture has no supported question target');
    }
    // No await may appear before this call and registration: detach/shutdown must
    // see any source verification admitted before they change state.
    const binding = current;
    const { session, harness, harnessSessionId, worktree } = binding;
    const promise = session.askQuestion(req, {
      harness: harness as HarnessName,
      harness_session_id: harnessSessionId,
      worktree,
    }, () => {
      if (compromised || sessionCompromised || current !== binding) {
        throw new QuestionError('STORAGE_UNAVAILABLE', 'the selected capture lost storage ownership');
      }
    });
    inflightTasks.add(promise);
    try {
      const result = await promise;
      return { ...result };
    } catch (err) {
      if (err instanceof QuestionError) return errFields(err.code, err.message);
      if (err instanceof StorageError) return errFields('STORAGE_UNAVAILABLE', err.message);
      return errFields('CAPTURE_NOT_READY', (err as Error).message);
    } finally {
      inflightTasks.delete(promise);
    }
  }

  async function claimQuestion(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (compromised || torn || state === 'wedged') return errFields('STORAGE_UNAVAILABLE', 'capture storage is unavailable');
    if (state !== 'active' || !current) return errFields('SESSION_NOT_SELECTED', 'no active capture');
    if ((current.harness !== 'codex' && current.harness !== 'claude-code')
      || !current.rootTranscript || req.harness !== current.harness
      || !nonEmptyString(req.harness_session_id) || !nonEmptyString(req.worktree)
      || !nonEmptyString(req.transcript_path)
      || Object.hasOwn(req, 'agent_id') || Object.hasOwn(req, 'agent_type')) {
      return errFields('IDENTITY_UNRESOLVED', 'unsupported or incomplete root identity');
    }
    const binding = current;
    let worktree: string; let transcript: string;
    try { [worktree, transcript] = await Promise.all([identityRealpath(req.worktree), identityRealpath(req.transcript_path)]); }
    catch { return errFields('IDENTITY_UNRESOLVED', 'identity path cannot be resolved'); }
    if (compromised || torn || sessionCompromised || state !== 'active' || current !== binding
      || req.harness_session_id !== binding.harnessSessionId
      || worktree !== binding.worktree || transcript !== binding.rootTranscript) {
      return errFields('SESSION_NOT_SELECTED', 'the callback is not the selected root session');
    }
    const promise = binding.session.claimQuestion({ harness: binding.harness as HarnessName, harness_session_id: binding.harnessSessionId,
      worktree: binding.worktree }, () => {
      if (compromised || sessionCompromised || current !== binding) {
        throw new QuestionError('STORAGE_UNAVAILABLE', 'the selected capture lost storage ownership');
      }
    });
    inflightTasks.add(promise);
    try {
      const result = await promise;
      return result === null ? { question: null } : { question: result };
    } catch (err) {
      if (err instanceof QuestionError) return errFields(err.code, err.message);
      if (err instanceof StorageError) return errFields('STORAGE_UNAVAILABLE', err.message);
      return errFields('CAPTURE_NOT_READY', (err as Error).message);
    } finally { inflightTasks.delete(promise); }
  }

  /** Admit and run a detached-only maintenance op. Admission is synchronous through
   * claiming `maintenanceInFlight`, so it cannot interleave with attach (which sets
   * `state` synchronously and refuses while the slot is held). The op runs only in
   * `detached`; anything else — an active/attaching/detaching session, a wedged or
   * compromised store, an op already running — is refused without touching disk. */
  async function runMaintenance(
    op: () => Promise<Record<string, unknown> | ErrorFields>,
  ): Promise<Record<string, unknown> | ErrorFields> {
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    if (state !== 'detached') {
      // A capture in any stage — attaching, active, or detaching — is SESSION_ACTIVE;
      // CAPTURE_NOT_READY is reserved for the maintenance-slot contention below.
      if (state === 'wedged') return errFields('STORAGE_UNAVAILABLE', 'daemon is wedged; restart it');
      return errFields('SESSION_ACTIVE', `a capture session is ${state}; detach it before deleting or collecting`);
    }
    if (maintenanceInFlight) return errFields('CAPTURE_NOT_READY', 'another maintenance operation is running; retry shortly');
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    maintenanceInFlight = slot;
    try {
      return await op();
    } finally {
      release();
      if (maintenanceInFlight === slot) maintenanceInFlight = undefined;
    }
  }

  async function deleteSession(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    // Validate the id shape before admission: it names an on-disk path, so a
    // malformed or traversing id is a protocol fault, never a lookup miss.
    if (!nonEmptyString(req.session_id) || !isValidSessionId(req.session_id)) {
      return errFields('PROTOCOL', 'delete_session requires a valid session_id');
    }
    const id = req.session_id;
    return runMaintenance(async () => {
      let present: boolean;
      try {
        present = await sessionExists(storeDir, id);
      } catch (err) {
        return errFields('STORAGE_UNAVAILABLE', (err as Error).message);
      }
      if (!present) return errFields('SESSION_NOT_FOUND', `no session ${id} to delete`);
      // Durable-tombstone-first: publish the marker (fsynced) BEFORE removing any
      // history, so a crash in between leaves a session the reader already serves as
      // gone and a later gc finishes the cleanup. Nothing is committed yet, so a
      // failure here is a plain STORAGE_UNAVAILABLE — no rollback needed.
      try {
        await publishTombstone(storeDir, id);
      } catch (err) {
        return errFields('STORAGE_UNAVAILABLE', `could not durably record deletion of ${id}: ${(err as Error).message}`);
      }
      // Now that the tombstone is durable, abort any in-flight follower of this
      // session so it re-resolves, re-reads the tombstone, and gets 410 rather than
      // streaming a log we are about to delete. The reader's installIfAbsent gives a
      // followed retained session a registry entry this freeze can reach.
      registry.freeze(id, 0n);
      // The tombstone is durable → the session is logically removed and the marker is
      // never rolled back. If we have since lost the store lock, or history cleanup
      // fails, report that removal committed and cleanup is retryable via gc.
      const committed = `session ${id} is logically removed (tombstone durable); history cleanup is retryable via gc`;
      if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', committed);
      try {
        await removeSessionHistory(storeDir, id);
      } catch (err) {
        return errFields('STORAGE_UNAVAILABLE', `${committed}: ${(err as Error).message}`);
      }
      return { session_id: id };
    });
  }

  async function gc(): Promise<Record<string, unknown> | ErrorFields> {
    return runMaintenance(async () => {
      try {
        // Finish any interrupted deletion first: a session tombstoned by a
        // delete_session that crashed before cleanup still carries residual history.
        // Re-establish the tombstone's durability, invalidate any follower a partial
        // delete left pinned, then complete the removal — the same publish -> freeze
        // -> remove sequence delete_session runs. Stop before any mutation if we lose
        // the store lock: a successor now owns this store's files.
        for (const s of await listSessions(storeDir)) {
          if (!s.removed) continue;
          if (compromised || torn) {
            throw new StorageError('gc-aborted', new Error('store ownership lost mid-cleanup'));
          }
          await publishTombstone(storeDir, s.id);
          registry.freeze(s.id, 0n);
          await removeSessionHistory(storeDir, s.id);
        }
        // Abort mid-sweep if we lose the store lock: a successor may then own the
        // shared blobs, and deleting one it still references would be data loss.
        const removed = await reclaimUnreferencedBlobs(storeDir, () => torn || compromised);
        return { removed };
      } catch (err) {
        // A corrupt/missing retained log or an aborted sweep deletes nothing; report
        // the store as unavailable rather than a partial success.
        return errFields('STORAGE_UNAVAILABLE', (err as Error).message);
      }
    });
  }

  async function dispatch(req: RequestEnvelope): Promise<ResponseEnvelope> {
    if (compromised) return { v: 1, ok: false, code: 'STORAGE_UNAVAILABLE', message: 'daemon lost its store lock' };
    let outcome: Record<string, unknown> | ErrorFields;
    switch (req.verb) {
      case 'status': outcome = statusFields(); break;
      case 'attach': outcome = await attach(req); break;
      case 'detach': outcome = await detach(); break;
      case 'begin_task': outcome = await beginTask(req); break;
      case 'ask': outcome = await ask(req); break;
      case 'claim_question': outcome = await claimQuestion(req); break;
      case 'delete_session': outcome = await deleteSession(req); break;
      case 'gc': outcome = await gc(); break;
      default: return { v: 1, ok: false, code: 'PROTOCOL', message: `unknown verb: ${String(req.verb)}` };
    }
    if (isErrorFields(outcome)) return { v: 1, ok: false, code: outcome.code, message: outcome.message };
    return { v: 1, ok: true, ...outcome };
  }

  function handleConnection(sock: Socket): void {
    if (torn) {
      // Shutting down: never take on a new connection that could linger and block
      // server.close(); drop it so the client sees a closed connection and retries.
      sock.destroy();
      return;
    }
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
      if (!ready) {
        // A request that arrived during the bind/chmod window, before startup
        // finished. Do not dispatch (the reader reference is not yet bound); answer
        // a retryable error rather than orphaning the connection.
        answer({ v: 1, ok: false, code: 'CAPTURE_NOT_READY', message: 'daemon is still starting' });
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
  // Only now let the connection handler dispatch verbs (see the `ready` gate).
  ready = true;

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
