import { access, lstat, mkdtemp, readdir, readFile, realpath, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createCas, type Cas } from './cas.ts';
import { createReader, DEFAULT_MAX_BYTES, type Reader } from './reader.ts';
import { createLog, type AppendSequencer, type Log } from './log.ts';
import { addUnknownScope, createEngine, isUnderUnknownScope } from './engine.ts';
import { detectCaptureScope, type CaptureScope, type DetectCaptureScope } from './capture-scope.ts';
import { createHealth, type Health, type HealthFailure } from './health.ts';
import { acquireSessionLock, type SessionLock } from './lock.ts';
import { recoverSession, type RecoveredSession } from './recovery.ts';
import { StorageError, assertOwnerOnly, mkdirpDurable } from './storage.ts';
import { snapshotsEqual, type Snapshot } from './snapshot.ts';
import { finalRecord, isValidSessionId } from './store-reader.ts';
import { createPlatform, type Platform, type Subscription } from './platform.ts';
import {
  createAttributionProducer,
  DEFAULT_ENRICHMENT_POLICY,
  type AttributionProducer,
} from './attribution-producer.ts';
import type { IngestOutcome, NormalizedEvidence } from './evidence-ingest.ts';
import { EVENT_TYPES, type AnyEvent, type EnrichmentPolicy, type EventInput, type HarnessName } from './event.ts';
import type { AgentBindingEvent, AgentBindingInput, AgentConnectionEvent, AgentConnectionInput, AgentUnlinkedEvent, AgentUnlinkedInput, CaptureMode, CaptureStopReason, CaptureScopeInput, PublicEvent, PublicEventInput, QuestionQueuedData, QuestionQueuedInput, QuestionQueuedEvent, QuestionDispatchAttemptedInput, QuestionDispatchAttemptedEvent, QuestionAnsweredInput, QuestionAnsweredEvent, QuestionExchangeRecordedInput, QuestionExchangeRecordedEvent, QuestionRelayUpdatedInput, QuestionRelayUpdatedEvent } from './public-events.ts';
import { normalizeAsk, questionBody, questionResult, readQuestionContext, QuestionError, QUESTION_TTL_MS, QUESTION_LIMIT, type QuestionAccepted, assertAnswerText, answerResult, type AnswerAccepted, normalizeExchange, exchangeBody, exchangeResult, sameSourceContext, type QuestionExchangeAccepted, type QuestionContext, normalizeRelayUpdate, relayUpdateBody, relayUpdateResult, type QuestionRelayUpdateAccepted } from './questions.ts';
import type { TranscriptScheduler } from './transcript/scheduler.ts';

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
  /** The device and inode the root had when its capture was admitted. A root
   * that no longer has them, before or after the watcher is installed, is a
   * different directory: the start fails with {@link RootChangedError}. */
  rootIdentity?: { dev: string; ino: string };
  /** Recorded on this activation's `session.started`/`session.resumed`. */
  captureMode?: CaptureMode;
  /** Notified once if this session loses its lock to another owner. Capture has
   * already stopped acknowledging by the time this fires; the daemon uses it to
   * wedge its state machine (decision 9). */
  onCompromised?: (reason: string) => void;
  /** Notified once when this activation can no longer observe its root: the root
   * was deleted or replaced (its device or inode changed), or the watcher
   * subscription closed. A closed subscription has already disclosed its
   * `capture.gap{watcher-error}`. The caller ends the activation with
   * `stop({ reason })` (contracts.md §2). */
  onTerminal?: (reason: 'root-missing' | 'watcher-failed', message: string) => void;
  /** Notified when a storage outage begins (`failing`, once per outage) and when
   * recovery ends it (`healthy`). The daemon records the outage in its intent so
   * offline readers see it too (contracts.md §6). */
  onStorage?: (state: 'failing' | 'healthy', failure?: HealthFailure) => void;
  /** The effective attribution policy for this session. Defaults to
   * {@link DEFAULT_ENRICHMENT_POLICY} (real sources `unconfigured`, since A1
   * wires no transcript adapters); the daemon drives coverage and timing as
   * adapters are configured. Published once on startup and bound to each change. */
  enrichmentPolicy?: EnrichmentPolicy;
  /** The shared transcript scheduler, present only when enrichment is configured.
   * The live session registers its worktree there, so configured harnesses'
   * transcripts are read as evidence and their coverage disclosed. Absent means no
   * transcript is read — an `unknown` honestly means "nothing was watched". */
  transcript?: TranscriptScheduler;
  /** The store's blob store. A process running several captures over one store
   * must share one instance: it is what makes a blob another capture is still
   * publishing safe to trust. Absent means a private instance. */
  cas?: Cas;
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
export class RootChangedError extends Error {}

export class InvalidTitleError extends Error {
  readonly code = 'INVALID_TITLE';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTitleError';
  }
}

/** Appends `capture.stopped{reason}` as the activation's final record; a stop
 * without options records nothing (daemon shutdown leaves the hole to the
 * heartbeat). `unlinkGeneration` names a binding withdrawn with the capture:
 * `agent.unlinked{reason}` is appended immediately before the stop.
 * `assertOwnership` runs immediately before each of those appends; a throw records
 * nothing more. */
export type StopOptions =
  | { reason: 'detached' | 'archived'; unlinkGeneration?: string; assertOwnership?: () => void }
  | { reason: Exclude<CaptureStopReason, 'detached' | 'archived'>; unlinkGeneration?: undefined; assertOwnership?: () => void };

