import { access, readdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createCas } from './cas.ts';
import { loadCaptureIgnores, compileCaptureIgnores } from './capture-ignores.ts';
import { createReader, DEFAULT_MAX_BYTES, type Reader } from './reader.ts';
import { createLog, type AppendSequencer, type Log } from './log.ts';
import { createEngine } from './engine.ts';
import { createHealth, type Health, type HealthFailure } from './health.ts';
import { acquireSessionLock, type SessionLock } from './lock.ts';
import { recoverSession, type RecoveredSession } from './recovery.ts';
import { StorageError, assertOwnerOnly, mkdirpDurable } from './storage.ts';
import { snapshotsEqual, type Snapshot } from './snapshot.ts';
import { isValidSessionId } from './store-reader.ts';
import { createPlatform, type Platform, type Subscription } from './platform.ts';
import {
  createAttributionProducer,
  DEFAULT_ENRICHMENT_POLICY,
  type AttributionProducer,
} from './attribution-producer.ts';
import type { IngestOutcome, NormalizedEvidence } from './evidence-ingest.ts';
import type { AnyEvent, EnrichmentPolicy, EventInput, HarnessName } from './event.ts';
import type { PublicEvent, PublicEventInput, QuestionQueuedData, QuestionQueuedInput, QuestionQueuedEvent, QuestionDispatchAttemptedInput, QuestionDispatchAttemptedEvent, QuestionAnsweredInput, QuestionAnsweredEvent } from './public-events.ts';
import { normalizeAsk, questionBody, questionResult, readQuestionContext, QuestionError, QUESTION_TTL_MS, QUESTION_LIMIT, type QuestionAccepted, assertAnswerText, answerResult, type AnswerAccepted } from './questions.ts';
import { createCoverageRunner, type CoverageRunner } from './transcript/runner.ts';
import type { DiscoveryIO } from './transcript/discovery.ts';
import type { TranscriptFileIO } from './transcript/file-reader.ts';
import { nodeDiscoveryIO, nodeTranscriptFileIO } from './transcript/fs-io.ts';

/** How often the transcript watcher re-runs discovery and reads new records. */
export const DEFAULT_TRANSCRIPT_POLL_MS = 2000;

/** Transcript-reading settings for a session, resolved from the daemon config.
 * Absent (or an empty `harnesses`) means no transcript is read — capture behaves
 * exactly as before adapters existed (an `unknown` honestly means "nothing was
 * watched"). */
export interface TranscriptRuntime {
  /** The harnesses declared `configured`; only these are discovered and read. */
  harnesses: readonly HarnessName[];
  homes: Record<HarnessName, string>;
  codexScanLimit: number;
  pollIntervalMs?: number;
  discoveryIO?: DiscoveryIO;
  fileIO?: TranscriptFileIO;
}

export interface CaptureOptions {
  root: string;
  storeDir: string;
  maxBytes?: number;
  /** Resume an existing session (restart reconciliation) instead of starting fresh. */
  resumeSessionId?: string;
  /** Start a FRESH session under a caller-pre-generated id. The daemon uses this
   * to reserve the reader boundary registry entry before the log dir exists on
   * disk (D3). Mutually exclusive with {@link resumeSessionId}. A fresh id whose
   * log already exists is rejected — appending fresh would corrupt its sequence. */
  sessionId?: string;
  /** Notified once if this session loses its lock to another owner. Capture has
   * already stopped acknowledging by the time this fires; the daemon uses it to
   * wedge its state machine (decision 9). */
  onCompromised?: (reason: string) => void;
  /** The effective attribution policy for this session. Defaults to
   * {@link DEFAULT_ENRICHMENT_POLICY} (real sources `unconfigured`, since A1
   * wires no transcript adapters); the daemon drives coverage and timing as
   * adapters are configured. Published once on startup and bound to each change. */
  enrichmentPolicy?: EnrichmentPolicy;
  /** Transcript-reading settings. When present with configured harnesses, the
   * session runs a coverage watcher that reads those harnesses' transcripts for
   * this worktree, ingesting evidence and disclosing coverage. */
  transcript?: TranscriptRuntime;
  /** Server clock for question TTL; no timers or expiry records. */
  now?: () => number;
}

