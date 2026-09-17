import { readdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createCas } from './cas.ts';
import { createReader, DEFAULT_MAX_BYTES, type Reader } from './reader.ts';
import { createLog, type Log } from './log.ts';
import { createEngine } from './engine.ts';
import { createHealth, type Health, type HealthFailure } from './health.ts';
import { acquireSessionLock, type SessionLock } from './lock.ts';
import { recoverSession, type RecoveredSession } from './recovery.ts';
import { StorageError, assertOwnerOnly, mkdirpDurable } from './storage.ts';
import { snapshotsEqual, type Snapshot } from './snapshot.ts';
import { createPlatform, type Platform, type Subscription } from './platform.ts';
import type { AnyEvent, EventInput } from './event.ts';

export interface CaptureOptions {
  root: string;
  storeDir: string;
  maxBytes?: number;
  /** Resume an existing session (restart reconciliation) instead of starting fresh. */
  resumeSessionId?: string;
}

export interface CaptureSession {
  sessionId: string;
  logPath: string;
  blobsDir: string;
  health: Health;
  stop(): Promise<void>;
}

interface CaptureDependencies {
  createLog: typeof createLog;
  platform: Platform;
  enumerate: typeof enumerate;
}

const defaultDependencies: CaptureDependencies = { createLog, platform: createPlatform(), enumerate };

/** A relative path escapes its base only via a leading `..` segment (or when it
 * comes back absolute); a filename that merely starts with `..`, like
 * `..notes.ts`, stays inside. */
function escapesBase(rel: string): boolean {
  return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
}

function isUnder(child: string, parent: string): boolean {
  return !escapesBase(relative(parent, child));
}

interface ReconcileState {
  committed: Map<string, Snapshot>;
  baselineUnknownDirs: Set<string>;
}

