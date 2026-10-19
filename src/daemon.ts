import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmod, lstat, unlink, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { startCapture, InvalidTitleError, RootChangedError, type CaptureSession } from './session.ts';
import type { HealthFailure } from './health.ts';
import { createTranscriptScheduler, type TranscriptScheduler } from './transcript/scheduler.ts';
import { QuestionError, assertAnswerText } from './questions.ts';
import { verifyClaudeRootTranscript } from './claude-root-transcript.ts';
import { verifyCodexRootTranscript } from './codex-root-transcript.ts';
import type { ResolvedConfig } from './config.ts';
import type { HarnessName } from './event.ts';
import { StorageError, mkdirpDurable, assertOwnerOnly } from './storage.ts';
import { acquireSessionLock, SessionOwnedError, STALE_MS, type SessionLock } from './lock.ts';
import { startReaderServer, type ReaderServer } from './http-reader.ts';
import {
  isValidSessionId, listSessions, findWorkspaceSession, finalRecord, readTombstone, sessionLogPath, WorkspaceLookupError,
} from './store-reader.ts';
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
import { loadIntent, saveIntent } from './intent-store.ts';
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
 * removes an inactive session while other captures keep recording; gc stops every
 * capture for maintenance, sweeps, and resumes each one (D9).
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
  /** Delay before re-trying a capture whose start failed transiently: doubles per
   * consecutive failure from `baseMs`, capped at `maxMs`. */
  retryBackoff?: { baseMs: number; maxMs: number };
  /** How long a delivered setup check waits before it is offered again. */
  setupReofferMs?: number;
  /** Replaces the transcript scheduler the config would build, so a test can count
   * one shared discovery cycle across captures. */
  transcriptScheduler?: TranscriptScheduler;
}

const HARNESSES: readonly HarnessName[] = ['claude-code', 'codex'];
const STORE_LOCK_WAIT_MS = 2_000;
const STORE_LOCK_POLL_MS = 50;
const RETRY_BACKOFF = { baseMs: 2_000, maxMs: 5 * 60_000 };
const SETUP_REOFFER_MS = 30_000;

type UnavailableReason = 'transcript-missing' | 'transcript-unreadable' | 'identity-changed' | 'runtime-unsupported';

const UNAVAILABLE_BY_CLAUDE_REASON = {
  'unavailable': 'transcript-unreadable', 'not-yet': 'transcript-unreadable', 'gap': 'transcript-unreadable',
  'mismatch': 'identity-changed', 'unsupported-version': 'runtime-unsupported',
} as const satisfies Record<string, UnavailableReason>;

class RootIdentityError extends Error {
  readonly reason: UnavailableReason;
  constructor(reason: UnavailableReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The intent record could not be written. Every later lifecycle change is
 * refused: acknowledging one the record does not hold would be a lie after a
 * restart. */
class IntentWriteError extends Error {
  constructor(cause: unknown) {
    super(`the capture intent record could not be written (${(cause as Error).message}); `
      + 'this daemon refuses attach, detach and unlink until it is restarted', { cause });
    this.name = 'IntentWriteError';
  }
}

/** Build the daemon's one transcript scheduler from resolved config: only harnesses
 * the operator declared `configured` are read, and with none there is no scheduler.
 * Whether a chat is linked plays no part (spec unit 8). */
function transcriptSchedulerFrom(config: ResolvedConfig | undefined): TranscriptScheduler | undefined {
  if (!config) return undefined;
  const harnesses = HARNESSES.filter((h) => config.policy.sources[h] === 'configured');
  if (harnesses.length === 0) return undefined;
  return createTranscriptScheduler({
    harnesses,
    homes: config.transcript.homes,
    codexScanLimit: config.transcript.codexScanLimit,
    onError: (err) => console.error(`slipstream: transcript watcher error: ${(err as Error).message}`),
  });
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
  /** When the check was last handed to the chat's hook. It is offered again
   * after `setupReofferMs` until it is answered, so a lost callback cannot strand
   * the link; a repeated attach offers it again at once. */
  offeredAtMs?: number;
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
  /** A recovery publication that has entered the durable binding append. Unlink
   * waits for only this append, never transcript retries or connection writes. */
  bindingRecord?: Promise<unknown>;
  /** Its transcript failed revalidation on resume; the intent keeps the link and
   * its slot, and records why (contracts.md §4). */
  unavailable?: boolean;
  /** Failed revalidations in this activation; the next retry backs off by it. */
  revalidations?: number;
  rearmTimer?: NodeJS.Timeout;
  cancelRearmDelay?: () => void;
}

/** One start of a capture. A lock-loss callback acts only on the activation that
 * registered it, never on a later one. */
interface Activation {
  session?: CaptureSession;
  lost: boolean;
  /** The session reported it can no longer observe its root (contracts.md §2). */
  ended?: { reason: EndReason; message: string };
}

/** Why an activation ended on its own, with its capture intent still running. */
type EndReason = 'root-missing' | 'watcher-failed' | 'maintenance';
type RootIdentity = { dev: string; ino: string };

const END_MESSAGES: Record<EndReason, string> = {
  'root-missing': 'the workspace root was deleted or replaced; a directory recreated at that path is a new capture',
  'watcher-failed': 'the watcher stopped delivering changes for this workspace',
  'maintenance': 'stopped while gc reclaims storage; it resumes on its own afterwards',
};

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
  /** A stop in flight (detach, maintenance, an ended activation, or a halt after
   * lock loss); cleared once it settles. */
  closing?: Promise<void>;
  closeError?: unknown;
  /** The intent write of its latest unlink. */
  unlinking?: Promise<void>;
  /** Its withdrawal could not be made durable, so no detach of it is acknowledged. */
  withdrawalError?: unknown;
  binding?: Binding;
  inflight: Set<Promise<unknown>>;
  /** Consecutive transient start failures; reset by a successful activation. */
  attempts: number;
  retryTimer?: NodeJS.Timeout;
  /** Its last activation ended on its own with `capture.stopped{reason}` while
   * its intent stayed running; cleared when a new activation begins. */
  ended?: EndReason;
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
  const transcripts = opts.transcriptScheduler ?? transcriptSchedulerFrom(opts.config);
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
  const backoff = opts.retryBackoff ?? RETRY_BACKOFF;
  const reofferMs = opts.setupReofferMs ?? SETUP_REOFFER_MS;
  let intent = emptyIntent();
  /** The next intent write not yet started; joining it covers every mutation made
   * before it begins. Writes run one at a time. */
  let intentFlush: Promise<void> | undefined;
  let intentTail: Promise<void> = Promise.resolve();
  let intentBroken: IntentWriteError | undefined;
  /** Every capture this daemon has admitted, by session id; withdrawn ones stay
   * for history until their session is deleted. */
  const captures = new Map<string, Capture>();
  /** Stops that settled with their capture `failed`: they recorded no stop. Read
   * by the stop, since a retry waiting on it may requeue the capture first. */
  const unrecordedStops = new WeakSet<Promise<void>>();
  /** Roots between their canonicalization and their intent write. A second attach
   * of the same root joins the first instead of admitting a duplicate. */
  const admitting = new Map<string, Promise<Admitted | ErrorFields>>();
  /** Baselines run one at a time, in admission order. */
  let baselines: Promise<void> = Promise.resolve();
  /** The store's blob store, shared by every capture (see CaptureOptions.cas).
   * Recreated after maintenance, which may delete blobs it trusts. */
  let cas: Cas | undefined;
  const connections = new Set<Socket>();
  // At most one maintenance op (delete_session / gc) runs at a time. The slot is
  // claimed synchronously in runMaintenance before its first await.
  let maintenanceInFlight: Promise<unknown> | undefined;
  /** A gc is stopping, sweeping or resuming: no capture is admitted or started
   * and no chat is linked or unlinked until it is done. */
  let quiescing = false;
  /** The session a delete_session is removing, and the count of delete_sessions
   * finished so far with the count at which each session's last one finished. An
   * attach never resumes a session being deleted, or one whose delete finished
   * after its lookup began; a later lookup reads the tombstone itself. */
  let deleting: string | undefined;
  let deletesDone = 0;
  const deleteDoneAt = new Map<string, number>();
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
    for (const c of captures.values()) {
      clearTimeout(c.retryTimer);
      if (c.binding) cancelRearm(c.binding);
    }
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
      stopErr ??= c.closeError;
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
    await intentTail;
    await lock.release();
    if (stopErr) throw stopErr;
  }

