/**
 * The attribution producer's scheduling + evaluation core. It decides *when* to
 * evaluate a change and folds evidence into a published result; the honesty of
 * the result itself is the pure reducer's ({@link ./attribution.ts}).
 *
 * Design (locked, Codex-vetted):
 * - **Grace.** Every interval-bearing change arms a deadline at `end_ms +
 *   grace_ms`; the first evaluation waits for it so a burst of evidence lands
 *   before we commit to a status. An unavailable/legacy interval has no window to
 *   wait for and resolves immediately to `observation-interval-unavailable`.
 * - **Revision without new grace.** A resolved change stays revisable: later
 *   evidence triggers a fresh evaluation right away (no second grace), and a new
 *   result is appended only when it *differs semantically* — the original event
 *   is never mutated (append-only revision).
 * - **Original-policy retention.** A change keeps the policy it bound to at
 *   commit time; every revision scores under that policy, never a newer one.
 * - **Serialized evaluate+publish.** All evaluations run one at a time so a stale
 *   result can never win a race against a newer one, and the semantic-dedup read
 *   stays consistent with the append that follows it.
 *
 * Clock and timers are injected so tests drive them deterministically. A single
 * timer is armed for the nearest pending deadline.
 */
import { foldEvidence, evaluateChange, attributionResultsEqual } from './attribution.ts';
import type { AnyEvent, ChangeAttributionData, EnrichmentPolicy, ObservedInterval } from './event.ts';

export type TimerHandle = unknown;

/** A durably-committed `file.changed` the engine should attribute. */
export interface CommittedChange {
  changeSeq: bigint;
  path: string;
  /** The change's observation interval; `undefined` for legacy records. */
  interval: ObservedInterval | undefined;
  /** The policy bound to this change (highest-seq policy preceding it). */
  policy: EnrichmentPolicy;
  policySeq: bigint;
}

export interface AttributionEngineOptions {
  now: () => number;
  /** Arm a one-shot timer; the engine keeps at most one outstanding. */
  setTimer: (delayMs: number, fn: () => void) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  /** The current evidence events to fold (the log, in the wired engine). */
  readEvents: () => readonly AnyEvent[];
  /** Append an attribution result; resolves once durable. A rejection is treated
   * as a transient storage fault — the result stays unpublished and is retried on
   * the next evaluation, so enrichment never crashes or blocks capture. */
  appendAttribution: (data: Omit<ChangeAttributionData, 'session_id'>) => Promise<unknown>;
}

export interface AttributionEngine {
  /** Register a committed change; arms its grace deadline (or resolves at once
   * when its interval is unavailable). Idempotent per `changeSeq`. */
  onChangeCommitted(change: CommittedChange): void;
  /** Evidence changed: re-evaluate every already-graced change now (no new grace).
   * Changes still inside their grace window pick the evidence up at their deadline. */
  onEvidenceChanged(): void;
  /** Seed a change's last published result so replay dedups a reproduced result
   * (prevents double-attribution across a restart). Call before onChangeCommitted. */
  seedPublished(changeSeq: bigint, data: Omit<ChangeAttributionData, 'session_id'>): void;
  /** Resolve once all requested evaluations have settled. */
  drain(): Promise<void>;
  /** Permanently disable this engine: cancel its timer, ignore further input, and
   * resolve once the in-flight evaluation settles. The producer discards a stopped
   * engine and builds a fresh one on the next start (generation boundary). */
  stop(): Promise<void>;
}

interface Tracked extends CommittedChange {
  /** Grace deadline in epoch ms, or `undefined` for an unavailable interval. */
  deadlineMs: number | undefined;
  /** True once the grace window elapsed and a first evaluation was requested. */
  graced: boolean;
}