type AgentInput = AgentConnectionInput | AgentBindingInput | AgentUnlinkedInput;
type AgentEventFor<I extends AgentInput> = I extends AgentConnectionInput ? AgentConnectionEvent
  : I extends AgentBindingInput ? AgentBindingEvent : AgentUnlinkedEvent;

const CORE_EVENT_TYPES = new Set<string>(EVENT_TYPES);
const isCoreEvent = (event: PublicEvent): event is AnyEvent => CORE_EVENT_TYPES.has(event.type);

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
  /** Record a question and the answer the client's own forked chat produced; appends exactly one event. */
  recordQuestionExchange(input: unknown, assertOwnership?: () => void): Promise<QuestionExchangeAccepted>;
  /** Record one later step of a change request sent from a recorded exchange; appends exactly one event. */
  recordQuestionRelayUpdate(input: unknown, assertOwnership?: () => void): Promise<QuestionRelayUpdateAccepted>;
  claimQuestion(target: QuestionQueuedData['target'], assertOwnership?: () => void): Promise<(QuestionQueuedData & { queued_seq: string }) | null>;
  answerQuestion(input: { question_id: unknown; text: unknown }, target: QuestionQueuedData['target'], assertOwnership?: () => void): Promise<AnswerAccepted>;
  /** Durably record a chat binding, its handshake state, or its revocation; never attribution. */
  recordAgent<I extends AgentInput>(input: I, assertOwnership?: () => void): Promise<AgentEventFor<I>>;
  /** Whether this session's log holds an `agent.binding` at `generation`. */
  bindingRecorded(generation: string): boolean;
  stop(opts?: StopOptions): Promise<void>;
}

interface CaptureDependencies {
  createLog: typeof createLog;
  platform: Platform;
  enumerate: typeof enumerate;
  readQuestionContext: typeof readQuestionContext;
  detectScope: DetectCaptureScope;
}

const defaultDependencies: CaptureDependencies = {
  createLog,
  platform: createPlatform(),
  enumerate,
  readQuestionContext,
  detectScope: detectCaptureScope,
};

/** A relative path escapes its base only via a leading `..` segment (or when it
 * comes back absolute); a filename that merely starts with `..`, like
 * `..notes.ts`, stays inside. */
function escapesBase(rel: string): boolean {
  return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
}

function isUnder(child: string, parent: string): boolean {
  return !escapesBase(relative(parent, child));
}

/** A frozen copy of the root `.slipstreamignore`, handed to git as its
 * lowest-precedence excludes file so capture can drop extra paths — including
 * tracked ones git would merge. Copied once so a mid-capture edit does not
 * change this capture's scope; a later restart re-reads it, matching how git's
 * own rule changes take effect. Returns undefined when the file is absent or
 * empty. A file that exists but cannot be read rejects rather than silently
 * widening scope to paths the user meant to exclude. Only consulted inside a
 * git work tree; a non-git root ignores the file. */
