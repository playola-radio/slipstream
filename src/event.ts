import type { Snapshot } from './snapshot.ts';

/**
 * The event schema is Slipstream's public interface (CLAUDE.md). Every record in
 * `events.jsonl` is one CloudEvents 1.0 structured JSON object per line. We use
 * the envelope directly — no SDK — and keep Slipstream-specific fields in `data`.
 *
 * Freeze rules for v1 (see schemas/):
 * - `seq` is a contiguous per-session decimal string ("1", "2", ...) expressing
 *   commit order. `id` equals `seq` — CloudEvents identity is (source, id), so a
 *   second UUID adds nothing.
 * - The version lives in `type` (`slipstream.<name>.v1`), never in `specversion`
 *   (which versions CloudEvents itself).
 * - `time` is the observation/occurrence instant (RFC3339, ms precision). It is
 *   never used for ordering — `seq` is. It is not durable-completion time.
 * - `session_id` lives inside `data`, not as a top-level extension attribute:
 *   CloudEvents extension names cannot contain underscores.
 * - Forward compatibility is a contract, not just syntax: consumers ignore
 *   unknown `data` fields and unknown event types (while still advancing their
 *   seq cursor), and v1 fields never change meaning. `task_hint_id` arrives as
 *   an optional additive `data` field on `file.changed` — no version bump.
 * - `subject` is the one CloudEvents envelope attribute Slipstream sets: the
 *   task declaration `slipstream.task.started.v1` carries `subject: "task/<id>"`
 *   (ruling D2). It is optional and absent on every other event type.
 */
export const SPEC_VERSION = '1.0';
export const DATA_CONTENT_TYPE = 'application/json';
export const SOURCE_PREFIX = 'urn:slipstream:session:';

export function sourceFor(sessionId: string): string {
  return `${SOURCE_PREFIX}${sessionId}`;
}

