/**
 * Durable evidence ingestion. The pure reducer ({@link ./attribution.ts}) reads
 * the committed log; this is the write side that puts records there honestly.
 *
 * Two invariants drive the design:
 * - **Log-derived dedup.** A re-read that asserts the exact same fact appends
 *   nothing; a differing variant under the same key is appended, never an
 *   overwrite (conflict is disclosed by the reducer, never silently resolved).
 * - **No check-then-append race.** All ingestion is serialized onto one tail, so
 *   the authoritative in-memory variant index reflects every prior append before
 *   the next ingest consults it. The index is updated before an append is
 *   acknowledged, so it can never lag the log it mirrors.
 *
 * Ingestion is bounded: admitted-but-not-yet-durable work is capped by count and
 * by bytes, and excess is rejected with an explicit retryable error rather than
 * growing an unbounded queue while the log writer is slow.
 */
import type { AnyEvent, EventInput, HarnessEvidenceData } from './event.ts';
import { evidenceKeyString, variantSignature } from './attribution.ts';

/** A normalized evidence record ready to ingest; the log injects `session_id`. */
export type NormalizedEvidence = Omit<HarnessEvidenceData, 'session_id'>;

export type IngestOutcome =
  | { status: 'appended'; seq: bigint }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: 'queue-full'; retryable: true };

export interface EvidenceIngestor {
  /** Ingest one normalized record, appending it iff it is a new variant. */
  ingest(evidence: NormalizedEvidence): Promise<IngestOutcome>;
  /** Rebuild the committed-variant index from replayed evidence events (restart). */
  seed(events: readonly AnyEvent[]): void;
}

export interface EvidenceIngestorOptions {
  /** The session log's serialized append (durable on resolve). */
  append: (input: EventInput) => Promise<AnyEvent>;
  /** Epoch-ms clock for the ingestion instant. */
  now: () => number;
  /** Max ingest requests admitted but not yet durable. Default 256. */
  maxPending?: number;
  /** Max total bytes of admitted-but-pending payloads. Default 1 MiB. */
  maxQueuedBytes?: number;
}

const DEFAULT_MAX_PENDING = 256;
const DEFAULT_MAX_QUEUED_BYTES = 1024 * 1024;
const EVIDENCE = 'slipstream.harness.evidence.v1';

export function createEvidenceIngestor(opts: EvidenceIngestorOptions): EvidenceIngestor {
  const { append, now } = opts;
  const maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
  const maxQueuedBytes = opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;

  // key -> the variant signatures already durable under it.
  const committed = new Map<string, Set<string>>();
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let queuedBytes = 0;

  const record = (keyStr: string, sig: string): void => {
    let set = committed.get(keyStr);
    if (!set) {
      set = new Set<string>();
      committed.set(keyStr, set);
    }
    set.add(sig);
  };

  const seed = (events: readonly AnyEvent[]): void => {
    for (const e of events) {
      if (e.type !== EVIDENCE) continue;
      record(evidenceKeyString(e.data.evidence_key), variantSignature(e.data));
    }
  };

  // Runs one at a time (serialized by the tail), so the committed index is
  // guaranteed to reflect every earlier append: this check cannot race.
  const doIngest = async (evidence: NormalizedEvidence): Promise<IngestOutcome> => {
    const keyStr = evidenceKeyString(evidence.evidence_key);
    const sig = variantSignature(evidence);
    if (committed.get(keyStr)?.has(sig)) return { status: 'duplicate' };
    const event = await append({ type: EVIDENCE, occurred_at_ms: now(), data: evidence });
    record(keyStr, sig);
    return { status: 'appended', seq: BigInt(event.seq) };
  };

  const ingest = (caller: NormalizedEvidence): Promise<IngestOutcome> => {
    // Snapshot at the boundary: the caller may mutate its object after we return,
    // but the record we persist (and mirror in memory) must be the fact as ingested.
    const evidence = structuredClone(caller);
    // Admission is synchronous: no `await` sits between the bound check and the
    // reservation, so concurrent callers can never collectively over-admit.
    const size = Buffer.byteLength(JSON.stringify(evidence));
    if (pending + 1 > maxPending || queuedBytes + size > maxQueuedBytes) {
      return Promise.resolve({ status: 'rejected', reason: 'queue-full', retryable: true });
    }
    pending += 1;
    queuedBytes += size;
    const result = tail.then(() => doIngest(evidence));
    tail = result.catch(() => undefined); // keep the chain alive past a failed append
    return result.finally(() => {
      pending -= 1;
      queuedBytes -= size;
    });
  };

  return { ingest, seed };
}
