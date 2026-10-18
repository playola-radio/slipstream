import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmod, lstat, unlink, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { startCapture, InvalidTitleError, type CaptureSession, type TranscriptRuntime } from './session.ts';
import { QuestionError, assertAnswerText } from './questions.ts';
import { verifyClaudeRootTranscript } from './claude-root-transcript.ts';
import { verifyCodexRootTranscript } from './codex-root-transcript.ts';
import type { ResolvedConfig } from './config.ts';
import type { HarnessName } from './event.ts';
import { StorageError, mkdirpDurable, assertOwnerOnly } from './storage.ts';
import { acquireSessionLock, SessionOwnedError, type SessionLock } from './lock.ts';
import { startReaderServer, type ReaderServer } from './http-reader.ts';
import { isValidSessionId, listSessions, findWorkspaceSession, WorkspaceLookupError } from './store-reader.ts';
import { CorruptLogError } from './recovery.ts';
import { LogCorruptError } from './log-reader.ts';
import {
  publishTombstone,
  removeSessionHistory,
  sessionExists,
  reclaimUnreferencedBlobs,
} from './maintenance.ts';
import { createBoundaryRegistry } from './boundary-registry.ts';
import { createCas, type Cas } from './cas.ts';
import {
  MAX_BINDINGS, MAX_CAPTURES, admitCapture, emptyIntent, findCapture, findLinked, forgetSession, linkBinding, linkedCount,
  revokeBinding, withdrawCapture, type NotRecordingReason,
} from './capture-intent.ts';
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
 * a table of up to MAX_CAPTURES concurrent captures (one per canonical root), the
 * chats linked to them, and the boundary registry that keeps the reader honest as
 * captures start and stop beneath it.
 *
 * It speaks the PRIVATE control protocol (attach / detach / unlink / status /
 * begin_task / ask / claim_question / answer_question / delete_session / gc). Every
 * verb WRITES public events, maintains the store, or reports state; none reads or
 * serves the feed — readers get the feed through the public HTTP view like any
 * other client. There is no privileged back channel for reading. delete_session
 * and gc run only while no capture intent exists and no capture is stopping.
 *
 * Captures are isolated from each other: one capture's failed baseline, lost
 * session lock or watcher error marks only that capture not recording.
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
  /** Allows an attach's workspace lookup to be held deterministically. */
  workspaceLookup?: typeof findWorkspaceSession;
  /** The resolved enrichment + transcript config (Fork 4). Absent means built-in
   * defaults: no harness is `configured`, so no transcript is read. */
  config?: ResolvedConfig;
}

const HARNESSES: readonly HarnessName[] = ['claude-code', 'codex'];
class RootIdentityError extends Error {}

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

/** Readiness of a linked chat. The check id is private: only the linked root's
 * tool-use callback receives it, so its return through the answer tool proves both
 * delivery and answer return. A new id is armed per binding generation and per
 * activation, so an old check can never confirm a newer link. */
interface AgentCheck {
  state: 'setup_pending' | 'connected';
  checkId: string;
  /** Delivered once per arm; a repeated attach re-arms a pending check. */
  delivered: boolean;
  ack?: Record<string, unknown>;
  confirming?: Promise<Record<string, unknown> | ErrorFields>;
}

interface Binding {
  harness: HarnessName;
  harnessSessionId: string;
  transcript: string;
  generation: string;
  check: AgentCheck;
  /** Set until `agent.binding` and `setup_pending` are durable; hooks and
   * forwarders do not see the binding before then. */
  publishing?: Promise<ErrorFields | undefined>;
}

/** One start of a capture. A lock-loss callback acts only on the activation that
 * registered it, never on a later one. */
interface Activation { session?: CaptureSession; lost: boolean }

/** A capture's runtime. Its intent (running / waiting / withdrawn, last failure)
 * lives in the intent record; this holds what only the live daemon knows. */
interface Capture {
  id: string;
  root: string;
  /** `queued` covers both waiting for a slot and waiting for the baseline slot;
   * the intent tells them apart. */
  lifecycle: 'queued' | 'baselining' | 'recording' | 'failed' | 'stopping' | 'stopped';
  /** The session has history on disk to resume. */
  resume: boolean;
  session?: CaptureSession;
  activation?: Activation;
  /** The pending start job while queued for or holding the baseline slot. */
  starting?: Promise<void>;
  /** A stop in flight (detach, or a halt after lock loss). */
  closing?: Promise<void>;
  closeError?: unknown;
  binding?: Binding;
  inflight: Set<Promise<unknown>>;
}

const CAPTURE_LIMIT_MESSAGE = `${MAX_CAPTURES}/${MAX_CAPTURES} capture slots in use. This workspace is NOT recording. `
  + 'It starts automatically when another workspace is archived or detached.';
const BINDING_LIMIT_MESSAGE = `${MAX_BINDINGS}/${MAX_BINDINGS} chats linked. This workspace is still recording without `
  + 'a linked chat. Unlink another chat to connect this one.';
const WATCH_ONLY_MESSAGE = 'this capture is watch-only: no agent chat is linked to it. Run `slipstream attach` from '
  + 'the agent chat to link one';
const SETUP_PENDING_MESSAGE = 'the agent chat for this capture has not completed setup; finish the steps slipstream '
  + 'attach printed';

function isHarness(v: unknown): v is HarnessName {
  return (HARNESSES as readonly unknown[]).includes(v);
}