export function createAttributionEngine(opts: AttributionEngineOptions): AttributionEngine {
  const { now, setTimer, clearTimer, readEvents, appendAttribution } = opts;

  const changes = new Map<bigint, Tracked>();
  const published = new Map<bigint, Omit<ChangeAttributionData, 'session_id'>>();
  let timer: TimerHandle | undefined;
  let stopped = false;

  // Serialized evaluate+publish queue. Per-change dedup collapses redundant
  // requests; the pump processes one evaluation at a time.
  const queue: bigint[] = [];
  const queued = new Set<bigint>();
  let pumpPromise: Promise<void> = Promise.resolve();
  let pumping = false;

  const requestEval = (changeSeq: bigint): void => {
    if (stopped || queued.has(changeSeq)) return;
    queued.add(changeSeq);
    queue.push(changeSeq);
    if (!pumping) pumpPromise = pump();
  };

  const pump = async (): Promise<void> => {
    pumping = true;
    try {
      for (;;) {
        const changeSeq = queue.shift();
        if (changeSeq === undefined) break;
        queued.delete(changeSeq);
        await evaluate(changeSeq);
      }
    } finally {
      pumping = false;
    }
  };

  const evaluate = async (changeSeq: bigint): Promise<void> => {
    if (stopped) return;
    const c = changes.get(changeSeq);
    if (!c) return;
    const invocations = foldEvidence(readEvents()).values();
    const result = evaluateChange({
      path: c.path,
      interval: c.interval,
      policy: c.policy,
      invocations,
    });
    const data: Omit<ChangeAttributionData, 'session_id'> = {
      change_seq: changeSeq.toString(),
      policy_seq: c.policySeq.toString(),
      status: result.status,
      reason: result.reason,
      evidence_seqs: result.evidenceSeqs.map((s) => s.toString()),
      ...(result.excludedConflicts.length > 0
        ? { excluded_conflicts: result.excludedConflicts }
        : {}),
    };
    const prev = published.get(changeSeq);
    if (prev && attributionResultsEqual(prev, data)) return;
    try {
      await appendAttribution(data);
    } catch {
      return; // transient storage fault: leave unpublished so a later eval retries
    }
    if (stopped) return; // fenced after the append: a fresh generation owns state now
    published.set(changeSeq, data);
  };

  const rescheduleTimer = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    let nearest = Infinity;
    for (const c of changes.values()) {
      if (!c.graced && c.deadlineMs !== undefined) nearest = Math.min(nearest, c.deadlineMs);
    }
    if (nearest === Infinity) return;
    timer = setTimer(Math.max(0, nearest - now()), onTimer);
  };

  const onTimer = (): void => {
    timer = undefined;
    if (stopped) return;
    const t = now();
    for (const c of changes.values()) {
      if (!c.graced && c.deadlineMs !== undefined && c.deadlineMs <= t) {
        c.graced = true;
        requestEval(c.changeSeq);
      }
    }
    rescheduleTimer();
  };

  const seedPublished = (
    changeSeq: bigint,
    data: Omit<ChangeAttributionData, 'session_id'>,
  ): void => {
    published.set(changeSeq, data);
  };

  const onChangeCommitted = (change: CommittedChange): void => {
    if (stopped || changes.has(change.changeSeq)) return; // idempotent
    const { interval } = change;
    const deadlineMs =
      interval !== undefined && !('unavailable' in interval)
        ? interval.end_ms + change.policy.grace_ms
        : undefined;
    const tracked: Tracked = { ...change, deadlineMs, graced: deadlineMs === undefined };
    changes.set(change.changeSeq, tracked);
    if (deadlineMs === undefined) {
      // No observation window to wait for: resolve immediately (unknown).
      requestEval(change.changeSeq);
    } else {
      rescheduleTimer();
    }
  };

  const onEvidenceChanged = (): void => {
    if (stopped) return;
    for (const c of changes.values()) {
      if (c.graced) requestEval(c.changeSeq);
    }
  };

  const drain = async (): Promise<void> => {
    await pumpPromise;
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    await pumpPromise;
  };

  return { onChangeCommitted, onEvidenceChanged, seedPublished, drain, stop };
}