async function freezeSlipstreamIgnore(root: string): Promise<{ dir: string; file: string } | undefined> {
  const path = join(root, '.slipstreamignore');
  // Stat (which follows symlinks but never blocks) before opening: a named pipe
  // or other non-regular file would otherwise hang the read and stall startup.
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (!info.isFile()) throw new Error(`.slipstreamignore is not a regular file`);
  const content = await readFile(path, 'utf8');
  if (content.trim() === '') return undefined;
  const dir = await mkdtemp(join(tmpdir(), 'slip-ignore-'));
  const file = join(dir, 'excludes');
  await writeFile(file, content);
  return { dir, file };
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
  const rootStat = await stat(root, { bigint: true });
  const expected = opts.rootIdentity;
  const replaced = (st: { dev: bigint; ino: bigint } | undefined): boolean => expected !== undefined
    && (st?.dev.toString() !== expected.dev || st.ino.toString() !== expected.ino);
  if (replaced(rootStat)) {
    throw new RootChangedError(`the workspace root ${root} was replaced; a directory recreated there is captured under a new session`);
  }
  // Validate the store before freezing anything, so a bad store directory fails
  // without leaving a frozen copy of the ignore rules behind.
  await mkdirpDurable(opts.storeDir);
  const storeDir = await realpath(opts.storeDir);
  await assertOwnerOnly(storeDir, 'dir');
  if (isUnder(root, storeDir)) {
    throw new Error('store directory must not equal or contain the watched root');
  }
  // Decided before anything is written: a git root git cannot read rejects here
  // rather than silently capturing what git would not merge.
  const baseScope = await deps.detectScope(root);
  // Only a git work tree honors .slipstreamignore; a non-git root never reads it
  // (so an unreadable file there does not block capture). Frozen before
  // classification so a mid-capture edit does not change this capture's scope;
  // cleaned up on a failed start, in the catches below, and in stop().
  let frozenSlip: { dir: string; file: string } | undefined;
  let scope: CaptureScope = baseScope;
  if (baseScope.policy === 'git') {
    try {
      frozenSlip = await freezeSlipstreamIgnore(root);
      if (frozenSlip) scope = await deps.detectScope(root, frozenSlip.file);
    } catch (err) {
      if (frozenSlip) await rm(frozenSlip.dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
  const slipstreamApplied = frozenSlip !== undefined;

  const resuming = opts.resumeSessionId !== undefined;
  const captureModeField = opts.captureMode ? { capture_mode: opts.captureMode } : {};
  const sessionId = opts.resumeSessionId ?? opts.sessionId ?? randomUUID();
  const blobsDir = join(storeDir, 'blobs');
  const sessionDir = join(storeDir, 'sessions', sessionId);
  await mkdirpDurable(blobsDir);
  await mkdirpDurable(sessionDir);
  await assertOwnerOnly(sessionDir, 'dir'); // blobsDir perms are checked by createCas
  const logPath = join(sessionDir, 'events.jsonl');

  const cas = opts.cas ?? await createCas(blobsDir);

  // Durable task boundaries (Stage 3). `currentTaskId` is the latest committed
  // declaration in shared append order — the grouping hint stamped onto changes.
  // The two maps are the idempotency index keyed by `request_id`: `committedTasks`
  // replays a settled result, `inflightTasks` coalesces concurrent duplicates.
  // Both the pointer and the committed index are rebuilt from the log on recovery.
  const now = opts.now ?? Date.now;
  const committedQuestions = new Map<string, { body: string; result: QuestionAccepted }>();
  const inflightQuestions = new Map<string, { body: string; promise: Promise<QuestionAccepted> }>();
  const reservedQuestions = new Set<string>();
  // Exchanges are a separate namespace: they never queue, expire, count against
  // QUESTION_LIMIT, or appear in the ask follow-up lookup.
  const committedExchanges = new Map<string, { body: string; result: QuestionExchangeAccepted }>();
  const inflightExchanges = new Map<string, { body: string; promise: Promise<QuestionExchangeAccepted> }>();
  const exchangesById = new Map<string, QuestionContext>();
  // relay_id -> question_id for every committed send. A relay_id is reserved while
  // its append is in flight, so a concurrent reuse is refused before either lands.
  const relayQuestions = new Map<string, string>();
  const reservedRelays = new Set<string>();
  const committedRelayUpdates = new Map<string, { body: string; result: QuestionRelayUpdateAccepted }>();
  const inflightRelayUpdates = new Map<string, { body: string; promise: Promise<QuestionRelayUpdateAccepted> }>();
  const sourceContext = (context: QuestionContext): QuestionContext => ({
    change_seq: context.change_seq,
    path: context.path,
    snapshot_sha256: context.snapshot_sha256,
    line_start: context.line_start,
    line_end: context.line_end,
  });
  // Questions a chat may claim. Removed once dispatch is attempted (durably
  // consumed either way) or answered, so eligibility counting and claim lookup
  // scan only outstanding questions, not every question ever queued by a
  // long-lived capture. An unlink re-arms the unanswered ones for the next chat.
  const claimableQuestions = new Map<string, QuestionQueuedEvent>();
  // Kept for the capture's lifetime: a question stays answerable after it
  // leaves the claimable queue or passes its claim TTL.
  const questionsById = new Map<string, QuestionQueuedEvent>();
  // Every chat a question was handed to, in attempt order.
  const attemptsById = new Map<string, Array<{ target: QuestionQueuedData['target']; seq: string }>>();
  let latestResumeSeq = 0n;
  const committedAnswers = new Map<string, { text: string; result: AnswerAccepted }>();
  const inflightAnswers = new Map<string, { text: string; promise: Promise<AnswerAccepted> }>();
  let currentTaskId: string | undefined;
  const committedTasks = new Map<string, { title: string; result: BeginTaskResult }>();
  const inflightTasks = new Map<string, { title: string; promise: Promise<BeginTaskResult> }>();

  const pruneExpiredClaimableQuestions = (): void => {
    const currentTime = now();
    for (const [id, queued] of claimableQuestions) {
      if (currentTime >= queued.data.expires_at_ms) claimableQuestions.delete(id);
    }
  };

  // The attribution producer, constructed once the append path exists below. Its
  // `noteCommitted` is fed from the log's single in-order commit hook, so every
  // durably-committed change/evidence/policy reaches it exactly once, in order.
  let producer: AttributionProducer | undefined;

  const noteAttempt = (event: QuestionDispatchAttemptedEvent): void => {
    const id = event.data.question_id;
    // An attempt written before attempts recorded their chat went to the queued target.
    const target = event.data.target ?? questionsById.get(id)!.data.target;
    const attempts = attemptsById.get(id) ?? [];
    attempts.push({ target, seq: event.seq });
    attemptsById.set(id, attempts);
  };

  const seedTaskState = (rec: RecoveredSession): void => {
    committedQuestions.clear(); claimableQuestions.clear(); questionsById.clear(); attemptsById.clear(); committedAnswers.clear();
    latestResumeSeq = rec.resumeSeq;
    for (const event of rec.questions) {
      committedQuestions.set(event.data.request_id, { body: questionBody(event.data), result: questionResult(event) });
      questionsById.set(event.data.question_id, event);
      // Questions queued before the latest resume stay history only (D2).
      if (BigInt(event.seq) > rec.resumeSeq) claimableQuestions.set(event.data.question_id, event);
    }
    for (const event of rec.questionAttempts) {
      noteAttempt(event);
      if (BigInt(event.seq) > rec.unlinkSeq) claimableQuestions.delete(event.data.question_id);
    }
    for (const event of rec.questionAnswers) {
      committedAnswers.set(event.data.question_id, { text: event.data.text, result: answerResult(event) });
      claimableQuestions.delete(event.data.question_id);
    }
    pruneExpiredClaimableQuestions();
    committedExchanges.clear(); exchangesById.clear();
    for (const event of rec.questionExchanges) {
      committedExchanges.set(event.data.request_id, { body: exchangeBody(event.data), result: exchangeResult(event) });
      exchangesById.set(event.data.question_id, sourceContext(event.data.context));
    }
    relayQuestions.clear();
    for (const [relayId, questionId] of rec.relayQuestions) relayQuestions.set(relayId, questionId);
    committedRelayUpdates.clear();
    for (const event of rec.questionRelayUpdates) {
      committedRelayUpdates.set(event.data.request_id, { body: relayUpdateBody(event.data), result: relayUpdateResult(event) });
    }
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
      // A resume or an unlinked chat leaves no current task (D1). A resume leaves no
      // claimable questions (D2); an unlink hands every unanswered question queued
      // since the latest resume to whichever chat is linked next.
      if (event.type === 'slipstream.session.resumed.v1') {
        currentTaskId = undefined;
        latestResumeSeq = BigInt(event.seq);
        claimableQuestions.clear();
      }
      if (event.type === 'slipstream.agent.unlinked.v1') {
        currentTaskId = undefined;
        // Rebuilt in queue order so claims stay oldest first.
        claimableQuestions.clear();
        for (const [id, queued] of questionsById) {
          if (BigInt(queued.seq) > latestResumeSeq && !committedAnswers.has(id)) claimableQuestions.set(id, queued);
        }
        pruneExpiredClaimableQuestions();
      }
      if (event.type === 'slipstream.task.started.v1') currentTaskId = event.data.task_id;
      // Route every durable commit to attribution in the same total order.
      if (event.type === 'slipstream.question.queued.v1') {
        claimableQuestions.set(event.data.question_id, event);
        questionsById.set(event.data.question_id, event);
      }
      if (event.type === 'slipstream.question.dispatch_attempted.v1') {
        claimableQuestions.delete(event.data.question_id);
        noteAttempt(event);
      }
      if (event.type === 'slipstream.question.answered.v1') {
        committedAnswers.set(event.data.question_id, { text: event.data.text, result: answerResult(event) });
        claimableQuestions.delete(event.data.question_id);
      }
      if (event.type === 'slipstream.question.exchange_recorded.v1') {
        exchangesById.set(event.data.question_id, sourceContext(event.data.context));
        if (event.data.relay) relayQuestions.set(event.data.relay.relay_id, event.data.question_id);
      }
      if (event.type === 'slipstream.question.relay_updated.v1' && event.data.update.kind === 'sent') {
        relayQuestions.set(event.data.relay_id, event.data.question_id);
      }
      if (isCoreEvent(event)) producer?.noteCommitted(event);
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
    // A log holding no complete record (a first start that failed before its
    // `session.started` became durable) recorded nothing, so it starts afresh.
    try {
      const logExists = await access(logPath).then(() => true, () => false);
      const unstarted = logExists && await finalRecord(logPath).then((r) => r === undefined, () => false);
      if (unstarted) await truncate(logPath, 0);
      if (logExists && !unstarted) {
        throw new Error(
          `cannot start a fresh session ${sessionId}: a log already exists at ${logPath}; use resumeSessionId to continue it`,
        );
      }
    } catch (err) {
      await lock.release();
      if (frozenSlip) await rm(frozenSlip.dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

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
      seedTaskState(recovered); // rebuild the dedup index + current task before appends
    } catch (err) {
      await lock.release(); // a failed resume must not leave the session locked
      if (frozenSlip) await rm(frozenSlip.dir, { recursive: true, force: true }).catch(() => {});
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
    if (frozenSlip) await rm(frozenSlip.dir, { recursive: true, force: true }).catch(() => {});
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
    const newOutage = outageEpisodeId === undefined;
    outageEpisodeId ??= randomUUID();
    const alreadySupervising = supervising;
    health.markFailing(failure);
    if (newOutage) opts.onStorage?.('failing', failure);
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
  function appendEvent(input: QuestionExchangeRecordedInput): Promise<QuestionExchangeRecordedEvent>;
  function appendEvent(input: QuestionRelayUpdatedInput): Promise<QuestionRelayUpdatedEvent>;
  function appendEvent<I extends AgentInput>(input: I): Promise<AgentEventFor<I>>;
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
  const isExcluded = (abs: string): boolean => excluded.some((e) => isUnder(abs, e));

  let live = false;
  // Raw observations not yet handed to the engine. Under the git policy every
  // observation waits here until git has classified it; otherwise only those
  // arriving while capture is not live.
  let buffer: Array<[string, number]> = [];
  const onObservation = (abs: string, observedAtMs: number): void => {
    if (isExcluded(abs)) return;
    const rel = relative(root, abs);
    if (rel === '') {
      void checkRoot();
      return;
    }
    if (escapesBase(rel)) return;
    if (live && scope.policy === 'filesystem') {
      engine.notify(rel, observedAtMs);
      return;
    }
    buffer.push([rel, observedAtMs]);
    pumpClassifier();
  };

  // Paths skipped because git ignores them. Each is also marked prior-unknown in
  // the engine, so if one later comes into scope it is never reported as newly
  // created. Only the shallowest skipped path is kept.
  const ignoredPaths = new Set<string>();
  const markIgnored = (rel: string): void => {
    if (!addUnknownScope(rel, ignoredPaths)) return;
    engine.markBaselineUnknown(rel);
  };

  // Whether the git filter is working, as last durably disclosed. Flipped only
  // once the disclosing scope event is committed.
  let scopeAvailable = true;
  const scopeEvent = (): CaptureScopeInput => ({
    type: 'slipstream.capture.scope.v1',
    occurred_at_ms: Date.now(),
    data: scope.policy === 'git'
      ? (slipstreamApplied ? { policy: 'git', status: 'active', slipstream_ignore: 'active' } : { policy: 'git', status: 'active' })
      : { policy: 'filesystem', status: 'active' },
  });

  const isRegularFile = (rel: string): Promise<boolean> =>
    lstat(join(root, rel)).then((st) => st.isFile(), () => false);

  // One serial loop asks git about everything buffered so far in a single call;
  // observations arriving meanwhile go in the next round. It runs only while
  // live: a round that finishes after capture stopped being live puts its batch
  // back to be classified afresh when capture is live again.
  let classifierRunning = false;
  let classifierDone: Promise<void> = Promise.resolve();
  const pumpClassifier = (): void => {
    if (scope.policy !== 'git' || classifierRunning || !live || buffer.length === 0) return;
    classifierRunning = true;
    classifierDone = classifyLoop().catch((err: unknown) => {
      console.error(`slipstream: git classification failed: ${(err as Error).message}`);
    });
  };
  const classifyLoop = async (): Promise<void> => {
    if (scope.policy !== 'git') return;
    try {
      while (live && buffer.length > 0) {
        const batch = buffer.splice(0);
        let ignored: Set<string>;
        try {
          ignored = await scope.ignored([...new Set(batch.map(([rel]) => rel))]);
        } catch (err) {
          if (!live) {
            buffer = batch.concat(buffer); // no spread: a batch can exceed the argument limit
            return;
          }
          // Fail closed: never capture what might be ignored. The dropped paths'
          // prior state is now unknown, and the outage is disclosed once.
          console.error(`slipstream: git could not classify ${batch.length} observation(s): ${(err as Error).message}`);
          for (const [rel] of batch) engine.markBaselineUnknown(rel);
          if (scopeAvailable) {
            await appendEvent({
              type: 'slipstream.capture.scope.v1',
              occurred_at_ms: Date.now(),
              data: slipstreamApplied
                ? { policy: 'git', status: 'unavailable', slipstream_ignore: 'active' }
                : { policy: 'git', status: 'unavailable' },
            }).then(() => { scopeAvailable = false; }, () => {});
          }
          continue;
        }
        const forward: Array<[string, number]> = [];
        for (const [rel, ts] of batch) {
          if (ignored.has(rel)) markIgnored(rel);
          // An ignored directory is out of scope once deleted too, though git no
          // longer matches its vanished path. Directories are never captured. A
          // file forwarded here, or one captured before, is in scope, so its
          // deletion is captured.
          else if (!ignoredPaths.has(rel)) forward.push([rel, ts]);
          else if (engine.isRecorded(rel) || await isRegularFile(rel)) {
            ignoredPaths.delete(rel);
            forward.push([rel, ts]);
          }
        }
        if (live && !scopeAvailable) {
          await appendEvent(scopeEvent()).then(() => { scopeAvailable = true; }, () => {});
        }
        if (!live || !scopeAvailable) {
          buffer = batch.concat(buffer); // no spread: a batch can exceed the argument limit
          return;
        }
        for (const [rel, ts] of forward) engine.notify(rel, ts);
      }
    } finally {
      classifierRunning = false;
    }
  };

  // Walk the worktree, skipping what git ignores; skipped paths are marked
  // prior-unknown. Ignored entries listed up front prune whole directories. A
  // file created after that listing is caught by asking git about every file
  // found before any is read.
  const walk = async (handlers: EnumerateHandlers): Promise<void> => {
    if (scope.policy !== 'git') return deps.enumerate(root, root, isExcluded, handlers);
    const entries = new Set(await scope.ignoredEntries());
    for (const rel of entries) markIgnored(rel);
    const files: string[] = [];
    await deps.enumerate(root, root, (abs) => isExcluded(abs) || entries.has(relative(root, abs)), {
      onFile: async (rel) => { files.push(rel); },
      onDirError: handlers.onDirError,
    });
    const ignored = await scope.ignored(files);
    for (const rel of files) {
      if (ignored.has(rel)) markIgnored(rel);
      else await handlers.onFile(rel);
    }
  };

  // A native-watcher error means delivery may have lapsed; disclose an honest
  // session-wide coverage gap instead of letting the miss vanish silently.
  const watcherGap = (): Promise<unknown> => appendEvent({
    type: 'slipstream.capture.gap.v1',
    occurred_at_ms: Date.now(),
    data: { scope: { kind: 'session' }, reason: 'watcher-error' },
  }).catch(() => {});
  const onError = (err: Error): void => {
    console.error(`slipstream: watcher error: ${err.message}`);
    if (terminal) return;
    void watcherGap();
    void checkRoot();
  };

  // The activation ends, once, when the root it watches is gone or the watcher
  // can no longer deliver for it.
  let terminal = false;
  const end = (reason: 'root-missing' | 'watcher-failed', message: string): void => {
    if (terminal || stopped) return;
    terminal = true;
    opts.onTerminal?.(reason, message);
  };
  const checkRoot = async (): Promise<boolean> => {
    let now;
    try { now = await stat(root, { bigint: true }); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
    }
    if (now?.isDirectory() && now.dev === rootStat.dev && now.ino === rootStat.ino) return false;
    end('root-missing', now ? `the workspace root ${root} was replaced` : `the workspace root ${root} no longer exists`);
    return true;
  };
  const onClosed = async (err: Error): Promise<void> => {
    console.error(`slipstream: watcher subscription closed: ${err.message}`);
    if (terminal || stopped || await checkRoot()) return;
    await watcherGap();
    end('watcher-failed', `the watcher stopped delivering changes for ${root}: ${err.message}`);
  };

  const priorFor = (path: string, unknownDirs: Set<string>): Snapshot =>
    isUnderUnknownScope(path, unknownDirs) ? { kind: 'unavailable', reason: 'baseline-unknown' } : { kind: 'absent' };

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
    await walk({
      onFile: async (rel) => { current.set(rel, await reader.read(rel)); },
      onDirError: async (relDir) => { newUnknownDirs.add(relDir); },
    });

    const unknownDirs = new Set([...state.baselineUnknownDirs, ...newUnknownDirs]);
    // Under the git policy a path first seen now may have existed, ignored,
    // while capture was down: its prior state is unknown, never absent.
    if (scope.policy === 'git') unknownDirs.add('');
    // A recorded path the walk did not find is either gone or now ignored. An
    // ignored one is out of scope: keep its last recorded state, never read it.
    const unscanned = [...state.committed.keys()].filter((p) => !current.has(p));
    const ignoredUnscanned = scope.policy === 'git' ? await scope.ignored(unscanned) : new Set<string>();
    const union = new Set<string>([...state.committed.keys(), ...current.keys()]);
    for (const path of union) {
      if (ignoredUnscanned.has(path)) {
        engine.setBaseline(path, state.committed.get(path)!);
        continue;
      }
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
    for (const relDir of state.baselineUnknownDirs) engine.markBaselineUnknown(relDir);
    for (const relDir of newUnknownDirs) engine.markBaselineUnknown(relDir);
  };

  const goLive = (): void => {
    // A recovery attempt that finishes during stop() must not re-enable the engine
    // or flush the buffer: stop() has already unsubscribed and is draining toward
    // lock release, and no observation may be appended past that point.
    if (stopped) return;
    live = true;
    if (scope.policy === 'git') {
      pumpClassifier();
      return;
    }
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
      opts.onStorage?.('healthy');
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
    subscription = await deps.platform.watch({ root, ignore: excluded, onObservation, onError,
      onClosed: (err) => { void onClosed(err); } });
    // The root may have been swapped between its first stat and the watcher's
    // install; nothing is written for a directory this session never watched.
    const watched = await stat(root, { bigint: true }).catch(() => undefined);
    if (!watched || watched.dev !== rootStat.dev || watched.ino !== rootStat.ino) {
      throw new RootChangedError(watched ? `the workspace root ${root} was replaced` : `the workspace root ${root} no longer exists`);
    }

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
          ...captureModeField,
        },
      });
      const restartGap = await appendEvent({
        type: 'slipstream.capture.gap.v1',
        occurred_at_ms: Date.now(),
        data: { scope: { kind: 'session' }, reason: 'restart' },
      });
      await appendEvent(scopeEvent());
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
        data: { root, max_bytes: maxBytes, ...captureModeField },
      });
      await appendEvent(scopeEvent());

      const unknownScopes: string[] = [];
      await walk({
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
    // Every append above resolved durable, so the barrier has passed.
    await appendEvent({ type: 'slipstream.capture.ready.v1', occurred_at_ms: Date.now(), data: {} });
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
    if (frozenSlip) await rm(frozenSlip.dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  goLive();
  health.markHealthy();

  const ingestEvidence = (evidence: NormalizedEvidence): Promise<IngestOutcome> =>
    producer!.ingestEvidence(evidence);

  // Transcript reading (A2): configured harnesses' transcripts for this worktree
  // are read as revisable evidence on the shared scheduler. It never creates a
  // change and its evidence flows through the same deduped, append-only producer
  // path, so a re-read (including a late transcript after a restart) revises
  // without duplicating.
  const unregisterTranscripts = opts.transcript?.register({
    root,
    sink: { ingest: ingestEvidence },
    publish: async (data) => {
      await appendEvent({ type: 'slipstream.enrichment.coverage.v1', occurred_at_ms: Date.now(), data });
    },
  });

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
      if (!sameSourceContext(questionsById.get(req.reply_to_question_id)?.data.context, req.context)) {
        throw new QuestionError('INVALID_CONTEXT', 'a follow-up must reply to a question in this capture about the same source');
      }
    }
    // A reservation covers source reads as well as append, bounding concurrent scans.
    // An expired-but-never-attempted entry can never become eligible again, so it
    // is dropped here rather than kept forever awaiting a claim that will not come.
    let eligible = 0;
    for (const [id, q] of claimableQuestions) {
      if (now() < q.data.expires_at_ms) eligible += 1;
      else claimableQuestions.delete(id);
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

  // A committed send is registered by onCommitted (or rebuilt by recovery), so a
  // reservation can be dropped once its append settles either way.
  const isKnownRelay = (relayId: string): boolean => relayQuestions.has(relayId) || reservedRelays.has(relayId);

  const recordQuestionExchange = async (input: unknown, assertOwnership: () => void = () => {}): Promise<QuestionExchangeAccepted> => {
    const req = normalizeExchange(input);
    if (req.session_id !== sessionId) throw new QuestionError('SESSION_NOT_SELECTED', 'exchange addresses a different capture');
    assertOwnership();
    questionReady();
    const body = exchangeBody(req);
    const settled = committedExchanges.get(req.request_id);
    const pending = inflightExchanges.get(req.request_id);
    const existing = settled ?? pending;
    if (existing && existing.body !== body) throw new QuestionError('REQUEST_CONFLICT', 'request_id was used for a different exchange or context');
    if (settled) return { ...settled.result, duplicate: true };
    if (pending) return { ...await pending.promise, duplicate: true };
    if (req.reply_to_question_id !== undefined
      && !sameSourceContext(exchangesById.get(req.reply_to_question_id), req.context)) {
      throw new QuestionError('INVALID_CONTEXT', 'a follow-up must reply to an exchange in this capture about the same source');
    }
    const relayId = req.relay?.relay_id;
    if (relayId !== undefined && isKnownRelay(relayId)) throw new QuestionError('INVALID_RELAY_UPDATE', 'relay_id was already sent in this capture');
    // Defer starting I/O until the in-flight reservation is installed synchronously.
    const promise = Promise.resolve().then(async (): Promise<QuestionExchangeAccepted> => {
      const selected_text = await deps.readQuestionContext({ storeDir, logPath, sessionId,
        boundary: BigInt(health.snapshot().durable_seq), context: req.context });
      assertOwnership();
      questionReady();
      const recorded_at_ms = now();
      const event = await appendEvent({ type: 'slipstream.question.exchange_recorded.v1', occurred_at_ms: recorded_at_ms,
        data: { question_id: randomUUID(), request_id: req.request_id, text: req.text,
          context: { ...req.context, selected_text }, answer_text: req.answer_text, recorded_at_ms,
          conversation: { ...req.conversation, reported_by: 'client' },
          ...(req.reply_to_question_id !== undefined ? { reply_to_question_id: req.reply_to_question_id } : {}),
          ...(req.relay !== undefined ? { relay: req.relay } : {}) } });
      if (surrendered) throw new StorageError('lock', Object.assign(new Error('session ownership lost'), { code: 'ELOCKLOST' }));
      assertOwnership();
      const result = exchangeResult(event);
      committedExchanges.set(req.request_id, { body, result });
      return result;
    });
    inflightExchanges.set(req.request_id, { body, promise });
    if (relayId !== undefined) reservedRelays.add(relayId);
    try { return await promise; }
    finally {
      inflightExchanges.delete(req.request_id);
      if (relayId !== undefined) reservedRelays.delete(relayId);
    }
  };

  const recordQuestionRelayUpdate = async (input: unknown, assertOwnership: () => void = () => {}): Promise<QuestionRelayUpdateAccepted> => {
    const req = normalizeRelayUpdate(input);
    if (req.session_id !== sessionId) throw new QuestionError('SESSION_NOT_SELECTED', 'relay update addresses a different capture');
    assertOwnership();
    questionReady();
    const body = relayUpdateBody(req);
    const settled = committedRelayUpdates.get(req.request_id);
    const pending = inflightRelayUpdates.get(req.request_id);
    const existing = settled ?? pending;
    if (existing && existing.body !== body) throw new QuestionError('REQUEST_CONFLICT', 'request_id was used for a different relay update');
    if (settled) return { ...settled.result, duplicate: true };
    if (pending) return { ...await pending.promise, duplicate: true };
    if (!exchangesById.has(req.question_id)) throw new QuestionError('INVALID_RELAY_UPDATE', 'question_id names no recorded exchange in this capture');
    const isSend = req.update.kind === 'sent';
    if (isSend && isKnownRelay(req.relay_id)) throw new QuestionError('INVALID_RELAY_UPDATE', 'relay_id was already sent in this capture');
    if (!isSend) {
      const owner = relayQuestions.get(req.relay_id);
      if (owner === undefined) throw new QuestionError('INVALID_RELAY_UPDATE', 'relay_id was never sent in this capture');
      if (owner !== req.question_id) throw new QuestionError('INVALID_RELAY_UPDATE', 'relay_id belongs to another question');
    }
    const promise = Promise.resolve().then(async (): Promise<QuestionRelayUpdateAccepted> => {
      assertOwnership();
      questionReady();
      const recorded_at_ms = now();
      const event = await appendEvent({ type: 'slipstream.question.relay_updated.v1', occurred_at_ms: recorded_at_ms,
        data: { question_id: req.question_id, relay_id: req.relay_id, request_id: req.request_id, update: req.update, recorded_at_ms } });
      if (surrendered) throw new StorageError('lock', Object.assign(new Error('session ownership lost'), { code: 'ELOCKLOST' }));
      assertOwnership();
      const result = relayUpdateResult(event);
      committedRelayUpdates.set(req.request_id, { body, result });
      return result;
    });
    inflightRelayUpdates.set(req.request_id, { body, promise });
    if (isSend) reservedRelays.add(req.relay_id);
    try { return await promise; }
    finally {
      inflightRelayUpdates.delete(req.request_id);
      if (isSend) reservedRelays.delete(req.relay_id);
    }
  };

  const claimQuestion = async (target: QuestionQueuedData['target'], assertOwnership: () => void = () => {}): Promise<(QuestionQueuedData & { queued_seq: string }) | null> => {
    assertOwnership();
    questionReady();
    pruneExpiredClaimableQuestions();
    // The control handler admits only the linked chat, so a question queued for an
    // earlier chat of this worktree is the current chat's to claim.
    const queued = [...claimableQuestions.values()].find(q => q.data.target.worktree === target.worktree
      && now() < q.data.expires_at_ms
      && !reservedQuestions.has(q.data.question_id));
    if (!queued) return null;
    const id = queued.data.question_id;
    reservedQuestions.add(id);
    try {
      const attempted_at_ms = now();
      await appendEvent({ type: 'slipstream.question.dispatch_attempted.v1', occurred_at_ms: attempted_at_ms,
        data: { question_id: id, queued_seq: queued.seq, attempted_at_ms, target } });
      if (surrendered) throw new StorageError('lock', Object.assign(new Error('session ownership lost'), { code: 'ELOCKLOST' }));
      assertOwnership();
      return { ...queued.data, queued_seq: queued.seq };
    } finally { reservedQuestions.delete(id); }
  };

  // Order: INVALID_ANSWER, then QUESTION_NOT_FOUND (which also hides questions
  // never dispatched to this harness session), then duplicate or ANSWER_CONFLICT.
  const answerQuestion = async (input: { question_id: unknown; text: unknown }, target: QuestionQueuedData['target'], assertOwnership: () => void = () => {}): Promise<AnswerAccepted> => {
    const { question_id: id, text } = input;
    assertAnswerText(text);
    assertOwnership();
    questionReady();
    const attempt = typeof id === 'string' ? attemptsById.get(id)?.findLast(a => a.target.harness === target.harness
      && a.target.harness_session_id === target.harness_session_id && a.target.worktree === target.worktree) : undefined;
    if (typeof id !== 'string' || attempt === undefined) {
      throw new QuestionError('QUESTION_NOT_FOUND', 'no question with that id was dispatched to this harness session');
    }
    const attemptSeq = attempt.seq;
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

  const recordAgent = async <I extends AgentInput>(input: I, assertOwnership: () => void = () => {}): Promise<AgentEventFor<I>> => {
    assertOwnership();
    questionReady();
    const event = await appendEvent(input);
    if (input.type === 'slipstream.agent.binding.v1') recordedBindings.add(input.data.binding_generation);
    if (surrendered) throw new StorageError('lock', Object.assign(new Error('session ownership lost'), { code: 'ELOCKLOST' }));
    assertOwnership();
    return event;
  };
  const recordedBindings = new Set(recovered?.bindingGenerations);

  const doStop = async (opts?: StopOptions): Promise<void> => {
    stopped = true;
    // Stop feeding the engine immediately: if the watcher unsubscribe below
    // rejects, late observations buffer instead of appending after the lock is
    // released. Every step is then best-effort so a single failure never skips
    // closing the log or releasing the lock; the first error is rethrown. Under
    // the git policy capture stays live until git has classified what the
    // watcher already delivered, so stopping never drops an observed edit.
    if (scope.policy === 'filesystem') live = false;
    let firstError: unknown;
    const record = (err: unknown): void => {
      if (firstError === undefined) firstError = err;
    };
    // Stop transcript reading before the producer and log close: it appends
    // evidence and coverage through both, and an append after close would throw.
    await unregisterTranscripts?.().catch(record);
    await subscription?.close().catch(record);
    while (classifierRunning) await classifierDone;
    live = false;
    // Await any in-flight recovery: it may be mid-reopen, and appending after
    // we release the lock would let a second owner's writes interleave. The
    // loop stops starting new attempts once `stopped` is set.
    await supervisorLoop.catch(() => {});
    await engine.drain().catch(record);
    // Fence the attribution generation and flush its in-flight appends before the
    // log closes: a stale evaluation must never append after the log is gone.
    await producer?.stop().catch(record);
    await Promise.allSettled([...inflightQuestions.values(), ...inflightExchanges.values(), ...inflightRelayUpdates.values(), ...inflightAnswers.values()].map(q => q.promise));
    // Never manufactured: after a lost lock or during a storage outage the stop
    // stays unrecorded and stop() rejects, so no caller can report it stopped.
    if (opts && firstError === undefined && (surrendered || health.snapshot().state !== 'healthy')) {
      record(new Error(`the stop could not be recorded: capture storage is ${surrendered ? 'owned by another process' : health.snapshot().state}`));
    } else if (opts && firstError === undefined) {
      try {
        if (opts.unlinkGeneration !== undefined) {
          opts.assertOwnership?.();
          await appendEvent({ type: 'slipstream.agent.unlinked.v1', occurred_at_ms: now(),
            data: { binding_generation: opts.unlinkGeneration, reason: opts.reason } });
        }
        opts.assertOwnership?.();
        await appendEvent({ type: 'slipstream.capture.stopped.v1', occurred_at_ms: now(), data: { reason: opts.reason } });
      } catch (err) {
        record(err);
      }
    }
    await underlying.close().catch(record);
    await lock.release().catch(record);
    if (frozenSlip) await rm(frozenSlip.dir, { recursive: true, force: true }).catch(record);
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
    recordQuestionExchange,
    recordQuestionRelayUpdate,
    claimQuestion,
    answerQuestion,
    recordAgent,
    bindingRecorded: (generation) => recordedBindings.has(generation),
    ingestEvidence,
    stop: (opts) => (stopPromise ??= doStop(opts)),
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