  let lock: SessionLock;
  // A CLI recording a withdrawal while no daemon ran holds the store lock for
  // milliseconds; wait it out. A lock still held after that, or a socket that
  // starts answering, is another daemon.
  const lockDeadline = Date.now() + STORE_LOCK_WAIT_MS;
  for (;;) {
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
      break;
    } catch (err) {
      if (!(err instanceof SessionOwnedError)) throw err;
      if (Date.now() >= lockDeadline || await probeSocket(socketPath, PROBE_TIMEOUT_MS) !== 'stale') {
        throw new DaemonAlreadyRunningError(socketPath);
      }
      await new Promise((resolve) => setTimeout(resolve, STORE_LOCK_POLL_MS));
    }
  }

  // Recovery reads intent only while holding the store lock, so a withdrawal a
  // CLI recorded while no daemon ran is always seen, and pins every session it
  // will resume before the reader can serve one.
  let restored: Capture[];
  try {
    intent = await loadIntent(storeDir);
    restored = await restoreCaptures();
  } catch (err) {
    await lock.release();
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
    if (c.ended && ['queued', 'failed', 'stopped'].includes(c.lifecycle)) return { state: 'stopped', reason: c.ended, message: END_MESSAGES[c.ended] };
    if (entry.last_failure) return { state: 'not_recording', reason: entry.last_failure.reason, message: entry.last_failure.message };
    const health = c.session?.health.snapshot().state;
    if (health === 'failing' || health === 'recovering') {
      return { state: 'not_recording', reason: 'storage-unavailable', message: `the store cannot accept events (${health}); capture resumes when it recovers` };
    }
    if (c.lifecycle === 'recording' || c.lifecycle === 'baselining') return { state: c.lifecycle, reason: null };
    return { state: 'queued', reason: null };
  }

  /** When recovery will next try a failed capture, while one is scheduled. */
  function retryOf(c: Capture): { next_attempt_at_ms: number } | null {
    const entry = findCapture(intent, c.id);
    const at = entry?.intent === 'running' ? entry.last_failure?.next_attempt_at_ms : null;
    return typeof at === 'number' ? { next_attempt_at_ms: at } : null;
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
    const row = { harness: entry.harness, harness_session_id: entry.harness_session_id, binding_generation: entry.binding_generation };
    if (entry.intent === 'revoked') return { ...row, state: 'unlinked', reason: null };
    if (entry.unavailable) return { ...row, state: 'unavailable', reason: entry.unavailable.reason, message: entry.unavailable.message };
    return { ...row, state: live?.check.state ?? 'setup_pending', reason: null };
  }

  function statusRow(c: Capture): Record<string, unknown> {
    const { state, reason, message } = publicState(c);
    const row: Record<string, unknown> = { session_id: c.id, root: c.root, state, reason, retry: retryOf(c), capture_mode: 'watch-only' };
    if (message) row.message = message;
    if (c.session) row.durable_seq = c.session.health.snapshot().durable_seq;
    row.binding = bindingRow(c);
    if (c.binding) row.binding = { ...row.binding as object, root_transcript: c.binding.transcript };
    return row;
  }

  /** `GET /v1/captures` (contracts.md §9). Heartbeats are read from the store and
   * session ownership locks, exactly as an offline client would. */
  async function capturesProjection(): Promise<Record<string, unknown>> {
    const asOf = Date.now();
    const heartbeatOf = async (lockPath: string): Promise<number | null> => {
      try { return Math.trunc((await stat(lockPath)).mtimeMs); } catch { return null; /* no owner */ }
    };
    const isLive = (heartbeat: number | null) => heartbeat !== null && asOf - heartbeat <= STALE_MS;
    const daemonLive = isLive(await heartbeatOf(join(storeDir, 'owner.lock')));
    const rows = await Promise.all([...captures.values()].map(async (c) => {
      let { state, reason } = publicState(c);
      const heartbeat = await heartbeatOf(join(storeDir, 'sessions', c.id, 'owner.lock'));
      // The public liveness rule (contracts.md §6, §7): a capture with no live
      // session owner is waiting on a live daemon, or not confirmed live at all.
      if (['queued', 'baselining', 'recording'].includes(state) && !isLive(heartbeat)) {
        [state, reason] = daemonLive ? ['queued', null] : ['not_recording', 'daemon-unavailable'];
      }
      return { session_id: c.id, root: c.root, state, reason, retry: retryOf(c), capture_mode: 'watch-only', heartbeat_ms: heartbeat,
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
    // A root recreated at the same path is a newer capture than the one it replaced.
    const found = atRoot.findLast(isLive) ?? atRoot.at(-1);
    return found ?? errFields('TARGET_NOT_FOUND', `no capture of ${target}`);
  }

  /** The live capture of the directory now at `root`. A capture of a directory
   * that was deleted or replaced there is a different workspace, not a match. */
  function liveCaptureAt(root: string, identity?: RootIdentity | null): Capture | undefined {
    return [...captures.values()].find((c) => c.root === root && isLive(c) && sameRoot(c, identity));
  }

  function rootGone(c: Capture): boolean {
    return c.ended === 'root-missing' || findCapture(intent, c.id)?.last_failure?.reason === 'root-missing';
  }

  function sameRoot(c: Capture, identity: RootIdentity | null | undefined): boolean {
    const known = findCapture(intent, c.id)?.root_identity;
    return !known || !identity || (known.dev === identity.dev && known.ino === identity.ino);
  }

  /** The capture a chat identity is linked to, store-wide (at most one). */
  function captureForChat(harness: unknown, harnessSessionId: unknown): Capture | undefined {
    const entry = typeof harness === 'string' && typeof harnessSessionId === 'string'
      ? findLinked(intent, harness, harnessSessionId) : undefined;
    return entry ? captures.get(entry.session_id) : undefined;
  }

  /** Record a capture as not recording. A transient failure is retried with
   * backoff, as a new activation. */
  /** A stop is recorded only while the daemon holds the store lock. A shutdown
   * keeps it, so only its loss makes a stop unrecordable. */
  function assertStoreOwned(): void {
    if (compromised) throw new Error('the daemon lost its store lock');
  }

  function fail(c: Capture, reason: NotRecordingReason, message: string, opts: { retry: boolean }): void {
    c.lifecycle = 'failed';
    const entry = findCapture(intent, c.id);
    const next = opts.retry && entry?.intent === 'running' && !torn && !compromised ? scheduleRetry(c) : null;
    if (entry) entry.last_failure = { reason, message, at_ms: Date.now(), next_attempt_at_ms: next };
    console.error(`slipstream daemon: capture ${c.id} of ${c.root} is not recording: ${message}`
      + (next === null ? '' : ` (retrying at ${new Date(next).toISOString()})`));
    persistQuietly();
  }

  function scheduleRetry(c: Capture): number {
    clearTimeout(c.retryTimer);
    c.attempts++;
    const delay = Math.min(backoff.baseMs * 2 ** (c.attempts - 1), backoff.maxMs);
    c.retryTimer = setTimeout(() => {
      c.retryTimer = undefined;
      void retryScheduled(c);
    }, delay);
    return Date.now() + delay;
  }

  /** Not recording, and another activation may fix that. */
  function retryable(c: Capture): boolean {
    return c.lifecycle === 'failed' || (c.lifecycle === 'stopped' && c.ended !== undefined);
  }

  async function retryScheduled(c: Capture): Promise<void> {
    await c.closing;
    const resume = c.resume || await hasHistory(c.id);
    const entry = findCapture(intent, c.id);
    if (torn || compromised || !retryable(c) || entry?.intent !== 'running' || !entry.last_failure) return;
    entry.last_failure.next_attempt_at_ms = null;
    persistQuietly();
    c.lifecycle = 'queued';
    c.resume = resume;
    enqueueStart(c);
  }

  /** Whether a session's log holds a complete record to resume from. A log a
   * failed first start left without one starts afresh under the same id; an
   * unreadable log is resumed, so it fails visibly. */
  async function hasHistory(id: string): Promise<boolean> {
    try { return await finalRecord(sessionLogPath(storeDir, id)) !== undefined; } catch { return true; }
  }

  /** Rebuild the capture table from the intent record after a restart. Every
   * session recovery will resume is pinned at its durable high-water, and every
   * fresh one reserved, before the reader is exposed or anything is written.
   * Returns the running captures, in admission order, to start once ready. */
  async function restoreCaptures(): Promise<Capture[]> {
    const toStart: Capture[] = [];
    let forgot = false;
    for (const entry of [...intent.captures]) {
      const id = entry.session_id;
      // A delete that crashed after its durable tombstone: finish forgetting it.
      if (await readTombstone(storeDir, id) !== null) {
        forgetSession(intent, id);
        forgot = true;
        continue;
      }
      let last: Awaited<ReturnType<typeof finalRecord>>;
      let unreadable = false;
      try { last = await finalRecord(sessionLogPath(storeDir, id)); } catch { unreadable = true; }
      const c: Capture = { id, root: entry.root, lifecycle: 'queued', resume: last !== undefined || unreadable,
        inflight: new Set(), attempts: 0 };
      captures.set(id, c);
      if (entry.intent === 'withdrawn') {
        // `stopped` only when the last activation's stop is durable (§6).
        c.lifecycle = c.resume && last?.type !== 'slipstream.capture.stopped.v1' ? 'failed' : 'stopped';
        continue;
      }
      // An unreadable log is pinned at 0; its resume fails visibly below.
      if (c.resume) registry.freeze(id, last?.seq ?? 0n);
      else registry.reserve(id);
      if (entry.intent !== 'running') continue;
      const stoppedFor = last?.type === 'slipstream.capture.stopped.v1' ? (last.data as { reason?: unknown } | null)?.reason : undefined;
      if (stoppedFor === 'root-missing' || stoppedFor === 'watcher-failed' || stoppedFor === 'maintenance') c.ended = stoppedFor;
      // Connection state is not persisted: a linked chat comes back pending and is
      // revalidated when its capture activates (contracts.md §8).
      const linked = intent.bindings.find((b) => b.session_id === id && b.intent === 'linked');
      if (linked) {
        c.binding = { harness: linked.harness, harnessSessionId: linked.harness_session_id,
          transcript: linked.verified_transcript_path, generation: linked.binding_generation,
          check: { state: 'setup_pending', checkId: randomUUID() } };
      }
      toStart.push(c);
    }
    if (forgot) await persistIntent();
    return toStart;
  }

  /** Make the in-memory intent durable (contracts.md §8). Mutations are synchronous,
   * so slot counts and the write they back cannot interleave; a lifecycle verb
   * awaits this before it acts or replies. */
  function persistIntent(): Promise<void> {
    if (intentBroken) return Promise.reject(intentBroken);
    if (compromised) return Promise.reject(new Error('the store lock was lost; the intent record belongs to another daemon'));
    intentFlush ??= intentTail.then(async () => {
      intentFlush = undefined;
      if (intentBroken) throw intentBroken;
      if (compromised) throw new Error('the store lock was lost; the intent record belongs to another daemon');
      try {
        await saveIntent(storeDir, intent);
      } catch (err) {
        intentBroken ??= new IntentWriteError(err);
        console.error(`slipstream daemon: ${intentBroken.message}`);
        throw intentBroken;
      }
    });
    const flush = intentFlush;
    intentTail = flush.catch(() => {});
    return flush;
  }

  /** Persist a change no acknowledgement depends on (a recorded failure). */
  function persistQuietly(): void {
    persistIntent().catch(() => {});
  }

  function intentRefusal(): ErrorFields | undefined {
    return intentBroken ? errFields('STORAGE_UNAVAILABLE', intentBroken.message) : undefined;
  }

  // ---- admission ----------------------------------------------------------

  interface Admitted { capture: Capture; created: boolean }

  async function rootIdentityOf(root: string): Promise<RootIdentity | null> {
    try {
      const st = await stat(root, { bigint: true });
      return { dev: st.dev.toString(), ino: st.ino.toString() };
    } catch { return null; }
  }

  /** Find or admit the capture of a canonical root. */
  async function admit(root: string): Promise<Admitted | ErrorFields> {
    if (torn || compromised) return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    const refused = intentRefusal();
    if (refused) return refused;
    const identity = await rootIdentityOf(root);
    if (quiescing) return errFields('CAPTURE_NOT_READY', 'gc is reclaiming storage; retry shortly');
    const live = liveCaptureAt(root, identity);
    if (live) return retryIfFailed(live);
    const pending = admitting.get(root);
    if (pending) {
      const joined = await pending;
      return isErrorFields(joined) ? joined : { capture: joined.capture, created: false };
    }
    // A withdrawn capture still watches its root until its stop completes.
    // A capture whose root is gone watches nothing there any more.
    const watching = [...captures.values()].filter((c) => (isLive(c) || c.lifecycle === 'stopping') && !rootGone(c));
    const other = [...watching.map((c) => c.root), ...admitting.keys()].find((r) => overlaps(r, root));
    if (other) {
      return errFields('ROOT_OVERLAP', `${root} overlaps the capture of ${other}: one contains the other. Nothing was changed`);
    }
    const p = admitNew(root, identity);
    admitting.set(root, p);
    try {
      return await p;
    } finally {
      admitting.delete(root);
    }
  }

  async function admitNew(root: string, rootIdentity: RootIdentity | null): Promise<Admitted | ErrorFields> {
    const lookedUpAt = deletesDone;
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
    // A session of a directory since deleted or replaced at this path is never
    // resumed: the recreated root starts a session of its own.
    const prev = lookup.match && findCapture(intent, lookup.match.id)?.root_identity;
    const match = prev && rootIdentity && (prev.dev !== rootIdentity.dev || prev.ino !== rootIdentity.ino)
      ? undefined : lookup.match;
    const id = match?.id ?? randomUUID();
    // A detach of this same session may still be stopping it; its lock must be
    // released before the session can start again.
    const prior = captures.get(id);
    await prior?.closing;
    if (torn || compromised) {
      if (match) {
        return errFields('SESSION_RESUME_FAILED', `could not resume session ${id}: the daemon is shutting down or lost its store lock. ${RETRY_REMEDY}`);
      }
      return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    }
    // Checked in the same turn as the intent entry below, which a delete checks.
    if (match && (deleting === id || (deleteDoneAt.get(id) ?? 0) > lookedUpAt)) {
      return errFields('CAPTURE_NOT_READY', `session ${id} was deleted while this attach looked it up; retry attach`);
    }
    if (match) {
      // Pin the boundary at the durable high-water BEFORE the log can grow, and
      // hold it until activation: readers never see past it mid-resume.
      registry.freeze(id, registry.get(id)?.boundary.current() ?? match.durableSeq);
    } else {
      // Reserve the registry entry (boundary 0) before startCapture creates the log
      // dir on disk, so the reader never over-publishes an uncommitted record.
      registry.reserve(id);
    }
    const entry = admitCapture(intent, { session_id: id, root, root_identity: rootIdentity });
    try {
      await persistIntent();
    } catch (err) {
      intent.captures = intent.captures.filter((e) => e !== entry);
      return errFields('STORAGE_UNAVAILABLE', (err as Error).message);
    }
    const c: Capture = prior ?? { id, root, lifecycle: 'queued', resume: false, inflight: new Set(), attempts: 0 };
    Object.assign(c, { root, lifecycle: 'queued', resume: match !== undefined, closeError: undefined });
    captures.set(id, c);
    if (entry.intent === 'running') enqueueStart(c);
    return { capture: c, created: true };
  }

  /** Re-attaching a capture whose start or storage failed, or whose activation
   * ended on its own, tries it again. */
  async function retryIfFailed(c: Capture): Promise<Admitted> {
    if (!retryable(c)) return { capture: c, created: false };
    await c.closing;
    const resume = c.resume || await hasHistory(c.id);
    const entry = findCapture(intent, c.id);
    if (!retryable(c) || entry?.intent !== 'running' || torn || compromised) return { capture: c, created: false };
    clearTimeout(c.retryTimer);
    c.retryTimer = undefined;
    entry.last_failure = null;
    persistQuietly();
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
    const moved = await rootProblem(c);
    if (c.lifecycle !== 'baselining') return;
    if (moved) {
      if (!c.resume) registry.freeze(c.id, 0n);
      fail(c, 'root-missing', moved, { retry: false });
      return;
    }
    const identity = findCapture(intent, c.id)?.root_identity;
    const activation: Activation = { lost: false };
    c.activation = activation;
    c.ended = undefined;
    let session: CaptureSession;
    try {
      cas ??= await createCas(join(storeDir, 'blobs'));
      session = await startCapture(
        {
          root: c.root,
          storeDir,
          ...(c.resume ? { resumeSessionId: c.id } : { sessionId: c.id }),
          ...(identity ? { rootIdentity: identity } : {}),
          captureMode: 'watch-only',
          cas,
          onCompromised: (reason) => onSessionLockLost(c, activation, reason),
          onTerminal: (reason, message) => onActivationEnded(c, activation, reason, message),
          onStorage: (state, failure) => onStorageChanged(c, activation, state, failure),
          ...(opts.config ? { enrichmentPolicy: opts.config.policy } : {}),
          ...(transcripts ? { transcript: transcripts } : {}),
        },
        opts.captureDependencies,
      );
    } catch (err) {
      // A fresh session never activated: freeze at 0, never delete the entry, so
      // the reader cannot fall back to disk for a half-written log. A resumed
      // session keeps the boundary pinned at its pre-resume high-water.
      if (!c.resume) registry.freeze(c.id, 0n);
      if (activation.lost || c.lifecycle !== 'baselining') return;
      if (err instanceof RootChangedError) {
        fail(c, 'root-missing', err.message, { retry: false });
        return;
      }
      if (c.resume) {
        const corrupt = err instanceof CorruptLogError || err instanceof LogCorruptError;
        fail(c, 'resume-failed', `could not resume session ${c.id}: ${(err as Error).message}. `
          + (corrupt ? corruptRemedy(c.id) : RETRY_REMEDY), { retry: !corrupt });
      } else {
        fail(c, err instanceof StorageError ? 'storage-unavailable' : 'baseline-failed', (err as Error).message, { retry: true });
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
    c.attempts = 0;
    const entry = findCapture(intent, c.id);
    if (entry?.last_failure) {
      entry.last_failure = null;
      persistQuietly();
    }
    registry.activate(c.id, liveBoundary(session.health));
    registry.setAgentConnection(c.id, 'none');
    if (activation.ended) {
      endActivation(c, session, activation.ended);
      return;
    }
    // A chat stays linked across a restart of its capture, but `connected` is
    // re-earned only by a fresh round trip in the new activation.
    if (c.binding) {
      c.binding.check = { state: 'setup_pending', checkId: randomUUID() };
      c.binding.revalidations = 0;
      startRearm(c, c.binding, session);
    }
  }

  function startRearm(c: Capture, b: Binding, session: CaptureSession): void {
    const rearm: Promise<ErrorFields | undefined> = (async (): Promise<ErrorFields | undefined> => {
      for (;;) {
        let failed: ErrorFields | undefined;
        try {
          failed = await rearmBinding(c, b, session);
        } catch (err) {
          console.error(`slipstream daemon: revalidating the chat linked to ${c.id} failed:`, err);
          failed = controlFailure(err);
        }
        if (!failed || quiescing) return;
        const delay = Math.min(backoff.baseMs * 2 ** (b.revalidations ?? 0), backoff.maxMs);
        b.revalidations = (b.revalidations ?? 0) + 1;
        if (!await waitForRearmDelay(b, delay)) return;
        if (c.binding !== b || c.session !== session || c.lifecycle !== 'recording' || torn || compromised) return;
      }
    })();
    b.publishing = rearm;
    const clearPublishing = () => {
      if (b.publishing === rearm) b.publishing = undefined;
    };
    void rearm.then(clearPublishing, clearPublishing);
  }

  function waitForRearmDelay(b: Binding, delay: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (b.cancelRearmDelay === cancel) b.cancelRearmDelay = undefined;
        resolve(true);
      }, delay);
      const cancel = () => {
        clearTimeout(timer);
        if (b.cancelRearmDelay === cancel) b.cancelRearmDelay = undefined;
        resolve(false);
      };
      b.cancelRearmDelay = cancel;
    });
  }

  function cancelRearm(b: Binding): void {
    clearTimeout(b.rearmTimer);
    b.rearmTimer = undefined;
    b.cancelRearmDelay?.();
  }

  /** Revalidate a linked chat's transcript in a new activation, then publish it
   * pending. A link whose `agent.binding` never became durable (a crash after its
   * intent) is recorded now, at its stored generation (contracts.md §6). */
  async function rearmBinding(c: Capture, b: Binding, session: CaptureSession): Promise<ErrorFields | undefined> {
    const entry = findLinked(intent, b.harness, b.harnessSessionId);
    try {
      b.transcript = await verifyRootTranscript(b.harness, b.harnessSessionId, c.root, b.transcript);
    } catch (err) {
      if (!(err instanceof RootIdentityError)) throw err;
      b.unavailable = true;
      if (entry) {
        entry.unavailable = { reason: err.reason, message: err.message };
        persistQuietly();
      }
      console.error(`slipstream daemon: the chat linked to ${c.id} is unavailable: ${err.message}`);
      // A transcript that comes back reconnects without another attach, while
      // this binding is still the capture's in this activation.
      const delay = Math.min(backoff.baseMs * 2 ** (b.revalidations ?? 0), backoff.maxMs);
      b.revalidations = (b.revalidations ?? 0) + 1;
      const timer = setTimeout(() => {
        if (b.rearmTimer === timer) b.rearmTimer = undefined;
        if (c.binding === b && b.unavailable && c.session === session && c.lifecycle === 'recording' && !quiescing && !torn && !compromised) {
          startRearm(c, b, session);
        }
      }, delay);
      b.rearmTimer = timer;
      timer.unref();
      return undefined;
    }
    b.unavailable = false;
    if (entry?.unavailable) {
      entry.unavailable = null;
      persistQuietly();
    }
    return publishBinding(c, b, { record: !session.bindingRecorded(b.generation), revokeOnFailure: false });
  }

  /** Whether a capture's root is still the directory it admitted. A root that is
   * gone, or whose device or inode changed, is never captured as the same session. */
  async function rootProblem(c: Capture): Promise<string | undefined> {
    const known = findCapture(intent, c.id)?.root_identity;
    let st;
    try { st = await stat(c.root, { bigint: true }); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
      return `the workspace root ${c.root} no longer exists`;
    }
    if (st.isDirectory() && (!known || (st.dev.toString() === known.dev && st.ino.toString() === known.ino))) return undefined;
    return `the workspace root ${c.root} was replaced; a directory recreated there is captured under a new session`;
  }

  function onActivationEnded(c: Capture, activation: Activation, reason: EndReason, message: string): void {
    if (c.activation !== activation || activation.lost || activation.ended) return;
    activation.ended = { reason, message };
    console.error(`slipstream daemon: capture ${c.id} of ${c.root} stopped: ${message}`);
    if (activation.session && c.lifecycle === 'recording') endActivation(c, activation.session, activation.ended);
  }

  /** Stop an activation that ended on its own, recording why. Its intent stays
   * running: a failed watcher is retried with backoff as a new activation; a
   * missing root is not, since it cannot come back as the same directory. */
  function endActivation(c: Capture, session: CaptureSession, { reason, message }: { reason: EndReason; message: string }): void {
    c.lifecycle = 'stopping';
    const prior = c.closing;
    setClosing(c, (async () => {
      await prior;
      while (c.inflight.size) await Promise.allSettled([...c.inflight]);
      if (registry.get(c.id)) registry.setAgentConnection(c.id, 'none');
      if (c.session === session) c.session = undefined;
      try {
        await session.stop({ reason, assertOwnership: assertStoreOwned });
      } catch (err) {
        registry.freeze(c.id, BigInt(session.health.snapshot().durable_seq));
        fail(c, 'storage-unavailable', `the capture stopped (${message}), but the stop could not be recorded: ${(err as Error).message}`,
          { retry: true });
        return;
      }
      registry.freeze(c.id, BigInt(session.health.snapshot().durable_seq));
      c.ended = reason;
      c.lifecycle = 'stopped';
      const entry = findCapture(intent, c.id);
      if (reason === 'watcher-failed' && entry?.intent === 'running' && !torn && !compromised) {
        entry.last_failure = { reason, message, at_ms: Date.now(), next_attempt_at_ms: scheduleRetry(c) };
        persistQuietly();
      }
    })());
  }

  /** Record a live activation's storage outage in the intent, and clear it on
   * recovery, so offline readers agree with this daemon (contracts.md §6). */
  function onStorageChanged(c: Capture, activation: Activation, state: 'failing' | 'healthy', failure?: HealthFailure): void {
    const entry = findCapture(intent, c.id);
    if (c.activation !== activation || activation.lost || entry?.intent !== 'running') return;
    if (state === 'failing' && !entry.last_failure) {
      entry.last_failure = { reason: 'storage-unavailable', at_ms: Date.now(), next_attempt_at_ms: null,
        message: `the store cannot accept events (${failure?.operation ?? 'append'}: ${failure?.code ?? 'error'}); capture resumes when it recovers` };
      persistQuietly();
      return;
    }
    // A recovery that lands while the capture is stopping keeps the outage until
    // the stop replaces it, and a clear that cannot be written is not shown.
    const outage = entry.last_failure;
    if (state !== 'healthy' || c.lifecycle !== 'recording' || outage?.reason !== 'storage-unavailable'
      || outage.next_attempt_at_ms !== null) return;
    entry.last_failure = null;
    persistIntent().catch(() => { entry.last_failure ??= outage; });
  }

  function onSessionLockLost(c: Capture, activation: Activation, reason: string): void {
    console.error(`slipstream daemon: session ${c.id} lost its lock: ${reason}`);
    if (c.activation !== activation || activation.lost) return;
    activation.lost = true;
    fail(c, 'storage-unavailable', `capture lost its session lock: ${reason}`, { retry: true });
    if (activation.session) halt(c, activation.session);
  }

  /** Stop a capture whose storage can no longer be trusted, without recording a
   * stop it cannot make durable. Its boundary stays at the last durable seq. */
  function halt(c: Capture, session: CaptureSession): void {
    registry.freeze(c.id, BigInt(session.health.snapshot().durable_seq));
    const prior = c.closing;
    setClosing(c, (async () => {
      await prior;
      await Promise.allSettled([...c.inflight]);
      try {
        await session.stop();
      } catch (err) {
        console.error(`slipstream daemon: session ${c.id} did not stop cleanly after losing its lock:`, err);
      }
      if (c.session === session) c.session = undefined;
    })());
  }

  /** Make `closing` the capture's stop in flight until it settles. Its outcome is
   * read here, before any later waiter on it can run. */
  function setClosing(c: Capture, closing: Promise<void>): void {
    c.closing = closing;
    const settle = () => {
      if (c.lifecycle === 'failed') unrecordedStops.add(closing);
      if (c.closing === closing) c.closing = undefined;
    };
    closing.then(settle, settle);
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
      throw new RootIdentityError('transcript-missing', harness === 'claude-code'
        ? 'root Claude transcript is unavailable; check its path or retry attach after the first root tool call'
        : 'root Codex transcript cannot be resolved');
    }
    if (harness === 'codex') {
      if (!await verifyCodexRootTranscript(resolved, harnessSessionId, root)) {
        throw new RootIdentityError('identity-changed', 'root Codex transcript is missing, mismatched, or from an unsupported runtime');
      }
      return resolved;
    }
    const verified = await verifyClaudeRootTranscript(resolved, harnessSessionId, root);
    if (!verified.ok) {
      throw new RootIdentityError(UNAVAILABLE_BY_CLAUDE_REASON[verified.reason], verified.reason === 'not-yet'
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
    // Finish an admitted unlink before publishing a replacement binding.
    if (!c.binding) await Promise.allSettled([...c.inflight]);
    if (torn || compromised || quiescing || c.lifecycle !== 'recording' || !isRunning(c)) {
      return errFields('CAPTURE_NOT_READY', 'the capture is no longer recording');
    }
    const mine = c.binding;
    if (mine && mine.harness === chat.harness && mine.harnessSessionId === chat.harnessSessionId) {
      const failed = await mine.publishing;
      if (failed) return failed;
      if (c.binding !== mine) return errFields('CAPTURE_NOT_READY', 'the chat was unlinked while it was being linked; retry attach');
      if (mine.unavailable) return relink(c, mine, chat.transcript);
      if (mine.check.state === 'setup_pending') mine.check.offeredAtMs = undefined;
      return bindReply(c, mine, { already_active: true, created: false });
    }
    if (mine) return bindingExists(mine.harness, mine.harnessSessionId, c);
    const elsewhere = captureForChat(chat.harness, chat.harnessSessionId);
    if (elsewhere) return bindingExists(chat.harness, chat.harnessSessionId, elsewhere);
    const refused = intentRefusal();
    if (refused) return refused;
    if (linkedCount(intent) >= MAX_BINDINGS) return errFields('BINDING_LIMIT_REACHED', BINDING_LIMIT_MESSAGE);
    const entry = linkBinding(intent, {
      session_id: c.id, harness: chat.harness, harness_session_id: chat.harnessSessionId,
      canonical_worktree: c.root, verified_transcript_path: chat.transcript,
    });
    const b: Binding = { ...chat, generation: entry.binding_generation,
      check: { state: 'setup_pending', checkId: randomUUID() } };
    c.binding = b;
    // The binding is durable before any event names it.
    const publishing = persistIntent().then(() => publishBinding(c, b, { record: true, revokeOnFailure: true }), (err: Error) => {
      if (c.binding === b) c.binding = undefined;
      revokeBinding(intent, c.id);
      return errFields('STORAGE_UNAVAILABLE', err.message);
    });
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

  /** The same chat attaching again to its unavailable link, with a transcript that
   * verifies now: the link keeps its generation and is published pending again. */
  async function relink(c: Capture, b: Binding, transcript: string): Promise<Record<string, unknown> | ErrorFields> {
    const refused = intentRefusal();
    if (refused) return refused;
    const entry = findLinked(intent, b.harness, b.harnessSessionId);
    if (!entry || entry.session_id !== c.id) return errFields('CAPTURE_NOT_READY', 'the chat was unlinked while it was being linked; retry attach');
    entry.unavailable = null;
    entry.verified_transcript_path = transcript;
    b.transcript = transcript;
    b.unavailable = false;
    b.check = { state: 'setup_pending', checkId: randomUUID() };
    const publishing = persistIntent().then(
      () => publishBinding(c, b, { record: !c.session!.bindingRecorded(b.generation), revokeOnFailure: false }),
      (err: Error) => errFields('STORAGE_UNAVAILABLE', err.message));
    b.publishing = publishing;
    c.inflight.add(publishing);
    let failed: ErrorFields | undefined;
    try {
      failed = await publishing;
    } finally {
      c.inflight.delete(publishing);
      if (b.publishing === publishing) b.publishing = undefined;
    }
    return failed ?? bindReply(c, b, { created: false });
  }

  /** Append a binding's events in contract order, then publish it to hooks and
   * forwarders. A new link that cannot be recorded is revoked again. */
  async function publishBinding(c: Capture, b: Binding, how: { record: boolean; revokeOnFailure: boolean }): Promise<ErrorFields | undefined> {
    const session = c.session!;
    const target = { harness: b.harness, harness_session_id: b.harnessSessionId };
    const own = (): void => {
      if (torn || compromised || c.binding !== b || c.lifecycle !== 'recording' || c.activation?.lost) {
        throw new QuestionError('STORAGE_UNAVAILABLE', 'the capture stopped or the chat was unlinked while it was being linked');
      }
    };
    let recorded = false;
    try {
      if (how.record) {
        const bindingRecord = session.recordAgent({ type: 'slipstream.agent.binding.v1', occurred_at_ms: Date.now(), data: {
          binding_generation: b.generation, target: { ...target, worktree: c.root }, verified_transcript_path: b.transcript } }, own);
        b.bindingRecord = bindingRecord;
        try {
          await bindingRecord;
          recorded = true;
        } finally {
          if (b.bindingRecord === bindingRecord) b.bindingRecord = undefined;
        }
      }
      await session.recordAgent({ type: 'slipstream.agent.connection.v1', occurred_at_ms: Date.now(), data: {
        state: 'setup_pending', binding_generation: b.generation, target } }, own);
    } catch (err) {
      if (how.revokeOnFailure && c.binding === b) {
        c.binding = undefined;
        revokeBinding(intent, c.id);
        persistQuietly();
        // The log already says this chat is linked; say it no longer is.
        if (recorded) {
          await session.recordAgent({ type: 'slipstream.agent.unlinked.v1', occurred_at_ms: Date.now(),
            data: { binding_generation: b.generation, reason: 'unlinked' } }).catch(() => {});
        }
      }
      return controlFailure(err);
    }
    registry.setAgentConnection(c.id, 'setup_pending');
    return undefined;
  }

  async function detach(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (req.reason !== undefined && req.reason !== 'archived') return errFields('PROTOCOL', `unknown detach reason: ${String(req.reason)}`);
    const why = req.reason === 'archived' ? 'archived' : 'detached';
    const c = await resolveTarget(req.target);
    if (isErrorFields(c)) return c;
    if (torn || compromised) return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
    // A path withdraws every capture recorded at it, as the offline path does: an
    // older capture of a replaced root would otherwise keep its slot.
    const targets = captures.has(req.target as string) ? [c] : [...captures.values()].filter((x) => x.root === c.root);
    const pending = targets.filter((t) => {
      const entry = findCapture(intent, t.id);
      return entry !== undefined && entry.intent !== 'withdrawn';
    });
    if (pending.length > 0) {
      const refused = intentRefusal();
      if (refused) return refused;
      const promotedFor = pending.map((t) => {
        const promoted = withdrawCapture(intent, t.id, why);
        revokeBinding(intent, t.id);
        return promoted;
      });
      const durable = persistIntent();
      for (const [i, t] of pending.entries()) {
        const prior = t.closing;
        // Set in this turn, so a concurrent detach waits for the same stop. A
        // withdrawal that is not durable stops nothing, and is never acknowledged.
        setClosing(t, durable.then(() => {
          const promoted = promotedFor[i];
          const next = promoted && captures.get(promoted.session_id);
          if (next) enqueueStart(next);
          return closeCapture(t, prior, why);
        }, (err: unknown) => { t.withdrawalError = err; }));
      }
    }
    const already = !pending.includes(c) && findCapture(intent, c.id)?.intent === 'withdrawn' && c.lifecycle === 'stopped';
    await Promise.all(targets.map((t) => t.closing));
    const undurable = targets.find((t) => t.withdrawalError);
    if (undurable) return errFields('STORAGE_UNAVAILABLE', `the withdrawal was not saved: ${(undurable.withdrawalError as Error).message}`);
    if (c.closeError) {
      return errFields('STORAGE_UNAVAILABLE', `detach did not stop cleanly: ${(c.closeError as Error).message}`);
    }
    const { state, reason } = publicState(c);
    return { session_id: c.id, state, reason, ...(already ? { already_stopped: true } : {}) };
  }

  /** Stop a withdrawn capture: unlink its chat, then record the stop. */
  async function closeCapture(c: Capture, prior: Promise<void> | undefined, why: 'detached' | 'archived'): Promise<void> {
    clearTimeout(c.retryTimer);
    const from = c.lifecycle;
    if (from === 'queued') {
      // Not activated: the start job sees the withdrawal and starts nothing. It is
      // `stopped` only if its last activation, if any, ended in a durable stop (§6).
      const last = c.resume ? await finalRecord(sessionLogPath(storeDir, c.id)).catch(() => undefined) : undefined;
      c.lifecycle = !c.resume || last?.type === 'slipstream.capture.stopped.v1' ? 'stopped' : 'failed';
      return;
    }
    c.lifecycle = 'stopping';
    if (from === 'baselining') await c.starting;
    await prior;
    // An unlink can join while an earlier admitted task is draining.
    while (c.inflight.size) await Promise.allSettled([...c.inflight]);
    // Detach already revoked the binding's intent with the withdrawal.
    const b = c.binding;
    c.binding = undefined;
    if (b) {
      cancelRearm(b);
      await b.bindingRecord?.catch(() => undefined);
    }
    if (registry.get(c.id)) registry.setAgentConnection(c.id, 'none');
    const session = c.session;
    if (!session) {
      // Its activation already ended in a durable stop, or its storage failed
      // earlier and it was halted without one.
      c.lifecycle = c.ended || !c.activation ? 'stopped' : 'failed';
      return;
    }
    c.session = undefined;
    try {
      // A link the log never named (a crash before its `agent.binding`) has no
      // unlink to record.
      const named = b && session.bindingRecorded(b.generation);
      await session.stop(named ? { reason: why, unlinkGeneration: b.generation, assertOwnership: assertStoreOwned }
        : { reason: why, assertOwnership: assertStoreOwned });
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
    if (quiescing) return errFields('CAPTURE_NOT_READY', 'gc is reclaiming storage; retry shortly');
    const b = c.binding;
    if (!b) {
      // An unlink still being saved is not yet acknowledged to anyone.
      if (c.unlinking && !await c.unlinking.then(() => true, () => false)) return intentRefusal()!;
      return { session_id: c.id, already_unlinked: true };
    }
    const refused = intentRefusal();
    if (refused) return refused;
    c.binding = undefined;
    cancelRearm(b);
    revokeBinding(intent, c.id);
    if (registry.get(c.id)) registry.setAgentConnection(c.id, 'none');
    const persisted = persistIntent();
    c.unlinking = persisted;
    const session = c.session;
    if (!session || !['recording', 'stopping'].includes(c.lifecycle)) {
      await persisted.catch(() => {});
      return errFields('STORAGE_UNAVAILABLE', 'the chat was unlinked, but its capture cannot record the unlink');
    }
    const admitted = [...c.inflight];
    const append = (async () => {
      // Revoke immediately, but end task selection only after old admitted tasks
      // have committed and the revocation is durable. Detach also drains this
      // promise before closing the log.
      await persisted;
      await Promise.allSettled(admitted);
      await b.bindingRecord?.catch(() => undefined);
      if (!session.bindingRecorded(b.generation)) return;
      await session.recordAgent({ type: 'slipstream.agent.unlinked.v1', occurred_at_ms: Date.now(),
        data: { binding_generation: b.generation, reason: 'unlinked' } });
    })();
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

  /** Capture-level ownership check run immediately before an append: nothing
   * about any chat, only that this capture still holds its storage. */
  function ownsCapture(c: Capture): () => void {
    return () => {
      const live = c.lifecycle === 'recording' || c.lifecycle === 'stopping';
      if (compromised || torn || !live || c.activation?.lost) {
        throw new QuestionError('STORAGE_UNAVAILABLE', 'the selected capture lost storage ownership');
      }
    };
  }

  /** Ownership check run immediately before an append on a chat's behalf. A
   * stopping capture still accepts work it admitted: the stop drains it before
   * revoking the binding. */
  function owns(c: Capture, b: Binding): () => void {
    const capture = ownsCapture(c);
    return () => {
      capture();
      if (c.binding !== b) throw new QuestionError('STORAGE_UNAVAILABLE', 'the selected capture lost storage ownership');
    };
  }

  /** The chat's published binding and its capture, if it may act now. */
  function chatTarget(c: Capture | undefined): { c: Capture; b: Binding } | undefined {
    const b = c?.binding;
    return c && b && !b.publishing && !b.unavailable && c.lifecycle === 'recording' ? { c, b } : undefined;
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

  async function track<T>(c: Capture, promise: Promise<T>, ok: (v: T) => Record<string, unknown> | ErrorFields): Promise<Record<string, unknown> | ErrorFields> {
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
    return track(c, c.session!.beginTask({ title: req.title, requestId: req.request_id }), (r) => c.binding !== b
      ? errFields('STALE_BINDING', `task ${r.task_id} was recorded, but this chat was unlinked before it could be acknowledged`)
      : { session_id: r.session_id, task_id: r.task_id, event_id: r.event_id, seq: r.seq });
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

  /** Record a question and the answer the client's own forked chat produced. The
   * client is the writer, so there is no binding, chat or connection to check:
   * the capture only has to be recording. The conversation ids it reports are
   * stored as client-reported and are never used to bind or attribute. */
  async function recordExchange(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'daemon storage ownership is unavailable');
    const c = nonEmptyString(req.session_id) ? captures.get(req.session_id) : undefined;
    if (!c || !isLive(c)) return errFields('SESSION_NOT_SELECTED', 'no capture with that session id is running');
    if (c.activation?.lost) return errFields('STORAGE_UNAVAILABLE', 'capture storage is no longer trustworthy');
    if (c.lifecycle !== 'recording' || !isRunning(c)) return errFields('CAPTURE_NOT_READY', 'the capture is not recording yet');
    return track(c, c.session!.recordQuestionExchange(req, ownsCapture(c)), (r) => ({ ...r }));
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
      const now = Date.now();
      if (b.check.offeredAtMs !== undefined && now - b.check.offeredAtMs < reofferMs) return { question: null };
      b.check.offeredAtMs = now;
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

  /** Run one maintenance op at a time. The slot is claimed synchronously through
   * `maintenanceInFlight`, and `op` runs up to its first await in the same turn. */
  async function runMaintenance(
    op: () => Promise<Record<string, unknown> | ErrorFields>,
  ): Promise<Record<string, unknown> | ErrorFields> {
    if (compromised || torn) return errFields('STORAGE_UNAVAILABLE', 'the daemon is shutting down or its store lock was lost');
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
      // Checked in the same turn `deleting` is set, which admission checks in the
      // same turn as its intent entry: neither can slip past the other.
      const target = captures.get(id);
      const entry = findCapture(intent, id);
      if ((entry && entry.intent !== 'withdrawn') || target?.session || (target && !['stopped', 'failed'].includes(target.lifecycle))) {
        const state = target ? publicState(target).state : entry!.intent;
        return errFields('SESSION_ACTIVE', `session ${id} is ${state}; detach it and let it stop first`);
      }
      deleting = id;
      try {
        return await deleteInactive(id);
      } finally {
        deleting = undefined;
        deleteDoneAt.set(id, ++deletesDone);
      }
    });
  }

  async function deleteInactive(id: string): Promise<Record<string, unknown> | ErrorFields> {
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
    try {
      await persistIntent();
    } catch (err) {
      return errFields('STORAGE_UNAVAILABLE', `session ${id} is logically removed (tombstone durable), but ${(err as Error).message}`);
    }
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
  }

  /** gc as one maintenance transaction (D9): close admission, stop every capture
   * with `capture.stopped{maintenance}`, sweep, then resume each one stopped here.
   * Intent is untouched throughout, so waiting captures keep their places. */
  async function gc(): Promise<Record<string, unknown> | ErrorFields> {
    return runMaintenance(async () => {
      quiescing = true;
      try {
        await Promise.allSettled([...admitting.values()]);
        // Starts already queued run first; none begins until this pass ends.
        const pass = baselines.then(maintenancePass);
        baselines = pass.then(() => {}, () => {});
        return await pass;
      } finally {
        quiescing = false;
      }
    });
  }

  async function maintenancePass(): Promise<Record<string, unknown> | ErrorFields> {
    const stopped = new Set<Capture>();
    const unproven = new Map<string, string>();
    try {
      for (const c of captures.values()) {
        if (c.session && c.lifecycle === 'recording') stopForMaintenance(c, stopped, unproven);
      }
      // A detach, a halt or an ended activation may own a stop too; every stop gc
      // waits for must finish and record its stop before any blob is swept.
      // Read as each stop settles: a retry may requeue a failed capture later.
      const settled = (c: Capture, closing: Promise<void> | undefined) => {
        const failed = c.lifecycle === 'failed' || (closing !== undefined && unrecordedStops.has(closing));
        if (failed && !unproven.has(c.id)) unproven.set(c.id, `capture ${c.id} stopped without recording its stop`);
      };
      // A stop still settling counts whatever the lifecycle reads: a lock lost
      // mid-detach marks the capture `failed` while its log is still draining.
      const writing = (c: Capture) => c.session || c.lifecycle === 'stopping' || c.closing;
      for (;;) {
        const busy = [...captures.values()].filter(writing);
        if (busy.length === 0) break;
        const closings = busy.map((c) => c.closing);
        await Promise.allSettled(busy.map((c, i) => Promise.resolve(closings[i]).then(() => settled(c, closings[i]), () => settled(c, closings[i]))));
        const stuck = busy.filter((c, i) => c.closing === closings[i] && writing(c));
        if (stuck.length === busy.length) {
          for (const c of stuck) unproven.set(c.id, `capture ${c.id} has not stopped`);
          break;
        }
      }
      if (torn || compromised) throw new StorageError('gc-aborted', new Error('the daemon is shutting down or lost its store lock'));
      if (unproven.size > 0) return errFields('STORAGE_UNAVAILABLE', `gc swept nothing: ${[...unproven.values()].join('; ')}`);
      const foreign = await freshSessionLock();
      if (foreign) {
        return errFields('STORAGE_UNAVAILABLE', `gc swept nothing: session ${foreign} is still being written by another process`);
      }
      return await sweep();
    } catch (err) {
      // A corrupt/missing retained log or an aborted sweep deletes nothing; report
      // the store as unavailable rather than a partial success.
      return errFields('STORAGE_UNAVAILABLE', (err as Error).message);
    } finally {
      // Resume even after a failed sweep: storage that refused a sweep may still
      // record, and a capture that cannot fails visibly on its own.
      quiescing = false;
      if (!torn && !compromised) {
        for (const entry of intent.captures) {
          const c = captures.get(entry.session_id);
          if (!c || !stopped.has(c) || entry.intent !== 'running' || c.lifecycle !== 'stopped') continue;
          c.lifecycle = 'queued';
          c.resume = true;
          enqueueStart(c);
        }
      }
    }
  }

  /** Stop one recording capture for maintenance, keeping its capture and binding
   * intent. Admitted binding publication and chat work finish first, so a link in
   * flight is kept rather than revoked; a check issued before the stop never
   * connects afterwards. */
  function stopForMaintenance(c: Capture, stopped: Set<Capture>, unproven: Map<string, string>): void {
    const prior = c.closing;
    setClosing(c, (async () => {
      await prior;
      while (c.binding?.publishing || c.inflight.size) {
        if (c.binding) cancelRearm(c.binding);
        await Promise.allSettled([c.binding?.publishing, ...c.inflight]);
      }
      const session = c.session;
      // A detach or an ended activation took it over meanwhile, and owns its stop.
      if (!session || c.lifecycle !== 'recording' || !isRunning(c) || torn || compromised) {
        if (session && (torn || compromised)) unproven.set(c.id, `capture ${c.id} was not stopped`);
        return;
      }
      c.lifecycle = 'stopping';
      if (c.binding) c.binding.check = { state: 'setup_pending', checkId: randomUUID() };
      registry.setAgentConnection(c.id, 'none');
      c.session = undefined;
      const freeze = () => registry.freeze(c.id, BigInt(session.health.snapshot().durable_seq));
      try {
        await session.stop({ reason: 'maintenance', assertOwnership: assertStoreOwned });
      } catch (err) {
        freeze();
        const message = (err as Error).message;
        unproven.set(c.id, `capture ${c.id} could not record its maintenance stop: ${message}`);
        fail(c, 'storage-unavailable', `gc could not record this capture's maintenance stop: ${message}`, { retry: true });
        return;
      }
      freeze();
      c.ended = 'maintenance';
      c.lifecycle = 'stopped';
      stopped.add(c);
    })());
  }

  /** A session ownership lock some other writer refreshed recently: the daemon's
   * own captures are all stopped by now, and released theirs. */
  async function freshSessionLock(): Promise<string | undefined> {
    for (const s of await listSessions(storeDir)) {
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(join(storeDir, 'sessions', s.id, 'owner.lock'))).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (Date.now() - mtimeMs <= STALE_MS) return s.id;
    }
    return undefined;
  }

  /** Finish interrupted deletions, then reclaim unreferenced blobs. */
  async function sweep(): Promise<Record<string, unknown>> {
    // A session tombstoned by a delete_session that crashed before cleanup still
    // carries residual history: re-establish the tombstone's durability, invalidate
    // any follower a partial delete left pinned, then complete the removal. Stop
    // before any mutation if we lose the store lock: a successor now owns this
    // store's files.
    for (const s of await listSessions(storeDir)) {
      if (!s.removed) continue;
      if (compromised || torn) {
        throw new StorageError('gc-aborted', new Error('store ownership lost mid-cleanup'));
      }
      await publishTombstone(storeDir, s.id);
      registry.freeze(s.id, 0n);
      await removeSessionHistory(storeDir, s.id);
    }
    // The shared blob store trusts blobs it published, some of which this sweep
    // may delete: every resumed capture starts with a fresh instance. The sweep
    // aborts if we lose the store lock, since a successor may own the blobs.
    cas = undefined;
    const removed = await reclaimUnreferencedBlobs(storeDir, () => torn || compromised);
    return { removed };
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
      case 'record_question_exchange': outcome = await recordExchange(req); break;
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
  for (const c of restored) enqueueStart(c);

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