export const EVENT_TYPES = [
  'slipstream.session.started.v1',
  'slipstream.file.baselined.v1',
  'slipstream.capture.baseline.completed.v1',
  'slipstream.file.changed.v1',
  'slipstream.capture.gap.v1',
  'slipstream.session.resumed.v1',
  'slipstream.task.started.v1',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Whether an observation came from the live watcher or a restart/recovery scan. */
export type Observation = 'watcher' | 'reconciliation';

export type GapReason =
  | 'coalesced'
  | 'baseline-unreadable'
  | 'watcher-error'
  | 'restart'
  | 'storage';

/**
 * A gap's scope replaces Stage 1's empty-path sentinel: a gap is honestly about
 * the whole session, a directory subtree, or a single path.
 */
export type GapScope =
  | { kind: 'session' }
  | { kind: 'directory'; path: string }
  | { kind: 'path'; path: string };

export interface SessionStartedData {
  session_id: string;
  /** The canonical (realpath) worktree this session is bound to. */
  root: string;
  /** Capture policy: max regular-file size captured as content, in bytes. */
  max_bytes: number;
  /** Observation instant in epoch ms (mirrors envelope `time`; never ordering). */
  started_at_ms: number;
}

/**
 * One initial observed snapshot for a path, recorded at attach. Explicitly not
 * an edit — it is the durable baseline that lets a restart tell an unobserved
 * offline deletion from a file that simply never changed.
 */
export interface FileBaselinedData {
  session_id: string;
  path: string;
  snapshot: Snapshot;
}

export interface BaselineCompletedData {
  session_id: string;
  /** Directories whose baseline scan failed; their descendants' prior state is unknown. */
  unknown_scopes: string[];
}

export interface FileChangedData {
  session_id: string;
  path: string;
  before: Snapshot;
  after: Snapshot;
  observation: Observation;
  /** Observation instant in epoch ms (mirrors envelope `time`; never ordering). */
  observed_at_ms: number;
  /** True when intermediate states may have been coalesced before this commit. */
  coalesced?: boolean;
  /** For reconciliation changes: the `seq` of the gap this endpoint reconciles. */
  gap_ref?: string;
  /**
   * The `task_id` of the latest COMMITTED task declaration in shared append
   * order at the moment this change was ordered, or absent when the change is
   * ungrouped. An immutable grouping hint — never rewritten once stamped, and a
   * later declaration never regroups earlier changes.
   */
  task_hint_id?: string;
  /**
   * Attribution is revisable inference, never verified authorship. Stage 3 has
   * no authorship evidence, so every newly emitted change is `unknown`: two
   * writers in the watched worktree are both captured and both unattributed.
   */
  attribution?: { status: 'unknown' };
}

/**
 * A durable task boundary the agent declared. Its `seq` is the boundary: changes
 * ordered after it may reference its `task_id` as their `task_hint_id`. Declaring
 * a task makes no completion claim about any previous one.
 */
export interface TaskStartedData {
  session_id: string;
  /** UUID minted by the capture session when the declaration is committed. */
  task_id: string;
  /** Caller-supplied idempotency key: a retry with the same value commits once. */
  request_id: string;
  title: string;
}

export interface CaptureGapData {
  session_id: string;
  scope: GapScope;
  reason: GapReason;
  /** Observation instant in epoch ms (mirrors envelope `time`; never ordering). */
  observed_at_ms: number;
  /** Groups a `storage` gap with the outage episode it discloses. */
  episode_id?: string;
}

export interface SessionResumedData {
  session_id: string;
  recovered_through_seq: string;
  discarded_tail_bytes: number;
  /** Observation instant in epoch ms (mirrors envelope `time`; never ordering). */
  resumed_at_ms: number;
}

/** A caller supplies the type, its data (minus the injected `session_id`), and
 * the occurrence time in epoch ms; the log injects `session_id`, `source`,
 * `seq`, `id`, `time`, and the CloudEvents constants. */
export type EventInput =
  | { type: 'slipstream.session.started.v1'; occurred_at_ms: number; data: Omit<SessionStartedData, 'session_id' | 'started_at_ms'> }
  | { type: 'slipstream.file.baselined.v1'; occurred_at_ms: number; data: Omit<FileBaselinedData, 'session_id'> }
  | { type: 'slipstream.capture.baseline.completed.v1'; occurred_at_ms: number; data: Omit<BaselineCompletedData, 'session_id'> }
  | { type: 'slipstream.file.changed.v1'; occurred_at_ms: number; data: Omit<FileChangedData, 'session_id' | 'observed_at_ms'> }
  | { type: 'slipstream.capture.gap.v1'; occurred_at_ms: number; data: Omit<CaptureGapData, 'session_id' | 'observed_at_ms'> }
  | { type: 'slipstream.session.resumed.v1'; occurred_at_ms: number; data: Omit<SessionResumedData, 'session_id' | 'resumed_at_ms'> }
  | { type: 'slipstream.task.started.v1'; occurred_at_ms: number; data: Omit<TaskStartedData, 'session_id'> };

/** The `data` field into which each type mirrors the observation instant (epoch
 * ms). Types absent here carry only the envelope `time` (baseline records are
 * attach-time bookkeeping, not observations of an instant). */
const AT_MS_FIELD: Partial<Record<EventType, string>> = {
  'slipstream.session.started.v1': 'started_at_ms',
  'slipstream.file.changed.v1': 'observed_at_ms',
  'slipstream.capture.gap.v1': 'observed_at_ms',
  'slipstream.session.resumed.v1': 'resumed_at_ms',
};

type DataFor<T extends EventType> =
  T extends 'slipstream.session.started.v1' ? SessionStartedData
  : T extends 'slipstream.file.baselined.v1' ? FileBaselinedData
  : T extends 'slipstream.capture.baseline.completed.v1' ? BaselineCompletedData
  : T extends 'slipstream.file.changed.v1' ? FileChangedData
  : T extends 'slipstream.capture.gap.v1' ? CaptureGapData
  : T extends 'slipstream.session.resumed.v1' ? SessionResumedData
  : T extends 'slipstream.task.started.v1' ? TaskStartedData
  : never;

export interface CloudEvent<T extends EventType = EventType> {
  specversion: typeof SPEC_VERSION;
  id: string;
  source: string;
  type: T;
  datacontenttype: typeof DATA_CONTENT_TYPE;
  seq: string;
  time: string;
  /** CloudEvents `subject`. Present only on task declarations (`task/<task_id>`);
   * absent on every other event type. */
  subject?: string;
  data: DataFor<T>;
}

/** Any recorded event, regardless of type. */
export type AnyEvent = { [T in EventType]: CloudEvent<T> }[EventType];

/**
 * Build the full CloudEvents envelope for an input at a given sequence and
 * session. Pure: no I/O, no clock — `seq` and time are supplied by the caller
 * (the log), so ordering and timestamps are never invented here.
 */
export function buildEnvelope(input: EventInput, seq: bigint, sessionId: string): AnyEvent {
  const seqStr = seq.toString();
  const atMsField = AT_MS_FIELD[input.type];
  // The only envelope `subject` Slipstream sets (ruling D2): a task declaration
  // is subject `task/<task_id>`. Every other event omits it — an absent field,
  // never an empty string.
  const subject =
    input.type === 'slipstream.task.started.v1' ? `task/${input.data.task_id}` : undefined;
  return {
    specversion: SPEC_VERSION,
    id: seqStr,
    source: sourceFor(sessionId),
    type: input.type,
    datacontenttype: DATA_CONTENT_TYPE,
    seq: seqStr,
    time: new Date(input.occurred_at_ms).toISOString(),
    ...(subject !== undefined ? { subject } : {}),
    data: {
      session_id: sessionId,
      ...input.data,
      ...(atMsField ? { [atMsField]: input.occurred_at_ms } : {}),
    },
  } as AnyEvent;
}