/** One root contains the other, by whole path components. */
function overlaps(a: string, b: string): boolean {
  const within = (child: string, parent: string) => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  return within(a, b) || within(b, a);
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const storeDir = opts.storeDir;
  const identityRealpath = opts.identityRealpath ?? realpath;
  const workspaceLookup = opts.workspaceLookup ?? findWorkspaceSession;
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
  const intent = emptyIntent();
  /** Every capture this daemon has admitted, by session id; withdrawn ones stay
   * for history until their session is deleted. */
  const captures = new Map<string, Capture>();
  /** Roots between their canonicalization and their intent write. A second attach
   * of the same root joins the first instead of admitting a duplicate. */
  const admitting = new Map<string, Promise<Admitted | ErrorFields>>();
  /** Baselines run one at a time, in admission order. */
  let baselines: Promise<void> = Promise.resolve();
  /** The store's blob store, shared by every capture (see CaptureOptions.cas).
   * Recreated after maintenance, which may delete blobs it trusts. */
  let cas: Cas | undefined;
  const connections = new Set<Socket>();
  // At most one maintenance op (delete_session / gc) runs at a time, and only
  // while the captures it affects are not live. The slot is claimed synchronously in
  // runMaintenance before its first await, and admission refuses while it is
  // held — so a single-threaded turn makes them mutually exclusive without a lock.
  let maintenanceInFlight: Promise<unknown> | undefined;
  let reader: ReaderServer | undefined;
  let torn = false;
  let compromised = false; // store lock lost
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
    // Admissions and baselines in flight observe `torn` and start nothing new; wait
    // for them so every session they opened is in the table and stopped below.
    await Promise.allSettled([...admitting.values()]);
    await baselines;
    // A maintenance op in flight has already seen `torn` (gc aborts its sweep); wait
    // for it to settle so a durable tombstone or blob unlink is not racing shutdown.
    if (maintenanceInFlight) await maintenanceInFlight.catch(() => {});
    let stopErr: unknown;
    for (const c of captures.values()) {
      await c.closing;
      const session = c.session;
      if (!session) continue;
      // Drain admitted appends before stopping: `torn` is already set, so no new
      // work is admitted, and an append in flight must not race the log closing.
      await Promise.allSettled([...c.inflight]);
      // Do NOT swallow a failed stop: if capture could not be confirmed stopped,
      // shutdown must not report success. session.stop() still releases the session
      // lock and halts the engine even when it rethrows, so releasing the store
      // lock below is safe; we surface the failure once cleanup is complete. No
      // stop reason: shutdown is not a withdrawal, so no capture.stopped is written.
      try {
        await session.stop();
      } catch (err) {
        stopErr ??= err;
      }
      c.session = undefined;
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
    reader = await startReaderServer({ storeDir, registry, captures: capturesProjection });
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

  // ---- capture state ------------------------------------------------------

  /** The public state of a capture (contracts.md §6), folded from its intent and
   * its runtime. A withdrawn capture is `stopped` only once its stop is durable. */
  function publicState(c: Capture): { state: string; reason: string | null; message?: string } {
    const entry = findCapture(intent, c.id);
    if (!entry || entry.intent === 'withdrawn') {
      return c.lifecycle === 'stopped' ? { state: 'stopped', reason: entry?.withdrawn_reason ?? 'detached' }
        : { state: 'not_recording', reason: 'stop-unconfirmed', message: 'detach was requested, but the capture could not be confirmed stopped' };
    }
    if (entry.intent === 'waiting') return { state: 'not_recording', reason: 'capture-limit-reached', message: CAPTURE_LIMIT_MESSAGE };
    if (entry.last_failure) return { state: 'not_recording', reason: entry.last_failure.reason, message: entry.last_failure.message };
    if (c.lifecycle === 'recording' || c.lifecycle === 'baselining') return { state: c.lifecycle, reason: null };
    return { state: 'queued', reason: null };
  }

  function isRunning(c: Capture): boolean {
    return findCapture(intent, c.id)?.intent === 'running';
  }

  function isLive(c: Capture): boolean {
    const entry = findCapture(intent, c.id);
    return entry !== undefined && entry.intent !== 'withdrawn';
  }

  /** The latest binding intent for a capture, linked or revoked. */
  function bindingRow(c: Capture): Record<string, unknown> | null {
    const entry = intent.bindings.findLast((b) => b.session_id === c.id);
    if (!entry) return null;
    const live = entry.intent === 'linked' ? c.binding : undefined;
    return {
      harness: entry.harness, harness_session_id: entry.harness_session_id, binding_generation: entry.binding_generation,
      state: entry.intent === 'revoked' ? 'unlinked' : live?.check.state ?? 'setup_pending', reason: null,
    };
  }

  function statusRow(c: Capture): Record<string, unknown> {
    const { state, reason, message } = publicState(c);
    const row: Record<string, unknown> = { session_id: c.id, root: c.root, state, reason, capture_mode: 'watch-only' };
    if (message) row.message = message;
    if (c.session) row.durable_seq = c.session.health.snapshot().durable_seq;
    row.binding = bindingRow(c);
    if (c.binding) row.binding = { ...row.binding as object, root_transcript: c.binding.transcript };
    return row;
  }

  /** `GET /v1/captures` (contracts.md §9). Heartbeats are read from the session
   * ownership locks, exactly as an offline client would. */
  async function capturesProjection(): Promise<Record<string, unknown>> {
    const asOf = Date.now();
    const rows = await Promise.all([...captures.values()].map(async (c) => {
      const { state, reason } = publicState(c);
      let heartbeat: number | null = null;
      try { heartbeat = Math.trunc((await stat(join(storeDir, 'sessions', c.id, 'owner.lock'))).mtimeMs); } catch { /* no owner */ }
      return { session_id: c.id, root: c.root, state, reason, retry: null, capture_mode: 'watch-only', heartbeat_ms: heartbeat,
        binding: bindingRow(c) };
    }));
    return { as_of_ms: asOf, binding_slots: { used: linkedCount(intent), limit: MAX_BINDINGS }, captures: rows };
  }

  function statusFields(): Record<string, unknown> {
    return {
      reader_url: readerRef.url, attach_features: ['agent-connection-v1', 'capture-table-v1'],
      binding_slots: { used: linkedCount(intent), limit: MAX_BINDINGS },
      captures: [...captures.values()].map(statusRow),
    };
  }

  async function status(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (req.target === undefined) return statusFields();
    const c = await resolveTarget(req.target);
    if (isErrorFields(c)) return c;
    return { reader_url: readerRef.url, attach_features: ['agent-connection-v1', 'capture-table-v1'], capture: statusRow(c) };
  }

  /** A target is a session id or a root path. The id is authoritative; a path
   * matches a stored canonical root by realpath equality, or literally when it can
   * no longer be resolved, never by prefix. */
  async function resolveTarget(target: unknown): Promise<Capture | ErrorFields> {
    if (!nonEmptyString(target)) return errFields('TARGET_NOT_FOUND', 'a target session id or workspace path is required');
    const byId = captures.get(target);
    if (byId) return byId;
    let root: string;
    try { root = await realpath(target); } catch { root = target; }
    const atRoot = [...captures.values()].filter((c) => c.root === root);
    const found = atRoot.find(isLive) ?? atRoot.at(-1);
    return found ?? errFields('TARGET_NOT_FOUND', `no capture of ${target}`);
  }

  function liveCaptureAt(root: string): Capture | undefined {
    return [...captures.values()].find((c) => c.root === root && isLive(c));
  }

  /** The capture a chat identity is linked to, store-wide (at most one). */
  function captureForChat(harness: unknown, harnessSessionId: unknown): Capture | undefined {
    const entry = typeof harness === 'string' && typeof harnessSessionId === 'string'
      ? findLinked(intent, harness, harnessSessionId) : undefined;
    return entry ? captures.get(entry.session_id) : undefined;
  }

  function fail(c: Capture, reason: NotRecordingReason, message: string): void {
    c.lifecycle = 'failed';
    const entry = findCapture(intent, c.id);
    if (entry) entry.last_failure = { reason, message, at_ms: Date.now(), next_attempt_at_ms: null };
    console.error(`slipstream daemon: capture ${c.id} of ${c.root} is not recording: ${message}`);
  }

  // ---- admission ----------------------------------------------------------

  interface Admitted { capture: Capture; created: boolean }

  /** Find or admit the capture of a canonical root. */
  async function admit(root: string): Promise<Admitted | ErrorFields> {
    if (torn || compromised) return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    const live = liveCaptureAt(root);
    if (live) return retryIfFailed(live);
    const pending = admitting.get(root);
    if (pending) {
      const joined = await pending;
      return isErrorFields(joined) ? joined : { capture: joined.capture, created: false };
    }
    const other = [...[...captures.values()].filter(isLive).map((c) => c.root), ...admitting.keys()]
      .find((r) => overlaps(r, root));
    if (other) {
      return errFields('ROOT_OVERLAP', `${root} overlaps the capture of ${other}: one contains the other. Nothing was changed`);
    }
    // Admission and maintenance exclude each other: both claim their slot in the
    // same synchronous turn as this check.
    if (maintenanceInFlight) return errFields('CAPTURE_NOT_READY', 'a maintenance operation is running; retry shortly');
    const p = admitNew(root);
    admitting.set(root, p);
    try {
      return await p;
    } finally {
      admitting.delete(root);
    }
  }

  async function admitNew(root: string): Promise<Admitted | ErrorFields> {
    let lookup;
    try {
      lookup = await workspaceLookup(storeDir, root);
    } catch (err) {
      if (err instanceof WorkspaceLookupError) {
        const remedy = err.corrupt ? corruptRemedy(err.sessionId) : RETRY_REMEDY;
        return errFields('SESSION_RESUME_FAILED', `${err.message}. ${remedy}`);
      }
      return errFields('STORAGE_UNAVAILABLE', `could not look up this workspace's session: ${(err as Error).message}`);
    }
    for (const s of lookup.skipped) {
      console.error(`slipstream daemon: skipped session ${s.id} while looking for ${root}'s session: ${s.reason}`);
    }
    const id = lookup.match?.id ?? randomUUID();
    // A detach of this same session may still be stopping it; its lock must be
    // released before the session can start again.
    const prior = captures.get(id);
    await prior?.closing;
    let rootIdentity: { dev: string; ino: string } | null = null;
    try {
      const st = await stat(root, { bigint: true });
      rootIdentity = { dev: st.dev.toString(), ino: st.ino.toString() };
    } catch { /* recorded as unknown */ }
    if (torn || compromised) {
      if (lookup.match) {
        return errFields('SESSION_RESUME_FAILED', `could not resume session ${id}: the daemon is shutting down or lost its store lock. ${RETRY_REMEDY}`);
      }
      return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    }
    if (lookup.match) {
      // Pin the boundary at the durable high-water BEFORE the log can grow, and
      // hold it until activation: readers never see past it mid-resume.
      registry.freeze(id, registry.get(id)?.boundary.current() ?? lookup.match.durableSeq);
    } else {
      // Reserve the registry entry (boundary 0) before startCapture creates the log
      // dir on disk, so the reader never over-publishes an uncommitted record.
      registry.reserve(id);
    }
    const entry = admitCapture(intent, { session_id: id, root, root_identity: rootIdentity });
    const c: Capture = prior ?? { id, root, lifecycle: 'queued', resume: false, inflight: new Set() };
    Object.assign(c, { root, lifecycle: 'queued', resume: lookup.match !== undefined, closeError: undefined });
    captures.set(id, c);
    if (entry.intent === 'running') enqueueStart(c);
    return { capture: c, created: true };
  }

  /** Re-attaching a capture whose start or storage failed tries it again. */
  async function retryIfFailed(c: Capture): Promise<Admitted> {
    if (c.lifecycle !== 'failed') return { capture: c, created: false };
    await c.closing;
    const resume = c.resume || await sessionExists(storeDir, c.id).catch(() => false);
    const entry = findCapture(intent, c.id);
    if (c.lifecycle !== 'failed' || entry?.intent !== 'running' || torn || compromised) return { capture: c, created: false };
    entry.last_failure = null;
    c.lifecycle = 'queued';
    c.resume = resume;
    enqueueStart(c);
    return { capture: c, created: false };
  }

  function enqueueStart(c: Capture): void {
    const job = baselines.then(() => startOne(c)).catch((err) => {
      console.error(`slipstream daemon: capture ${c.id} start failed unexpectedly:`, err);
    });
    c.starting = job;
    baselines = job;
  }

  /** Start (or resume) one capture. Never rejects: a failure is recorded on the
   * capture, and the other captures are untouched. */
  async function startOne(c: Capture): Promise<void> {
    if (torn || compromised || c.lifecycle !== 'queued' || !isRunning(c)) return;
    c.lifecycle = 'baselining';
    const activation: Activation = { lost: false };
    c.activation = activation;
    let session: CaptureSession;
    try {
      cas ??= await createCas(join(storeDir, 'blobs'));
      session = await startCapture(
        {
          root: c.root,
          storeDir,
          ...(c.resume ? { resumeSessionId: c.id } : { sessionId: c.id }),
          captureMode: 'watch-only',
          cas,
          onCompromised: (reason) => onSessionLockLost(c, activation, reason),
          ...(opts.config ? { enrichmentPolicy: opts.config.policy } : {}),
        },
        opts.captureDependencies,
      );
    } catch (err) {
      // A fresh session never activated: freeze at 0, never delete the entry, so
      // the reader cannot fall back to disk for a half-written log. A resumed
      // session keeps the boundary pinned at its pre-resume high-water.
      if (!c.resume) registry.freeze(c.id, 0n);
      if (activation.lost || c.lifecycle !== 'baselining') return;
      if (c.resume) {
        const remedy = err instanceof CorruptLogError || err instanceof LogCorruptError ? corruptRemedy(c.id) : RETRY_REMEDY;
        fail(c, 'resume-failed', `could not resume session ${c.id}: ${(err as Error).message}. ${remedy}`);
      } else {
        fail(c, err instanceof StorageError ? 'storage-unavailable' : 'baseline-failed', (err as Error).message);
      }
      return;
    }
    activation.session = session;
    c.session = session;
    c.resume = true;
    if (activation.lost) {
      halt(c, session);
      return;
    }
    // Shutdown or a detach arrived while starting: whoever is stopping it owns the
    // session now.
    if (torn || compromised || c.lifecycle !== 'baselining') return;
    c.lifecycle = 'recording';
    registry.activate(c.id, liveBoundary(session.health));
    registry.setAgentConnection(c.id, 'none');
    // A chat stays linked across a restart of its capture, but `connected` is
    // re-earned only by a fresh round trip in the new activation.
    if (c.binding) {
      const b = c.binding;
      b.check = { state: 'setup_pending', checkId: randomUUID(), delivered: false };
      const rearm = publishBinding(c, b, false);
      c.inflight.add(rearm);
      void rearm.finally(() => c.inflight.delete(rearm));
    }
  }

  function onSessionLockLost(c: Capture, activation: Activation, reason: string): void {
    console.error(`slipstream daemon: session ${c.id} lost its lock: ${reason}`);
    if (c.activation !== activation || activation.lost) return;
    activation.lost = true;
    fail(c, 'storage-unavailable', `capture lost its session lock: ${reason}`);
    if (activation.session) halt(c, activation.session);
  }

  /** Stop a capture whose storage can no longer be trusted, without recording a
   * stop it cannot make durable. Its boundary stays at the last durable seq. */
  function halt(c: Capture, session: CaptureSession): void {
    registry.freeze(c.id, BigInt(session.health.snapshot().durable_seq));
    const prior = c.closing;
    c.closing = (async () => {
      await prior;
      await Promise.allSettled([...c.inflight]);
      try {
        await session.stop();
      } catch (err) {
        console.error(`slipstream daemon: session ${c.id} did not stop cleanly after losing its lock:`, err);
      }
      if (c.session === session) c.session = undefined;
    })();
  }

  // ---- attach / detach / unlink -------------------------------------------

  function admissionReply({ capture, created }: Admitted): Record<string, unknown> | ErrorFields {
    if (findCapture(intent, capture.id)?.intent === 'waiting') return errFields('CAPTURE_LIMIT_REACHED', CAPTURE_LIMIT_MESSAGE);
    const { state, reason, message } = publicState(capture);
    return { session_id: capture.id, state, reason, ...(message ? { message } : {}), created };
  }

  async function attachWatchOnly(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (!nonEmptyString(req.worktree)) return errFields('PROTOCOL', 'attach --watch-only requires a worktree');
    let root: string;
    try { root = await realpath(req.worktree); } catch (err) { return errFields('CAPTURE_NOT_READY', (err as Error).message); }
    const admitted = await admit(root);
    return isErrorFields(admitted) ? admitted : admissionReply(admitted);
  }

  /** Verify a root chat transcript names this chat in this worktree. */
  async function verifyRootTranscript(harness: HarnessName, harnessSessionId: string, root: string, path: string): Promise<string> {
    let resolved: string;
    try { resolved = await realpath(path); } catch {
      throw new RootIdentityError(harness === 'claude-code'
        ? 'root Claude transcript is unavailable; check its path or retry attach after the first root tool call'
        : 'root Codex transcript cannot be resolved');
    }
    if (harness === 'codex') {
      if (!await verifyCodexRootTranscript(resolved, harnessSessionId, root)) {
        throw new RootIdentityError('root Codex transcript is missing, mismatched, or from an unsupported runtime');
      }
      return resolved;
    }
    const verified = await verifyClaudeRootTranscript(resolved, harnessSessionId, root);
    if (!verified.ok) {
      throw new RootIdentityError(verified.reason === 'not-yet'
        ? 'root Claude transcript head is not complete yet; retry attach after the first root tool call'
        : verified.reason === 'gap'
          ? 'root Claude transcript head exceeds the verification bounds; select a new root early in its session'
          : `root Claude transcript identity is ${verified.reason}`);
    }
    return resolved;
  }

  /** Attach from a chat. The chat's transcript is verified first, so a chat that
   * cannot be linked records nothing. The workspace's capture is found or
   * admitted; once it is recording the chat is linked in place. */
  async function attachChat(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (!nonEmptyString(req.worktree) || !nonEmptyString(req.harness) || !nonEmptyString(req.harness_session_id)) {
      // Structural fail-closed identity gate (honesty): an ambiguous or partial
      // identity refuses attachment rather than guessing.
      return errFields('IDENTITY_UNRESOLVED', 'attach requires non-empty worktree, harness, and harness_session_id');
    }
    if (!nonEmptyString(req.root_transcript)) {
      return errFields('IDENTITY_UNRESOLVED', 'linking a chat requires its root transcript; to record this workspace '
        + 'without a chat, run `slipstream attach --watch-only`');
    }
    if (!isHarness(req.harness)) return errFields('IDENTITY_UNRESOLVED', 'root_transcript requires a supported harness');
    const harness = req.harness;
    const harnessSessionId = req.harness_session_id;
    let root: string;
    try { root = await realpath(req.worktree); } catch (err) { return errFields('CAPTURE_NOT_READY', (err as Error).message); }
    let transcript: string;
    try {
      transcript = await verifyRootTranscript(harness, harnessSessionId, root, req.root_transcript);
    } catch (err) {
      if (err instanceof RootIdentityError) return errFields('IDENTITY_UNRESOLVED', err.message);
      throw err;
    }
    const admitted = await admit(root);
    if (isErrorFields(admitted)) return admitted;
    const c = admitted.capture;
    if (c.lifecycle !== 'recording' || !isRunning(c)) return admissionReply(admitted);
    return link(c, { harness, harnessSessionId, transcript }, admitted.created);
  }

  function bindingExists(harness: string, harnessSessionId: string, c: Capture): ErrorFields {
    return errFields('BINDING_EXISTS', `${harness} chat ${harnessSessionId} is already linked to the capture of ${c.root} `
      + `(session ${c.id}). That link was kept. To link this chat here instead, run: slipstream unlink --session ${c.id}, `
      + 'then run slipstream attach again from this chat.');
  }

  function bindReply(c: Capture, b: Binding, extra: Record<string, unknown>): Record<string, unknown> {
    return { session_id: c.id, state: 'recording', binding_generation: b.generation, agent_connection: b.check.state, ...extra };
  }

  /** Link a chat to a recording capture in place: same session, no baseline, no
   * resume, no gap. The slot and identity are claimed synchronously, so the tenth
   * slot and a chat racing itself onto two captures each resolve to one link. */
  async function link(
    c: Capture,
    chat: { harness: HarnessName; harnessSessionId: string; transcript: string },
    created: boolean,
  ): Promise<Record<string, unknown> | ErrorFields> {
    const mine = c.binding;
    if (mine && mine.harness === chat.harness && mine.harnessSessionId === chat.harnessSessionId) {
      const failed = await mine.publishing;
      if (failed) return failed;
      if (c.binding !== mine) return errFields('CAPTURE_NOT_READY', 'the chat was unlinked while it was being linked; retry attach');
      if (mine.check.state === 'setup_pending') mine.check.delivered = false;
      return bindReply(c, mine, { already_active: true, created: false });
    }
    if (mine) return bindingExists(mine.harness, mine.harnessSessionId, c);
    const elsewhere = captureForChat(chat.harness, chat.harnessSessionId);
    if (elsewhere) return bindingExists(chat.harness, chat.harnessSessionId, elsewhere);
    if (linkedCount(intent) >= MAX_BINDINGS) return errFields('BINDING_LIMIT_REACHED', BINDING_LIMIT_MESSAGE);
    const entry = linkBinding(intent, {
      session_id: c.id, harness: chat.harness, harness_session_id: chat.harnessSessionId,
      canonical_worktree: c.root, verified_transcript_path: chat.transcript,
    });
    const b: Binding = { ...chat, generation: entry.binding_generation,
      check: { state: 'setup_pending', checkId: randomUUID(), delivered: false } };
    c.binding = b;
    const publishing = publishBinding(c, b, true);
    b.publishing = publishing;
    c.inflight.add(publishing);
    let failed: ErrorFields | undefined;
    try {
      failed = await publishing;
    } finally {
      c.inflight.delete(publishing);
      b.publishing = undefined;
    }
    return failed ?? bindReply(c, b, { created });
  }

  /** Append a binding's events in contract order, then publish it to hooks and
   * forwarders. A first link that cannot be recorded is revoked again. */
  async function publishBinding(c: Capture, b: Binding, first: boolean): Promise<ErrorFields | undefined> {
    const session = c.session!;
    const target = { harness: b.harness, harness_session_id: b.harnessSessionId };
    const own = (): void => {
      if (torn || compromised || c.binding !== b || c.lifecycle !== 'recording' || c.activation?.lost) {
        throw new QuestionError('STORAGE_UNAVAILABLE', 'the capture stopped or the chat was unlinked while it was being linked');
      }
    };
    let recorded = false;
    try {
      if (first) {
        await session.recordAgent({ type: 'slipstream.agent.binding.v1', occurred_at_ms: Date.now(), data: {
          binding_generation: b.generation, target: { ...target, worktree: c.root }, verified_transcript_path: b.transcript } }, own);
        recorded = true;
      }
      await session.recordAgent({ type: 'slipstream.agent.connection.v1', occurred_at_ms: Date.now(), data: {
        state: 'setup_pending', binding_generation: b.generation, target } }, own);
    } catch (err) {
      if (first && c.binding === b) {
        c.binding = undefined;
        revokeBinding(intent, c.id);
        // The log already says this chat is linked; say it no longer is.
        if (recorded) {
          await session.recordAgent({ type: 'slipstream.agent.unlinked.v1', occurred_at_ms: Date.now(),
            data: { binding_generation: b.generation, reason: 'unlinked' } }).catch(() => {});
        }
      }
      return controlFailure(err);
    }
    registry.setAgentConnection(c.id, 'setup_pending');
    const transcripts = transcriptRuntimeFrom(opts.config);
    if (transcripts) session.startTranscripts(transcripts);
    return undefined;
  }

  async function detach(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    const c = await resolveTarget(req.target);
    if (isErrorFields(c)) return c;
    if (torn || compromised) return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    const entry = findCapture(intent, c.id);
    if (entry && entry.intent !== 'withdrawn') {
      const promoted = withdrawCapture(intent, c.id, 'detached');
      if (promoted) {
        const next = captures.get(promoted.session_id);
        if (next) enqueueStart(next);
      }
      const prior = c.closing;
      c.closing = closeCapture(c, prior);
    }
    const already = entry?.intent === 'withdrawn' && c.lifecycle === 'stopped';
    await c.closing;
    if (c.closeError) {
      return errFields('STORAGE_UNAVAILABLE', `detach did not stop cleanly: ${(c.closeError as Error).message}`);
    }
    const { state, reason } = publicState(c);
    return { session_id: c.id, state, reason, ...(already ? { already_stopped: true } : {}) };
  }

  /** Stop a withdrawn capture: unlink its chat, then record the stop. */
  async function closeCapture(c: Capture, prior: Promise<void> | undefined): Promise<void> {
    const from = c.lifecycle;
    if (from === 'queued') {
      // Never activated: the start job sees the withdrawal and starts nothing.
      c.lifecycle = 'stopped';
      return;
    }
    c.lifecycle = 'stopping';
    if (from === 'baselining') await c.starting;
    await prior;
    await Promise.allSettled([...c.inflight]);
    const b = c.binding;
    if (b) {
      c.binding = undefined;
      revokeBinding(intent, c.id);
    }
    if (registry.get(c.id)) registry.setAgentConnection(c.id, 'none');
    const session = c.session;
    if (!session) {
      // Its storage failed earlier and it was halted without a durable stop.
      c.lifecycle = c.activation?.lost ? 'failed' : 'stopped';
      return;
    }
    c.session = undefined;
    try {
      await session.stop(b ? { reason: 'detached', unlinkGeneration: b.generation } : { reason: 'detached' });
      c.lifecycle = 'stopped';
    } catch (err) {
      c.closeError = err;
      c.lifecycle = 'failed';
    }
    // Pin the reader at the final durable seq (honest even if stop() failed).
    registry.freeze(c.id, BigInt(session.health.snapshot().durable_seq));
  }

  /** Revoke a capture's chat link; the capture keeps recording. */
  async function unlinkChat(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    const c = nonEmptyString(req.session_id) ? captures.get(req.session_id) : undefined;
    if (!c) return errFields('TARGET_NOT_FOUND', `no capture with session ${String(req.session_id)}`);
    if (torn || compromised) return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    await c.binding?.publishing;
    const b = c.binding;
    if (!b) return { session_id: c.id, already_unlinked: true };
    c.binding = undefined;
    revokeBinding(intent, c.id);
    if (registry.get(c.id)) registry.setAgentConnection(c.id, 'none');
    const session = c.session;
    if (!session || c.lifecycle !== 'recording') return { session_id: c.id, binding_generation: b.generation };
    const append = session.recordAgent({ type: 'slipstream.agent.unlinked.v1', occurred_at_ms: Date.now(),
      data: { binding_generation: b.generation, reason: 'unlinked' } });
    c.inflight.add(append);
    try {
      await append;
    } catch (err) {
      return errFields('STORAGE_UNAVAILABLE', `the chat was unlinked, but the unlink could not be recorded: ${(err as Error).message}`);
    } finally {
      c.inflight.delete(append);
    }
    return { session_id: c.id, binding_generation: b.generation };
  }

  // ---- chat-facing verbs --------------------------------------------------

  /** Ownership check run immediately before an append on a chat's behalf. A
   * stopping capture still accepts work it admitted: the stop drains it before
   * revoking the binding. */
  function owns(c: Capture, b: Binding): () => void {
    return () => {
      const live = c.lifecycle === 'recording' || c.lifecycle === 'stopping';
      if (compromised || torn || c.binding !== b || !live || c.activation?.lost) {
        throw new QuestionError('STORAGE_UNAVAILABLE', 'the selected capture lost storage ownership');
      }
    };
  }

  /** The chat's published binding and its capture, if it may act now. */
  function chatTarget(c: Capture | undefined): { c: Capture; b: Binding } | undefined {
    const b = c?.binding;
    return c && b && !b.publishing && c.lifecycle === 'recording' ? { c, b } : undefined;
  }

  /** The chat's binding when a request arrives. A request that awaits before it
   * acts must still find this same binding afterwards: an unlink and relink in
   * between is a different binding, even at the same capture. */
  function bindingAtEntry(req: RequestEnvelope): Binding | undefined {
    return captureForChat(req.harness, req.harness_session_id)?.binding;
  }

  function staleBinding(req: RequestEnvelope, c: Capture, b: Binding): ErrorFields | undefined {
    if (req.session_id !== undefined && req.session_id !== c.id) {
      return errFields('STALE_BINDING', `session_id ${String(req.session_id)} is not the capture this chat is linked to`);
    }
    if (req.binding_generation !== undefined && req.binding_generation !== b.generation) {
      return errFields('STALE_BINDING', `binding_generation ${String(req.binding_generation)} is no longer current`);
    }
    return undefined;
  }

  async function track<T>(c: Capture, promise: Promise<T>, ok: (v: T) => Record<string, unknown>): Promise<Record<string, unknown> | ErrorFields> {
    c.inflight.add(promise);
    try {
      return ok(await promise);
    } catch (err) {
      if (err instanceof InvalidTitleError) return errFields('INVALID_TITLE', err.message);
      return controlFailure(err);
    } finally {
      c.inflight.delete(promise);
    }
  }

  async function beginTask(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    // The caller ships its verified identity triple; a missing one is a contract
    // violation, so fail closed rather than declare into whatever is selected.
    if (!nonEmptyString(req.harness) || !nonEmptyString(req.harness_session_id) || !nonEmptyString(req.worktree)) {
      return errFields('IDENTITY_UNRESOLVED', 'begin_task requires harness, harness_session_id, and worktree');
    }
    if (!nonEmptyString(req.title)) return errFields('INVALID_TITLE', 'begin_task requires a non-empty title');
    if (!nonEmptyString(req.request_id)) return errFields('CAPTURE_NOT_READY', 'begin_task requires a non-empty request_id');
    // Canonicalize the declared worktree with the same realpath policy attach
    // uses, so a symlinked or relative declared path matches the capture's root.
    const atEntry = bindingAtEntry(req);
    let worktree: string;
    try { worktree = await identityRealpath(req.worktree); } catch { worktree = req.worktree; }
    // Everything below runs without an await until the append is admitted, so a
    // concurrent unlink or detach either sees it in flight or is seen here.
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    const linked = captureForChat(req.harness, req.harness_session_id);
    if (!linked || linked.root !== worktree) {
      const here = liveCaptureAt(worktree);
      if (here && !here.binding) return errFields('AGENT_NOT_CONNECTED', WATCH_ONLY_MESSAGE);
      return errFields('SESSION_NOT_SELECTED', `this chat is not linked to a capture of ${worktree}`);
    }
    if (linked.activation?.lost) return errFields('STORAGE_UNAVAILABLE', 'capture storage is no longer trustworthy');
    const target = chatTarget(linked);
    if (!target) return errFields('CAPTURE_NOT_READY', 'the linked capture is not recording yet');
    if (target.b !== atEntry) return errFields('SESSION_NOT_SELECTED', 'this chat was unlinked or relinked while the request was in flight');
    const { c, b } = target;
    const stale = staleBinding(req, c, b);
    if (stale) return stale;
    if (b.check.state !== 'connected') return errFields('AGENT_NOT_CONNECTED', SETUP_PENDING_MESSAGE);
    return track(c, c.session!.beginTask({ title: req.title, requestId: req.request_id }), (r) => ({
      session_id: r.session_id, task_id: r.task_id, event_id: r.event_id, seq: r.seq,
    }));
  }

  /** Queue a question on the capture the app names. `askQuestion` installs its own
   * request reservation synchronously; the daemon-level lifetime promise is
   * installed in the same turn so detach and shutdown drain it. */
  async function ask(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'daemon storage ownership is unavailable');
    const c = nonEmptyString(req.session_id) ? captures.get(req.session_id) : undefined;
    if (!c || !isLive(c)) return errFields('SESSION_NOT_SELECTED', 'no capture with that session id is running');
    if (c.activation?.lost) return errFields('STORAGE_UNAVAILABLE', 'capture storage is no longer trustworthy');
    if (!c.binding) return errFields('AGENT_NOT_CONNECTED', WATCH_ONLY_MESSAGE);
    if (req.binding_generation !== undefined && req.binding_generation !== c.binding.generation) {
      return errFields('STALE_BINDING', `binding_generation ${String(req.binding_generation)} is no longer current`);
    }
    if (c.lifecycle !== 'recording' || !isRunning(c)) return errFields('CAPTURE_NOT_READY', 'the capture is not recording yet');
    const target = chatTarget(c);
    if (!target) return errFields('AGENT_NOT_CONNECTED', SETUP_PENDING_MESSAGE);
    const { b } = target;
    if (b.check.state !== 'connected') return errFields('AGENT_NOT_CONNECTED', SETUP_PENDING_MESSAGE);
    return track(c, c.session!.askQuestion(req, {
      harness: b.harness, harness_session_id: b.harnessSessionId, worktree: c.root,
    }, owns(c, b)), (r) => ({ ...r }));
  }

  /** The question hook asks for this chat's next question (or its setup check).
   * Only a linked root chat may claim: subagents and other chats are refused. */
  async function claimQuestion(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'capture storage is unavailable');
    if (!isHarness(req.harness) || !nonEmptyString(req.harness_session_id) || !nonEmptyString(req.worktree)
      || !nonEmptyString(req.transcript_path)
      || Object.hasOwn(req, 'agent_id') || Object.hasOwn(req, 'agent_type')) {
      return errFields('IDENTITY_UNRESOLVED', 'unsupported or incomplete root identity');
    }
    const atEntry = bindingAtEntry(req);
    let worktree: string; let transcript: string;
    try { [worktree, transcript] = await Promise.all([identityRealpath(req.worktree), identityRealpath(req.transcript_path)]); }
    catch { return errFields('IDENTITY_UNRESOLVED', 'identity path cannot be resolved'); }
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'capture storage is unavailable');
    const linked = captureForChat(req.harness, req.harness_session_id);
    if (linked?.activation?.lost) return errFields('STORAGE_UNAVAILABLE', 'capture storage is no longer trustworthy');
    const target = chatTarget(linked);
    if (!target || target.b !== atEntry || target.c.root !== worktree || target.b.transcript !== transcript) {
      return errFields('SESSION_NOT_SELECTED', 'the callback is not a linked root chat');
    }
    const { c, b } = target;
    const stale = staleBinding(req, c, b);
    if (stale) return stale;
    if (b.check.state === 'setup_pending') {
      if (b.check.delivered) return { question: null };
      b.check.delivered = true;
      return { question: null, setup_check: { check_id: b.check.checkId } };
    }
    return track(c, c.session!.claimQuestion({ harness: b.harness, harness_session_id: b.harnessSessionId, worktree: c.root },
      owns(c, b)), (r) => (r === null ? { question: null } : { question: r }));
  }

  /** Record an answer returned through a linked chat's MCP tool. The caller's
   * identity routes it to that chat's capture; with no transcript or agent id this
   * proves the call came through the linked chat, not which agent in it wrote the
   * answer. A question queued for another chat is not found here. */
  async function answerQuestion(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (!nonEmptyString(req.harness) || !nonEmptyString(req.harness_session_id) || !nonEmptyString(req.worktree)) {
      return errFields('IDENTITY_UNRESOLVED', 'answer_question requires harness, harness_session_id, and worktree');
    }
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'capture storage is unavailable');
    const atEntry = bindingAtEntry(req);
    let worktree: string;
    try { worktree = await identityRealpath(req.worktree); } catch { worktree = req.worktree; }
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'capture storage is unavailable');
    const linked = captureForChat(req.harness, req.harness_session_id);
    if (linked?.activation?.lost) return errFields('STORAGE_UNAVAILABLE', 'capture storage is no longer trustworthy');
    const target = chatTarget(linked);
    if (!target || target.b !== atEntry || target.c.root !== worktree) return errFields('SESSION_NOT_SELECTED', 'the caller is not a linked chat');
    const { c, b } = target;
    const stale = staleBinding(req, c, b);
    if (stale) return stale;
    if (req.question_id === b.check.checkId) return confirmAgent(c, b, req.text);
    return track(c, c.session!.answerQuestion({ question_id: req.question_id, text: req.text },
      { harness: b.harness, harness_session_id: b.harnessSessionId, worktree: c.root }, owns(c, b)), (r) => ({ ...r }));
  }

  /** The linked chat returned its setup check: record it connected, once. */
  async function confirmAgent(c: Capture, b: Binding, text: unknown): Promise<Record<string, unknown> | ErrorFields> {
    const check = b.check;
    try { assertAnswerText(text); } catch (err) { return errFields((err as QuestionError).code, (err as Error).message); }
    if (check.ack) return { ...check.ack, duplicate: true };
    if (check.confirming) {
      const settled = await check.confirming;
      return isErrorFields(settled) ? settled : { ...settled, duplicate: true };
    }
    const promise = c.session!.recordAgent({ type: 'slipstream.agent.connection.v1', occurred_at_ms: Date.now(), data: {
      state: 'connected', binding_generation: b.generation, target: { harness: b.harness, harness_session_id: b.harnessSessionId } } },
    () => {
      owns(c, b)();
      if (b.check !== check) throw new QuestionError('STORAGE_UNAVAILABLE', 'the setup check was re-armed by a restart');
    }).then((event): Record<string, unknown> => {
      check.state = 'connected';
      registry.setAgentConnection(c.id, 'connected');
      check.ack = { session_id: event.data.session_id, question_id: check.checkId, event_id: event.seq, seq: event.seq,
        answered_at_ms: Date.parse(event.time), duplicate: false };
      return check.ack;
    }, controlFailure);
    check.confirming = promise;
    c.inflight.add(promise);
    try { return await promise; }
    finally { c.inflight.delete(promise); check.confirming = undefined; }
  }

  // ---- maintenance --------------------------------------------------------

  /** Admit and run a maintenance op while none of `affected` (by default every
   * capture) is live, starting or stopping. The slot is claimed synchronously
   * through `maintenanceInFlight`, so it cannot interleave with an admission. */
  async function runMaintenance(
    op: () => Promise<Record<string, unknown> | ErrorFields>,
    affected: (c: Capture) => boolean = () => true,
  ): Promise<Record<string, unknown> | ErrorFields> {
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    const busy = [...captures.values()].find((c) => affected(c) && (isLive(c) || c.session || c.lifecycle === 'stopping'));
    if (busy) {
      return errFields('SESSION_ACTIVE', `the capture of ${busy.root} (session ${busy.id}) is ${publicState(busy).state}; `
        + 'detach it first');
    }
    if (admitting.size > 0) return errFields('SESSION_ACTIVE', 'a capture is being admitted; retry once it settles');
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
      // Deletion removes the session's capture and binding entries (§8).
      forgetSession(intent, id);
      captures.delete(id);
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
    }, (c) => c.id === id);
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
        // The shared blob store trusts blobs it published, some of which this
        // sweep may delete: the next capture starts with a fresh instance.
        cas = undefined;
        const removed = await reclaimUnreferencedBlobs(storeDir, () => torn || compromised);
        return { removed };
      } catch (err) {
        // A corrupt/missing retained log or an aborted sweep deletes nothing; report
        // the store as unavailable rather than a partial success.
        return errFields('STORAGE_UNAVAILABLE', (err as Error).message);
      }
    });
  }

  async function attach(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (req.mode === 'watch-only') return attachWatchOnly(req);
    if (req.mode !== undefined) return errFields('PROTOCOL', `unknown attach mode: ${String(req.mode)}`);
    return attachChat(req);
  }

  async function dispatch(req: RequestEnvelope): Promise<ResponseEnvelope> {
    if (compromised) return { v: 1, ok: false, code: 'STORAGE_UNAVAILABLE', message: 'daemon lost its store lock' };
    let outcome: Record<string, unknown> | ErrorFields;
    switch (req.verb) {
      case 'status': outcome = await status(req); break;
      case 'attach': outcome = await attach(req); break;
      case 'detach': outcome = await detach(req); break;
      case 'unlink': outcome = await unlinkChat(req); break;
      case 'begin_task': outcome = await beginTask(req); break;
      case 'ask': outcome = await ask(req); break;
      case 'claim_question': outcome = await claimQuestion(req); break;
      case 'answer_question': outcome = await answerQuestion(req); break;
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
function controlFailure(err: unknown): ErrorFields {
  if (err instanceof QuestionError) return errFields(err.code, err.message);
  if (err instanceof StorageError) return errFields('STORAGE_UNAVAILABLE', err.message);
  return errFields('CAPTURE_NOT_READY', (err as Error).message);
}
function errFields(code: ControlErrorCode, message: string): ErrorFields {
  return { __error: true, code, message };
}
/** What to do when a session cannot be read or resumed. */
function corruptRemedy(id: string): string {
  return `Restore its data, or remove it with \`slipstream delete ${id}\` (this discards that history)`;
}
/** A lock, storage or shutdown failure says nothing about the session's data. */
const RETRY_REMEDY = 'Retry attach';
function isErrorFields<T extends object>(v: T | ErrorFields): v is ErrorFields {
  return (v as ErrorFields).__error === true;
}