export interface BeginTaskInput {
  title: string;
  /** Caller-supplied idempotency key. A retry with the same value commits once. */
  requestId: string;
}

export interface BeginTaskResult {
  session_id: string;
  task_id: string;
  /** The declaration event's `id`, which equals its `seq` (CloudEvents identity
   * is (source, id); a second UUID would add nothing). */
  event_id: string;
  seq: string;
}

/** A `request_id` was reused with a different title — a caller mistake, not a
 * retry, so it never commits a second declaration. */
export class InvalidTitleError extends Error {
  readonly code = 'INVALID_TITLE';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTitleError';
  }
}

export interface CaptureSession {
  sessionId: string;
  logPath: string;
  blobsDir: string;
  health: Health;
  /**
   * Declare a durable task boundary in-process. Appends one
   * `slipstream.task.started.v1`, ordered on the single append path, and resolves
   * only once it is durable. Idempotent per `requestId`; concurrent duplicates
   * coalesce onto one commit. A direct method by design — no IPC, no socket.
   */
  beginTask(input: BeginTaskInput): Promise<BeginTaskResult>;
  /**
   * Ingest one normalized harness-transcript record so it may refine attribution.
   * Evidence is durable, deduped, and append-only; it is NEVER a capture source
   * and never creates a filesystem-change event. A2 wires real transcript
   * adapters onto this seam; A1 exercises it with fake evidence.
   */
  ingestEvidence(evidence: NormalizedEvidence): Promise<IngestOutcome>;
  askQuestion(input: unknown, target: QuestionQueuedData['target'], assertOwnership?: () => void): Promise<QuestionAccepted>;
  claimQuestion(target: QuestionQueuedData['target'], assertOwnership?: () => void): Promise<(QuestionQueuedData & { queued_seq: string }) | null>;
  answerQuestion(input: { question_id: unknown; text: unknown }, target: QuestionQueuedData['target'], assertOwnership?: () => void): Promise<AnswerAccepted>;
  stop(): Promise<void>;
}

interface CaptureDependencies {
  createLog: typeof createLog;
  platform: Platform;
  enumerate: typeof enumerate;
  readQuestionContext: typeof readQuestionContext;
}

