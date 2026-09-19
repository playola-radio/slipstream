/**
 * The attribution producer: the session-side composition that turns a durable
 * event log into revisable attribution. It owns three cooperating pieces —
 *
 * - the {@link createEvidenceIngestor} write side (durable, deduped evidence),
 * - the {@link createAttributionEngine} scheduler (grace + revision), and
 * - an in-memory projection of the log the engine folds (evidence + policy).
 *
 * and wires them to the session's single append path. It is honest about
 * restarts: `start(events)` rebuilds every projection from the durable log and
 * only then arms a fresh generation of evaluations (the replay barrier), and
 * `stop()` discards outstanding work and fences the previous generation so a
 * stale evaluation can never append after a recovery reopens the log.
 *
 * Enrichment never blocks capture (CLAUDE.md): all scheduling is asynchronous,
 * append-only, and a failed attribution append is retried later rather than
 * propagated. The producer never emits a `file.changed` — it only refines.
 */
import { foldAttributions } from './attribution.ts';
import {
  createAttributionEngine,
  type AttributionEngine,
  type TimerHandle,
} from './attribution-engine.ts';
import {
  createEvidenceIngestor,
  type EvidenceIngestor,
  type IngestOutcome,
  type NormalizedEvidence,
} from './evidence-ingest.ts';
import type { AnyEvent, EnrichmentPolicy, EventInput } from './event.ts';

/** A1 ships no real transcript adapters, so both real sources are `unconfigured`;
 * an `unknown` under this coverage honestly means "nothing was watched". */
export const DEFAULT_ENRICHMENT_POLICY: EnrichmentPolicy = {
  window_ms: 2000,
  grace_ms: 5000,
  sources: { 'claude-code': 'unconfigured', codex: 'unconfigured' },
};

export interface AttributionProducerOptions {
  /** The session's single serialized append path. */
  appendEvent: (input: EventInput) => Promise<AnyEvent>;
  now: () => number;
  setTimer: (delayMs: number, fn: () => void) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
}

export interface AttributionProducer {
  /** Route a durably-committed event, in commit order, from the log sequencer. */
  noteCommitted(event: AnyEvent): void;
  /** Public ingestion seam (A2 transcript adapters; A1 fake-evidence tests). */
  ingestEvidence(evidence: NormalizedEvidence): Promise<IngestOutcome>;
  /** Append the effective policy iff it differs from the latest committed one. */
  ensurePolicy(policy: EnrichmentPolicy): Promise<void>;
  /** Rebuild every projection from the durable log, then arm a fresh generation of
   * evaluations (replay barrier). Idempotent-safe to call again after {@link stop}. */
  start(events: readonly AnyEvent[]): void;
  /** Await all outstanding evaluations and ingest appends. */
  drain(): Promise<void>;
  /** Discard outstanding work and fence this generation; await settled appends. */
  stop(): Promise<void>;
}

const EVIDENCE = 'slipstream.harness.evidence.v1';
const FILE_CHANGED = 'slipstream.file.changed.v1';
const POLICY = 'slipstream.enrichment.configured.v1';

/** Canonical form for comparing two policies by value (source key order is incidental). */
function policyKey(p: EnrichmentPolicy): string {
  const sources = Object.keys(p.sources)
    .sort()
    .map((k) => `${k}=${p.sources[k]}`)
    .join(',');
  return `${p.window_ms}|${p.grace_ms}|${sources}`;
}