export async function startCapture(
  opts: CaptureOptions,
  dependencies: Partial<CaptureDependencies> = {},
): Promise<CaptureSession> {
  const deps = { ...defaultDependencies, ...dependencies };
  // The native watcher reports realpaths; resolve symlinks in the root (e.g.
  // macOS /var -> /private/var) so relative-path math against events matches.
  const root = await realpath(opts.root);
  await mkdirpDurable(opts.storeDir);
  const storeDir = await realpath(opts.storeDir);
  await assertOwnerOnly(storeDir, 'dir');
  if (isUnder(root, storeDir)) {
    throw new Error('store directory must not equal or contain the watched root');
  }

  const resuming = opts.resumeSessionId !== undefined;
  const sessionId = opts.resumeSessionId ?? randomUUID();
  const blobsDir = join(storeDir, 'blobs');
  const sessionDir = join(storeDir, 'sessions', sessionId);
  await mkdirpDurable(blobsDir);
  await mkdirpDurable(sessionDir);
  await assertOwnerOnly(sessionDir, 'dir'); // blobsDir perms are checked by createCas
  const logPath = join(sessionDir, 'events.jsonl');

  const cas = await createCas(blobsDir);

  // Set if the lock heartbeat finds another process has taken ownership: capture
  // must stop acknowledging and must never reopen the log (the new owner has it).
  // Declared before the lock is acquired so a compromise during the startup
  // recovery/open window still flips it; `healthRef` is filled in once health
  // exists, so the failing state is disclosed if the loss happens later.
  let surrendered = false;
  let healthRef: Health | undefined;
  const lock: SessionLock = await acquireSessionLock(sessionDir, {
    onCompromised: (reason) => {
      if (surrendered) return;
      surrendered = true;
      console.error(`slipstream: session ownership lost: ${reason}`);
      healthRef?.markFailing({ code: 'ELOCKLOST', operation: 'lock', detected_at_ms: Date.now() });
    },
  });

  let recovered: RecoveredSession | undefined;
  if (resuming) {
    try {
      await assertOwnerOnly(logPath, 'file').catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      });
      recovered = await recoverSession(logPath, sessionId, cas);
      if (recovered.root === undefined) {
        throw new Error(`cannot resume session ${sessionId}: no existing session.started record`);
      }
      if (recovered.root !== root) {
        throw new Error(`session ${sessionId} is bound to ${recovered.root}, not ${root}`);
      }
    } catch (err) {
      await lock.release(); // a failed resume must not leave the session locked
      throw err;
    }
  }

  const maxBytes = recovered?.maxBytes ?? opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const health = createHealth(recovered?.recoveredThroughSeq ?? 0n);
  healthRef = health; // the compromise callback can now disclose a lost lock

  let underlying: Log;
  try {
    underlying = await deps.createLog({
      filePath: logPath,
      sessionId,
      startSeq: recovered?.recoveredThroughSeq,
    });
  } catch (err) {
    await lock.release();
    throw err;
  }

  let stopped = false;
  let supervising = false;
  // The active recovery-supervisor loop, so shutdown can await an in-flight
  // recovery before releasing the lock (never append after another process could
  // take ownership). Resolved when no recovery is running.
  let supervisorLoop: Promise<void> = Promise.resolve();
  // One outage episode id, minted when acknowledgment first stops and reused
  // across recovery attempts so the disclosing storage gap is written once (Q6).
  let outageEpisodeId: string | undefined;

  // Suspend capture on a storage fault: mark health failing (preserving the
  // first failure of the outage) and kick the recovery supervisor. Used by both
  // the append path and the reader — a CAS publish failure must suspend capture,
  // never be laundered into a fabricated `unavailable` snapshot.
  const enterFailing = (failure: HealthFailure): void => {
    if (surrendered) return; // ownership lost: do not fight the new owner
    outageEpisodeId ??= randomUUID();
    const alreadySupervising = supervising;
    health.markFailing(failure);
    // Capture the loop's promise only when starting a fresh one, so `stop()` can
    // await the recovery in progress. runSupervisor sets `supervising` in its
    // synchronous prefix, so a concurrent kick sees it and no-ops.
    if (!alreadySupervising) supervisorLoop = runSupervisor();
  };

  // The single append path used everywhere except inside a recovery attempt: it
  // keeps health's durable_seq current and, on a storage fault, suspends capture
  // and kicks off the recovery supervisor before rethrowing.
  const appendEvent = async (input: EventInput): Promise<AnyEvent> => {
    if (surrendered) {
      throw new StorageError(
        'lock',
        Object.assign(new Error('session ownership lost'), { code: 'ELOCKLOST' }),
      );
    }
    try {
      const event = await underlying.append(input);
      health.setDurableSeq(underlying.durableSeq());
      return event;
    } catch (err) {
      if (err instanceof StorageError) {
        enterFailing({ code: err.code, operation: err.operation, detected_at_ms: Date.now() });
      }
      throw err;
    }
  };

  // Wrap the reader so a CAS publish failure (a storage fault, not an unreadable
  // source file) suspends capture and is disclosed, rather than recorded as a
  // change whose bytes we could not durably store.
  const rawReader = createReader({ root, cas, maxBytes });
  const reader: Reader = {
    read: async (rel) => {
      try {
        return await rawReader.read(rel);
      } catch (err) {
        if (err instanceof StorageError) {
          enterFailing({ code: err.code, operation: err.operation, detected_at_ms: Date.now() });
        }
        throw err;
      }
    },
  };

  const engine = createEngine({ reader, log: { append: appendEvent } });

  // Never capture the store or version-control metadata. If the store lives
  // inside the watched root, excluding it is what stops the watcher from
  // observing its own output.
  const excluded = [storeDir, join(root, '.git')];
  const isExcluded = (abs: string): boolean => excluded.some((e) => isUnder(abs, e));

  let live = false;
  const buffer: Array<[string, number]> = [];
  const onObservation = (abs: string, observedAtMs: number): void => {
    if (isExcluded(abs)) return;
    const rel = relative(root, abs);
    if (rel === '' || escapesBase(rel)) return;
    if (live) engine.notify(rel, observedAtMs);
    else buffer.push([rel, observedAtMs]);
  };

  // A native-watcher error means delivery may have lapsed; disclose an honest
  // session-wide coverage gap instead of letting the miss vanish silently.
  const onError = (err: Error): void => {
    console.error(`slipstream: watcher error: ${err.message}`);
    void appendEvent({
      type: 'slipstream.capture.gap.v1',
      occurred_at_ms: Date.now(),
      data: { scope: { kind: 'session' }, reason: 'watcher-error' },
    }).catch(() => {});
  };

  const priorFor = (path: string, unknownDirs: Set<string>): Snapshot => {
    for (const prefix of unknownDirs) {
      if (prefix === '' || path === prefix || path.startsWith(prefix + sep)) {
        return { kind: 'unavailable', reason: 'baseline-unknown' };
      }
    }
    return { kind: 'absent' };
  };

  // Re-observe the whole worktree against the last committed snapshots and emit a
  // reconciliation change for every differing endpoint. Enumeration omission is
  // NOT deletion — a known path missing from the scan is actually re-read, so a
  // real delete is distinguished from an unreadable subtree.
  const reconcile = async (
    state: ReconcileState,
    gapSeq: string,
    append: (input: EventInput) => Promise<AnyEvent>,
  ): Promise<void> => {
    const current = new Map<string, Snapshot>();
    const newUnknownDirs = new Set<string>();
    await deps.enumerate(root, root, isExcluded, {
      onFile: async (rel) => { current.set(rel, await reader.read(rel)); },
      onDirError: async (relDir) => { newUnknownDirs.add(relDir); },
    });

    const unknownDirs = new Set([...state.baselineUnknownDirs, ...newUnknownDirs]);
    const union = new Set<string>([...state.committed.keys(), ...current.keys()]);
    for (const path of union) {
      const after = current.get(path) ?? (await reader.read(path));
      const before = state.committed.get(path) ?? priorFor(path, unknownDirs);
      if (!snapshotsEqual(before, after)) {
        await append({
          type: 'slipstream.file.changed.v1',
          occurred_at_ms: Date.now(),
          data: { path, before, after, observation: 'reconciliation', gap_ref: gapSeq },
        });
      }
      engine.setBaseline(path, snapshotsEqual(before, after) ? before : after);
    }
    // Install every unknown directory — recovered as well as newly-failed — so a
    // later live observation of a never-baselined path reports baseline-unknown
    // rather than a fabricated absent prior state.
    for (const relDir of unknownDirs) engine.markBaselineUnknown(relDir);
  };

  const goLive = (): void => {
    live = true;
    for (const [rel, ts] of buffer) engine.notify(rel, ts);
    buffer.length = 0;
  };

  // Bounded-backoff recovery of a suspended session: reopen and repair the log,
  // disclose ONE storage gap, reconcile, and restore health. Appends here go
  // straight to the reopened log so a repeat fault aborts the attempt cleanly
  // (rather than recursing back into the supervisor).
  const runSupervisor = async (): Promise<void> => {
    if (supervising) return;
    supervising = true;
    let delay = 20;
    try {
      while (!stopped && !surrendered && health.snapshot().state === 'failing') {
        await new Promise((r) => { const t = setTimeout(r, delay); t.unref?.(); });
        delay = Math.min(delay * 2, 500);
        if (stopped) break;
        if (await tryStorageRecovery()) break;
      }
    } finally {
      supervising = false;
    }
  };

  const tryStorageRecovery = async (): Promise<boolean> => {
    live = false; // buffer live events while we repair and reconcile
    try {
      // Let in-flight engine tasks settle before swapping the log out from under
      // them; otherwise one could append with a stale committed `before`.
      await engine.drain();
      engine.resetNotifications();
      if (stopped || surrendered) return false; // shutting down / dispossessed: don't reopen
      await underlying.close().catch(() => {});
      const rec = await recoverSession(logPath, sessionId, cas);
      underlying = await deps.createLog({ filePath: logPath, sessionId, startSeq: rec.recoveredThroughSeq });
      health.setDurableSeq(rec.recoveredThroughSeq);
      health.markRecovering();

      const rawAppend = async (input: EventInput): Promise<AnyEvent> => {
        // If the lock was lost mid-recovery, stop writing: another process now
        // owns the log. This bounds — it cannot fully prevent — the residual, as
        // an append already awaiting its fsync when surrender flips still lands.
        if (surrendered) {
          throw new StorageError(
            'lock',
            Object.assign(new Error('session ownership lost'), { code: 'ELOCKLOST' }),
          );
        }
        const event = await underlying.append(input);
        health.setDurableSeq(underlying.durableSeq());
        return event;
      };

      // Disclose exactly one storage gap per outage: if a prior attempt's gap
      // survived on disk, reuse its seq instead of appending a duplicate (Q6).
      const episode = (outageEpisodeId ??= randomUUID());
      let gapSeq = rec.storageGapSeqByEpisode.get(episode);
      if (gapSeq === undefined) {
        const gap = await rawAppend({
          type: 'slipstream.capture.gap.v1',
          occurred_at_ms: Date.now(),
          data: { scope: { kind: 'session' }, reason: 'storage', episode_id: episode },
        });
        gapSeq = gap.seq;
      }
      await reconcile(
        { committed: rec.committed, baselineUnknownDirs: rec.baselineUnknownDirs },
        gapSeq,
        rawAppend,
      );

      if (surrendered) return false; // dispossessed during recovery: stay failing, don't mask it
      goLive();
      health.markHealthy();
      outageEpisodeId = undefined; // outage resolved; a later fault opens a new episode
      return true;
    } catch {
      // Recovery failed. Restore the failing state (the original failure is
      // preserved) so the supervisor keeps retrying. Stay NOT live: the engine's
      // in-memory baselines may now disagree with the reopened log (a partial
      // reconcile, or a reopen that read a durably-newer state), so replaying
      // buffered events here would append a change against a stale `before` and
      // poison the log. Buffering holds them until a *successful* recovery resets
      // the baselines via reconcile and then goes live.
      health.markFailing({ code: undefined, operation: 'recovery', detected_at_ms: Date.now() });
      return false;
    }
  };

  // Install the watcher BEFORE enumerating so nothing that happens during the
  // scan is missed; buffered events reconcile against the baseline afterward.
  let subscription: Subscription | undefined;
  try {
    subscription = await deps.platform.watch({ root, ignore: excluded, onObservation, onError });

    if (resuming) {
      await appendEvent({
        type: 'slipstream.session.resumed.v1',
        occurred_at_ms: Date.now(),
        data: {
          recovered_through_seq: recovered!.recoveredThroughSeq.toString(),
          discarded_tail_bytes: recovered!.discardedTailBytes,
        },
      });
      const restartGap = await appendEvent({
        type: 'slipstream.capture.gap.v1',
        occurred_at_ms: Date.now(),
        data: { scope: { kind: 'session' }, reason: 'restart' },
      });
      await reconcile(
        {
          committed: recovered!.committed,
          baselineUnknownDirs: recovered!.baselineUnknownDirs,
        },
        restartGap.seq,
        appendEvent,
      );
    } else {
      await appendEvent({
        type: 'slipstream.session.started.v1',
        occurred_at_ms: Date.now(),
        data: { root, max_bytes: maxBytes },
      });

      const unknownScopes: string[] = [];
      await deps.enumerate(root, root, isExcluded, {
        onFile: async (rel) => {
          const snapshot = await reader.read(rel);
          await appendEvent({
            type: 'slipstream.file.baselined.v1',
            occurred_at_ms: Date.now(),
            data: { path: rel, snapshot },
          });
          engine.setBaseline(rel, snapshot);
        },
        onDirError: async (relDir) => {
          engine.markBaselineUnknown(relDir);
          unknownScopes.push(relDir);
          await appendEvent({
            type: 'slipstream.capture.gap.v1',
            occurred_at_ms: Date.now(),
            data: { scope: { kind: 'directory', path: relDir }, reason: 'baseline-unreadable' },
          });
        },
      });
      await appendEvent({
        type: 'slipstream.capture.baseline.completed.v1',
        occurred_at_ms: Date.now(),
        data: { unknown_scopes: unknownScopes },
      });
    }
  } catch (err) {
    // A failed startup may already have kicked the recovery supervisor (an append
    // fault calls enterFailing). Stop it and await the in-flight attempt before
    // releasing the lock, or its next reopen could write to a log a second owner
    // has since acquired — the same ordering `stop()` relies on.
    stopped = true;
    await subscription?.close().catch(() => {});
    await supervisorLoop.catch(() => {});
    await engine.drain().catch(() => {});
    await underlying.close().catch(() => {});
    await lock.release();
    throw err;
  }

  goLive();
  health.markHealthy();

  return {
    sessionId,
    logPath,
    blobsDir,
    health,
    stop: async () => {
      stopped = true;
      await subscription?.close();
      // Await any in-flight recovery: it may be mid-reopen, and appending after
      // we release the lock would let a second owner's writes interleave. The
      // loop stops starting new attempts once `stopped` is set.
      await supervisorLoop.catch(() => {});
      await engine.drain();
      await underlying.close().catch(() => {});
      await lock.release();
    },
  };
}

interface EnumerateHandlers {
  onFile: (rel: string) => Promise<void>;
  onDirError: (relDir: string) => Promise<void>;
}

async function enumerate(
  root: string,
  dir: string,
  isExcluded: (abs: string) => boolean,
  handlers: EnumerateHandlers,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    await handlers.onDirError(relative(root, dir));
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (isExcluded(abs)) continue;
    if (entry.isSymbolicLink()) continue; // excluded, never followed
    if (entry.isDirectory()) {
      await enumerate(root, abs, isExcluded, handlers);
    } else if (entry.isFile()) {
      await handlers.onFile(relative(root, abs));
    }
  }
}