const defaultDependencies: CaptureDependencies = { createLog, platform: createPlatform(), enumerate, readQuestionContext };

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
  if (opts.sessionId !== undefined) {
    if (opts.resumeSessionId !== undefined) {
      throw new Error('sessionId and resumeSessionId are mutually exclusive');
    }
    if (!isValidSessionId(opts.sessionId)) {
      throw new Error(`sessionId is not a valid session UUID: ${opts.sessionId}`);
    }
  }
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
  // Fail before creating a session if its exclusion policy cannot be read.
  let captureIgnores = resuming ? undefined : await loadCaptureIgnores(root, storeDir);
  const sessionId = opts.resumeSessionId ?? opts.sessionId ?? randomUUID();
  const blobsDir = join(storeDir, 'blobs');
  const sessionDir = join(storeDir, 'sessions', sessionId);
  await mkdirpDurable(blobsDir);
  await mkdirpDurable(sessionDir);
  await assertOwnerOnly(sessionDir, 'dir'); // blobsDir perms are checked by createCas
  const logPath = join(sessionDir, 'events.jsonl');

  const cas = await createCas(blobsDir);

  // Durable task boundaries (Stage 3). `currentTaskId` is the latest committed
  // declaration in shared append order — the grouping hint stamped onto changes.
  // The two maps are the idempotency index keyed by `request_id`: `committedTasks`
  // replays a settled result, `inflightTasks` coalesces concurrent duplicates.
  // Both the pointer and the committed index are rebuilt from the log on recovery.
  const now = opts.now ?? Date.now;
  const committedQuestions = new Map<string, { body: string; result: QuestionAccepted }>();
  const inflightQuestions = new Map<string, { body: string; promise: Promise<QuestionAccepted> }>();
  const reservedQuestions = new Set<string>();
  // Questions not yet attempted. Removed once dispatch is attempted (durably
  // consumed either way) so eligibility counting and claim lookup scan only
  // outstanding questions, not every question ever queued by a long-lived capture.
  const unattemptedQuestions = new Map<string, QuestionQueuedEvent>();
  // Kept for the capture's lifetime: a question stays answerable after it
  // leaves the unattempted queue or passes its claim TTL.
  const questionsById = new Map<string, QuestionQueuedData>();
  const attemptSeqs = new Map<string, string>();
  const committedAnswers = new Map<string, { text: string; result: AnswerAccepted }>();
  const inflightAnswers = new Map<string, { text: string; promise: Promise<AnswerAccepted> }>();
  let currentTaskId: string | undefined;
  const committedTasks = new Map<string, { title: string; result: BeginTaskResult }>();
  const inflightTasks = new Map<string, { title: string; promise: Promise<BeginTaskResult> }>();

  // The attribution producer, constructed once the append path exists below. Its
  // `noteCommitted` is fed from the log's single in-order commit hook, so every
  // durably-committed change/evidence/policy reaches it exactly once, in order.
  let producer: AttributionProducer | undefined;

  const seedTaskState = (rec: RecoveredSession): void => {
    committedQuestions.clear();
    unattemptedQuestions.clear();
    for (const event of rec.questions) {
      committedQuestions.set(event.data.request_id, { body: questionBody(event.data), result: questionResult(event) });
      unattemptedQuestions.set(event.data.question_id, event);
    }
    for (const event of rec.questionAttempts) unattemptedQuestions.delete(event.data.question_id);
    questionsById.clear(); attemptSeqs.clear(); committedAnswers.clear();
    for (const event of rec.questions) questionsById.set(event.data.question_id, event.data);
    for (const event of rec.questionAttempts) attemptSeqs.set(event.data.question_id, event.seq);
    for (const event of rec.questionAnswers) committedAnswers.set(event.data.question_id, { text: event.data.text, result: answerResult(event) });
    currentTaskId = rec.currentTaskId;
    committedTasks.clear();
    for (const [requestId, decl] of rec.taskDeclarations) {
      committedTasks.set(requestId, {
        title: decl.title,
        result: Object.freeze({ session_id: sessionId, task_id: decl.taskId, event_id: decl.seq, seq: decl.seq }),
      });
    }
  };

  // Stamp grouping metadata inside the log's serialized sequencing section, the
  // single place with a total order over appends: a change is stamped with the
  // task committed before it, and the pointer advances only after a declaration
  // is durable. A newly emitted change carries no attribution — "no result yet"
  // means PENDING, and the producer appends a revisable result asynchronously
  // once the change is durable (never a fabricated inline `unknown` seed).
  const taskSequencer: AppendSequencer = {
    enrich: (input) => {
      if (input.type !== 'slipstream.file.changed.v1') return input;
      return {
        ...input,
        data: {
          ...input.data,
          ...(currentTaskId !== undefined ? { task_hint_id: currentTaskId } : {}),
        },
      };
    },
    onCommitted: (event) => {
      if (event.type === 'slipstream.task.started.v1') currentTaskId = event.data.task_id;
      // Route every durable commit to attribution in the same total order.
      if (event.type === 'slipstream.question.queued.v1') {
        unattemptedQuestions.set(event.data.question_id, event);
        questionsById.set(event.data.question_id, event.data);
      }
      if (event.type === 'slipstream.question.dispatch_attempted.v1') {
        unattemptedQuestions.delete(event.data.question_id);
        attemptSeqs.set(event.data.question_id, event.seq);
      }
      if (event.type === 'slipstream.question.answered.v1') {
        committedAnswers.set(event.data.question_id, { text: event.data.text, result: answerResult(event) });
      }
      if (event.type !== 'slipstream.question.queued.v1' && event.type !== 'slipstream.question.dispatch_attempted.v1'
        && event.type !== 'slipstream.question.answered.v1') producer?.noteCommitted(event);
    },
  };

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
      opts.onCompromised?.(reason);
    },
  });

  if (!resuming && opts.sessionId !== undefined) {
    // A fresh caller-supplied id must name a session that does not exist yet:
    // opening an existing log in append mode restarts sequencing at zero and
    // duplicates seqs. Resuming existing history requires resumeSessionId. The
    // check runs while we hold the session lock so a concurrent caller cannot
    // create then release the same id between the check and log creation.
    const logExists = await access(logPath).then(() => true, () => false);
    if (logExists) {
      await lock.release();
      throw new Error(
        `cannot start a fresh session ${sessionId}: a log already exists at ${logPath}; use resumeSessionId to continue it`,
      );
    }
  }

  let recovered: RecoveredSession | undefined;
  if (resuming) {
    try {
      await assertOwnerOnly(logPath, 'file').catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      });
      recovered = await recoverSession(logPath, sessionId, cas);
      captureIgnores = recovered.captureIgnores;
      if (recovered.root === undefined) {
        throw new Error(`cannot resume session ${sessionId}: no existing session.started record`);
      }
      if (recovered.root !== root) {
        throw new Error(`session ${sessionId} is bound to ${recovered.root}, not ${root}`);
      }
      seedTaskState(recovered); // rebuild the dedup index + current task before appends
    } catch (err) {
      await lock.release(); // a failed resume must not leave the session locked
      throw err;
    }
  }

  const maxBytes = recovered?.maxBytes ?? opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const enrichmentPolicy = opts.enrichmentPolicy ?? DEFAULT_ENRICHMENT_POLICY;
  const health = createHealth(recovered?.recoveredThroughSeq ?? 0n);
  healthRef = health; // the compromise callback can now disclose a lost lock

  let underlying: Log;
  try {
    underlying = await deps.createLog({
      filePath: logPath,
      sessionId,
      startSeq: recovered?.recoveredThroughSeq,
      sequencer: taskSequencer,
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
  function appendEvent(input: EventInput): Promise<AnyEvent>;
  function appendEvent(input: QuestionQueuedInput): Promise<QuestionQueuedEvent>;
  function appendEvent(input: QuestionDispatchAttemptedInput): Promise<QuestionDispatchAttemptedEvent>;
  function appendEvent(input: QuestionAnsweredInput): Promise<QuestionAnsweredEvent>;
  function appendEvent(input: PublicEventInput): Promise<PublicEvent>;
  async function appendEvent(input: PublicEventInput): Promise<PublicEvent> {
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

  // Attribution runs off the same append path. Timers are unref'd so a pending
  // grace window never keeps the process alive; the clock is real wall time.
  producer = createAttributionProducer({
    appendEvent,
    now: Date.now,
    setTimer: (delayMs, fn) => {
      const t = setTimeout(fn, delayMs);
      t.unref?.();
      return t;
    },
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });

  // Never capture the store or version-control metadata. If the store lives
  // inside the watched root, excluding it is what stops the watcher from
  // observing its own output.
  const excluded = [storeDir, join(root, '.git')];
  const ignorePath = captureIgnores === undefined ? undefined : compileCaptureIgnores(captureIgnores);
  const isExcluded = (abs: string, isDir = false): boolean => {
    if (excluded.some((e) => isUnder(abs, e))) return true;
    const rel = relative(root, abs);
    return rel !== '' && !escapesBase(rel) && (ignorePath?.(rel.split(sep).join('/'), isDir) ?? false);
  };

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
    append: (input: EventInput) => Promise<PublicEvent>,
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
          data: {
            path,
            before,
            after,
            observation: 'reconciliation',
            gap_ref: gapSeq,
            // A reconciliation endpoint is a state diff discovered on restart, not a
            // watched transition, so it cannot bound a real interval. Disclose that
            // explicitly rather than fabricate one; attribution reads it as unknown.
            observed_interval_ms: { unavailable: true, reason: 'reconciliation' },
          },
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
    // A recovery attempt that finishes during stop() must not re-enable the engine
    // or flush the buffer: stop() has already unsubscribed and is draining toward
    // lock release, and no observation may be appended past that point.
    if (stopped) return;
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
      // Fence the attribution generation before the log is swapped: a stale
      // evaluation from the pre-recovery generation must never append to the
      // reopened log. A fresh generation is armed after the log reopens.
      await producer?.stop();
      if (stopped || surrendered) return false; // shutting down / dispossessed: don't reopen
      await underlying.close().catch(() => {});
      const rec = await recoverSession(logPath, sessionId, cas);
      // Rebuild the dedup index + current task from the durable log before the log
      // reopens: an in-process recovery must not leave a duplicate-commit window,
      // and reconciliation changes below must stamp the recovered current task.
      seedTaskState(rec);
      underlying = await deps.createLog({
        filePath: logPath,
        sessionId,
        startSeq: rec.recoveredThroughSeq,
        sequencer: taskSequencer,
      });
      health.setDurableSeq(rec.recoveredThroughSeq);
      health.markRecovering();

      // Replay barrier for the new generation: rebuild projections and outstanding
      // work from the recovered durable log (seeding prior results so nothing is
      // re-attributed), and re-assert the effective policy, before the storage gap
      // and reconciliation changes below route through the producer.
      producer?.start(rec.attributionEvents);
      await producer?.ensurePolicy(enrichmentPolicy);

      const rawAppend = async (input: EventInput): Promise<PublicEvent> => {
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
      // Replay barrier: rebuild the producer's projections and reconstruct
      // outstanding work from the durable log, seeding prior results so a
      // reproduced attribution is not re-appended, BEFORE any new commit routes
      // through it. The reconciliation changes below then attribute live.
      producer.start(recovered!.attributionEvents);
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
      await producer.ensurePolicy(enrichmentPolicy);
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
        data: { root, max_bytes: maxBytes, capture_ignores: captureIgnores },
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
      // Arm attribution and publish the effective policy before going live, so
      // the first live change binds to a committed policy.
      producer.start([]);
      await producer.ensurePolicy(enrichmentPolicy);
    }
  } catch (err) {
    // A failed startup may already have kicked the recovery supervisor (an append
    // fault calls enterFailing). Stop it and await the in-flight attempt before
    // releasing the lock, or its next reopen could write to a log a second owner
    // has since acquired — the same ordering `stop()` relies on.
    stopped = true;
    await subscription?.close().catch(() => {});
    await supervisorLoop.catch(() => {});
    await producer.stop().catch(() => {});
    await engine.drain().catch(() => {});
    await underlying.close().catch(() => {});
    await lock.release();
    throw err;
  }

  goLive();
  health.markHealthy();

  const ingestEvidence = (evidence: NormalizedEvidence): Promise<IngestOutcome> =>
    producer!.ingestEvidence(evidence);

  // The transcript coverage watcher (A2): reads configured harnesses' transcripts
  // for this worktree as revisable evidence. It never creates a change and its
  // evidence flows through the same deduped, append-only producer path, so a
  // re-read (including a late transcript after a restart) revises without
  // duplicating. Runs only when a harness is actually configured.
  let coverageRunner: CoverageRunner | undefined;
  const tc = opts.transcript;
  if (tc && tc.harnesses.length > 0) {
    coverageRunner = createCoverageRunner({
      harnesses: tc.harnesses,
      homes: tc.homes,
      codexScanLimit: tc.codexScanLimit,
      root,
      sink: { ingest: ingestEvidence },
      publish: async (data) => {
        await appendEvent({ type: 'slipstream.enrichment.coverage.v1', occurred_at_ms: Date.now(), data });
      },
      discoveryIO: tc.discoveryIO ?? nodeDiscoveryIO,
      fileIO: tc.fileIO ?? nodeTranscriptFileIO,
      intervalMs: tc.pollIntervalMs ?? DEFAULT_TRANSCRIPT_POLL_MS,
      onError: (err) => console.error(`slipstream: transcript watcher error: ${(err as Error).message}`),
    });
    coverageRunner.start();
  }

  const beginTask = async ({ title, requestId }: BeginTaskInput): Promise<BeginTaskResult> => {
    // Readiness: only a live, healthy, still-owned session may declare a task.
    // Domain error codes (CAPTURE_NOT_READY, STORAGE_UNAVAILABLE, ...) are a later
    // PR's forwarder concern; in-process this is a plain refusal.
    if (stopped || surrendered || health.snapshot().state !== 'healthy') {
      throw new Error('capture session is not ready to accept task declarations');
    }
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('beginTask requires a non-empty request_id');
    }
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error('beginTask requires a non-empty title');
    }

    // Idempotency keyed by (capture session, request_id); this session is the key's
    // session component, so request_id alone indexes within it. A settled result
    // replays as-is; a same-key call still in flight coalesces onto it; a reused
    // key with a different title is a caller mistake, not a retry.
    const settled = committedTasks.get(requestId);
    if (settled !== undefined) {
      if (settled.title !== title) {
        throw new InvalidTitleError(`request_id ${requestId} was already used for a different title`);
      }
      return settled.result;
    }
    const pending = inflightTasks.get(requestId);
    if (pending !== undefined) {
      if (pending.title !== title) {
        throw new InvalidTitleError(`request_id ${requestId} is in flight for a different title`);
      }
      return pending.promise;
    }

    // The registration below is synchronous (no await precedes it), so a
    // concurrent duplicate observes the in-flight entry and never starts a second
    // append. `task_id` is minted here; `request_id` is the caller's.
    const taskId = randomUUID();
    const promise = (async (): Promise<BeginTaskResult> => {
      const event = await appendEvent({
        type: 'slipstream.task.started.v1',
        occurred_at_ms: Date.now(),
        data: { task_id: taskId, request_id: requestId, title },
      });
      // The record may have landed durably while ownership was lost mid-fsync (an
      // accepted residual the new owner reconciles). A surrendered session must
      // not ACKNOWLEDGE the commit or cache it as a settled result — acknowledging
      // after surrender is exactly what the lost lock forbids.
      if (surrendered) {
        throw new StorageError(
          'lock',
          Object.assign(new Error('session ownership lost'), { code: 'ELOCKLOST' }),
        );
      }
      // Frozen so a caller cannot mutate the object the dedup index hands back to
      // every future retry (the result is an immutable identity record).
      const result: BeginTaskResult = Object.freeze({
        session_id: sessionId,
        task_id: taskId,
        event_id: event.id, // equals seq by construction
        seq: event.seq,
      });
      committedTasks.set(requestId, { title, result });
      return result;
    })();
    inflightTasks.set(requestId, { title, promise });
    try {
      return await promise;
    } finally {
      inflightTasks.delete(requestId);
    }
  };

  const questionReady = (): void => {
    if (stopped) throw new QuestionError('CAPTURE_NOT_READY', 'capture is stopping');
    if (surrendered || health.snapshot().state === 'failing' || health.snapshot().state === 'recovering') {
      throw new QuestionError('STORAGE_UNAVAILABLE', 'capture storage is unavailable');
    }
    if (health.snapshot().state !== 'healthy') throw new QuestionError('CAPTURE_NOT_READY', 'capture is not ready');
  };

  const askQuestion = async (input: unknown, target: QuestionQueuedData['target'], assertOwnership: () => void = () => {}): Promise<QuestionAccepted> => {
    const req = normalizeAsk(input);
    if (req.session_id !== sessionId) throw new QuestionError('SESSION_NOT_SELECTED', 'question addresses a different capture');
    assertOwnership();
    questionReady();
    const body = questionBody(req);
    const settled = committedQuestions.get(req.request_id);
    const pending = inflightQuestions.get(req.request_id);
    const existing = settled ?? pending;
    if (existing && existing.body !== body) throw new QuestionError('REQUEST_CONFLICT', 'request_id was used for a different question or context');
    if (settled) return { ...settled.result, duplicate: true };
    if (pending) return { ...await pending.promise, duplicate: true };
    if (req.reply_to_question_id !== undefined) {
      const parent = questionsById.get(req.reply_to_question_id)?.context;
      const c = req.context;
      if (!parent || parent.change_seq !== c.change_seq || parent.path !== c.path || parent.snapshot_sha256 !== c.snapshot_sha256
        || parent.line_start !== c.line_start || parent.line_end !== c.line_end) {
        throw new QuestionError('INVALID_CONTEXT', 'a follow-up must reply to a question in this capture about the same source');
      }
    }
    // A reservation covers source reads as well as append, bounding concurrent scans.
    // An expired-but-never-attempted entry can never become eligible again, so it
    // is dropped here rather than kept forever awaiting a claim that will not come.
    let eligible = 0;
    for (const [id, q] of unattemptedQuestions) {
      if (now() < q.data.expires_at_ms) eligible += 1;
      else unattemptedQuestions.delete(id);
    }
    const reserved = [...inflightQuestions.keys()].filter(id => !committedQuestions.has(id)).length;
    if (eligible + reserved >= QUESTION_LIMIT) throw new QuestionError('QUESTION_LIMIT', 'at most 16 unexpired questions may be queued');
    // Defer starting I/O until the in-flight reservation is installed synchronously.
    const promise = Promise.resolve().then(async (): Promise<QuestionAccepted> => {
      const selected_text = await deps.readQuestionContext({ storeDir, logPath, sessionId,
        boundary: BigInt(health.snapshot().durable_seq), context: req.context });
      assertOwnership();
      questionReady();
      const queued_at_ms = now();
      const event = await appendEvent({ type: 'slipstream.question.queued.v1', occurred_at_ms: queued_at_ms,
        data: { question_id: randomUUID(), request_id: req.request_id, target, text: req.text,
          context: { ...req.context, selected_text }, queued_at_ms, expires_at_ms: queued_at_ms + QUESTION_TTL_MS,
          ...(req.reply_to_question_id !== undefined ? { reply_to_question_id: req.reply_to_question_id } : {}) } });
      if (surrendered) throw new StorageError('lock', Object.assign(new Error('session ownership lost'), { code: 'ELOCKLOST' }));
      assertOwnership();
      const result = questionResult(event);
      committedQuestions.set(req.request_id, { body, result });
      return result;
    });
    inflightQuestions.set(req.request_id, { body, promise });
    try { return await promise; }
    finally { inflightQuestions.delete(req.request_id); }
  };

  const claimQuestion = async (target: QuestionQueuedData['target'], assertOwnership: () => void = () => {}): Promise<(QuestionQueuedData & { queued_seq: string }) | null> => {
    assertOwnership();
    questionReady();
    const queued = [...unattemptedQuestions.values()].find(q => q.data.target.harness === target.harness
      && q.data.target.harness_session_id === target.harness_session_id
      && q.data.target.worktree === target.worktree
      && now() < q.data.expires_at_ms
      && !reservedQuestions.has(q.data.question_id));
    if (!queued) return null;
    const id = queued.data.question_id;
    reservedQuestions.add(id);
    try {
      const attempted_at_ms = now();
      await appendEvent({ type: 'slipstream.question.dispatch_attempted.v1', occurred_at_ms: attempted_at_ms,
        data: { question_id: id, queued_seq: queued.seq, attempted_at_ms } });
      if (surrendered) throw new StorageError('lock', Object.assign(new Error('session ownership lost'), { code: 'ELOCKLOST' }));
      assertOwnership();
      return { ...queued.data, queued_seq: queued.seq };
    } finally { reservedQuestions.delete(id); }
  };

  // Order: INVALID_ANSWER, then QUESTION_NOT_FOUND (which also hides questions
  // dispatched to another harness session), then duplicate or ANSWER_CONFLICT.
  const answerQuestion = async (input: { question_id: unknown; text: unknown }, target: QuestionQueuedData['target'], assertOwnership: () => void = () => {}): Promise<AnswerAccepted> => {
    const { question_id: id, text } = input;
    assertAnswerText(text);
    assertOwnership();
    questionReady();
    const owner = typeof id === 'string' ? questionsById.get(id)?.target : undefined;
    const attemptSeq = typeof id === 'string' ? attemptSeqs.get(id) : undefined;
    if (typeof id !== 'string' || !owner || attemptSeq === undefined || owner.harness !== target.harness
      || owner.harness_session_id !== target.harness_session_id || owner.worktree !== target.worktree) {
      throw new QuestionError('QUESTION_NOT_FOUND', 'no question with that id was dispatched to this harness session');
    }
    const settled = committedAnswers.get(id);
    const pending = inflightAnswers.get(id);
    const existing = settled ?? pending;
    if (existing && existing.text !== text) throw new QuestionError('ANSWER_CONFLICT', 'this question already has a different answer');
    if (settled) return { ...settled.result, duplicate: true };
    if (pending) return { ...await pending.promise, duplicate: true };
    const promise = Promise.resolve().then(async (): Promise<AnswerAccepted> => {
      const answered_at_ms = now();
      const event = await appendEvent({ type: 'slipstream.question.answered.v1', occurred_at_ms: answered_at_ms,
        data: { question_id: id, attempt_seq: attemptSeq, text, answered_at_ms } });
      if (surrendered) throw new StorageError('lock', Object.assign(new Error('session ownership lost'), { code: 'ELOCKLOST' }));
      assertOwnership();
      return answerResult(event);
    });
    inflightAnswers.set(id, { text, promise });
    try { return await promise; }
    finally { inflightAnswers.delete(id); }
  };

  const doStop = async (): Promise<void> => {
    stopped = true;
    // Stop feeding the engine immediately: if the watcher unsubscribe below
    // rejects, late observations buffer instead of appending after the lock is
    // released. Every step is then best-effort so a single failure never skips
    // closing the log or releasing the lock; the first error is rethrown.
    live = false;
    let firstError: unknown;
    const record = (err: unknown): void => {
      if (firstError === undefined) firstError = err;
    };
    // Stop the coverage watcher before the producer and log close: it appends
    // evidence and coverage through both, and an append after close would throw.
    await coverageRunner?.stop().catch(record);
    await subscription?.close().catch(record);
    // Await any in-flight recovery: it may be mid-reopen, and appending after
    // we release the lock would let a second owner's writes interleave. The
    // loop stops starting new attempts once `stopped` is set.
    await supervisorLoop.catch(() => {});
    await engine.drain().catch(record);
    // Fence the attribution generation and flush its in-flight appends before the
    // log closes: a stale evaluation must never append after the log is gone.
    await producer?.stop().catch(record);
    await Promise.allSettled([...inflightQuestions.values(), ...inflightAnswers.values()].map(q => q.promise));
    await underlying.close().catch(record);
    await lock.release().catch(record);
    if (firstError !== undefined) throw firstError;
  };
  // Memoized so an overlapping detach + daemon shutdown (both hold the same
  // handle) run teardown once. Two concurrent releases could otherwise both read
  // the current nonce and the loser could unlink a successor's lock.
  let stopPromise: Promise<void> | undefined;

  return {
    sessionId,
    logPath,
    blobsDir,
    health,
    beginTask,
    askQuestion,
    claimQuestion,
    answerQuestion,
    ingestEvidence,
    stop: () => (stopPromise ??= doStop()),
  };
}

interface EnumerateHandlers {
  onFile: (rel: string) => Promise<void>;
  onDirError: (relDir: string) => Promise<void>;
}

async function enumerate(
  root: string,
  dir: string,
  isExcluded: (abs: string, isDir?: boolean) => boolean,
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
    if (entry.isSymbolicLink()) continue; // excluded, never followed
    if (isExcluded(abs, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      await enumerate(root, abs, isExcluded, handlers);
    } else if (entry.isFile()) {
      await handlers.onFile(relative(root, abs));
    }
  }
}