export function createAttributionProducer(
  opts: AttributionProducerOptions,
): AttributionProducer {
  const { appendEvent, now, setTimer, clearTimer } = opts;

  let running = false;
  let engine: AttributionEngine | undefined;
  let ingestor: EvidenceIngestor | undefined;
  let evidenceList: AnyEvent[] = [];
  let currentPolicy: { seq: bigint; policy: EnrichmentPolicy } | undefined;
  const inflightIngests = new Set<Promise<unknown>>();

  const makeEngine = (): AttributionEngine =>
    createAttributionEngine({
      now,
      setTimer,
      clearTimer,
      readEvents: () => evidenceList,
      appendAttribution: (data) =>
        appendEvent({ type: 'slipstream.change.attribution.v1', occurred_at_ms: now(), data }),
    });

  const makeIngestor = (): EvidenceIngestor =>
    createEvidenceIngestor({ append: appendEvent, now });

  const registerChange = (
    event: Extract<AnyEvent, { type: typeof FILE_CHANGED }>,
    policy: { seq: bigint; policy: EnrichmentPolicy } | undefined,
  ): void => {
    // A change committed before any policy is a legacy record with no bound
    // policy; it carries the documented legacy disposition and is not scheduled.
    if (!policy || !engine) return;
    engine.onChangeCommitted({
      changeSeq: BigInt(event.seq),
      path: event.data.path,
      interval: event.data.observed_interval_ms,
      policy: policy.policy,
      policySeq: policy.seq,
    });
  };

  const noteCommitted = (event: AnyEvent): void => {
    if (!running || !engine) return;
    switch (event.type) {
      case POLICY:
        currentPolicy = { seq: BigInt(event.seq), policy: event.data.policy };
        break;
      case EVIDENCE:
        evidenceList.push(event);
        engine.onEvidenceChanged();
        break;
      case FILE_CHANGED:
        registerChange(event, currentPolicy);
        break;
      default:
        break;
    }
  };

  const ingestEvidence = (evidence: NormalizedEvidence): Promise<IngestOutcome> => {
    if (!running || !ingestor) {
      return Promise.resolve({ status: 'rejected', reason: 'queue-full', retryable: true });
    }
    const p = ingestor.ingest(evidence);
    const tracked = p.finally(() => inflightIngests.delete(tracked));
    inflightIngests.add(tracked);
    return p;
  };

  const ensurePolicy = async (policy: EnrichmentPolicy): Promise<void> => {
    if (currentPolicy && policyKey(currentPolicy.policy) === policyKey(policy)) return;
    await appendEvent({
      type: 'slipstream.enrichment.configured.v1',
      occurred_at_ms: now(),
      data: { policy },
    });
    // `noteCommitted` (via the sequencer) advances `currentPolicy` from the commit.
  };

  const start = (events: readonly AnyEvent[]): void => {
    running = true;
    evidenceList = [];
    currentPolicy = undefined;
    ingestor = makeIngestor();
    engine = makeEngine();

    // Replay in commit order: seed evidence + policy, and collect each change with
    // the policy in force at its position (highest policy seq below the change).
    const evidence: AnyEvent[] = [];
    const pendingChanges: Array<{
      event: Extract<AnyEvent, { type: typeof FILE_CHANGED }>;
      policy: { seq: bigint; policy: EnrichmentPolicy } | undefined;
    }> = [];
    for (const event of events) {
      if (event.type === POLICY) {
        currentPolicy = { seq: BigInt(event.seq), policy: event.data.policy };
      } else if (event.type === EVIDENCE) {
        evidence.push(event);
      } else if (event.type === FILE_CHANGED) {
        pendingChanges.push({ event, policy: currentPolicy });
      }
    }
    evidenceList = evidence;
    ingestor.seed(evidence);

    // Seed prior results BEFORE scheduling, so a replayed evaluation that
    // reproduces the same result appends nothing (no double-attribution).
    for (const [changeSeq, { data }] of foldAttributions(events)) {
      engine.seedPublished(changeSeq, data);
    }
    for (const { event, policy } of pendingChanges) registerChange(event, policy);
  };

  const drain = async (): Promise<void> => {
    await Promise.allSettled([...inflightIngests]);
    await engine?.drain();
  };

  const stop = async (): Promise<void> => {
    running = false;
    await Promise.allSettled([...inflightIngests]);
    await engine?.stop();
    engine = undefined;
    ingestor = undefined;
  };

  return { noteCommitted, ingestEvidence, ensurePolicy, start, drain, stop };
}
