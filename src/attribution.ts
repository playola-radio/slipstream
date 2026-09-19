/**
 * The attribution reducer — a pure, I/O-free fold of the event log. This is the
 * public interface for attribution (CLAUDE.md: the schema is the interface): the
 * daemon uses it to schedule and suppress duplicate work, and any client reading
 * the raw event stream reproduces the exact same result by folding it here. No
 * privileged back channel; the log is the source of truth.
 *
 * Everything in this module is a pure function of already-parsed events. Nothing
 * here reads a clock, opens a file, or schedules a timer — those live in the
 * producer (session wiring). Attribution is revisable inference with a status,
 * never verified authorship (CLAUDE.md honesty constraints).
 */
import type {
  AttributionReason,
  AttributionStatus,
  AnyEvent,
  ChangeAttributionData,
  CloudEvent,
  EnrichmentPolicy,
  EvidenceFileScope,
  EvidenceKey,
  HarnessEvidenceData,
  ObservedInterval,
} from './event.ts';

/** A distinct harness invocation, reconstructed by joining every evidence record
 * that shares one `evidence_key`. This — not an agent — is a "candidate". */
export interface Invocation {
  key: EvidenceKey;
  keyStr: string;
  /** The agreed tool name, or undefined when records disagree (a conflict). */
  toolName: string | undefined;
  /** Earliest/latest timestamp across the joined records (pre-window). */
  minAtMs: number;
  maxAtMs: number;
  /** Merged declared scope; `unknown` if any record could not name its paths. */
  scope: EvidenceFileScope;
  /** True when records under this key contradict each other; such an invocation
   * is never counted as a candidate, only disclosed. */
  conflicted: boolean;
  conflictReason?: string;
  /** Seqs of the distinct evidence records making up this invocation, ascending. */
  evidenceSeqs: bigint[];
}

export interface EvaluationInput {
  changeSeq: bigint;
  path: string;
  /** The change's observation interval; undefined for legacy records with none. */
  interval: ObservedInterval | undefined;
  /** The policy bound to this change (by sequence). */
  policy: EnrichmentPolicy;
  invocations: Iterable<Invocation>;
}

export interface EvaluationResult {
  status: AttributionStatus;
  reason: AttributionReason;
  /** Supporting evidence seqs from the eligible invocations, ascending. */
  evidenceSeqs: bigint[];
  /** Relevant invocations excluded because their records conflict. */
  excludedConflicts: EvidenceKey[];
}

const EVIDENCE = 'slipstream.harness.evidence.v1';
const FILE_CHANGED = 'slipstream.file.changed.v1';
const ATTRIBUTION = 'slipstream.change.attribution.v1';
const POLICY = 'slipstream.enrichment.configured.v1';

/** A stable string identity for an evidence key, safe as a Map key. The unit
 * separator cannot appear in the component ids, so distinct keys never collide. */
export function evidenceKeyString(key: EvidenceKey): string {
  return `${key.harness}${key.harness_session_id}${key.record_id}`;
}

/** Canonical signature of the semantic fact a record asserts, used for both dedup
 * (identical signature = one variant) and conflict detection. Adapter version is
 * deliberately excluded: a re-emit under a newer adapter is the same fact. */
function variantSignature(data: HarnessEvidenceData): string {
  const scope =
    data.file_scope.kind === 'paths'
      ? `paths:${[...data.file_scope.paths].sort().join(',')}`
      : `unknown:${data.file_scope.reason}`;
  return `${data.tool_name}${data.timestamp.basis}${data.timestamp.at_ms}${scope}`;
}

/**
 * Fold evidence records into one {@link Invocation} per key. Records sharing a
 * key are joined; byte-identical variants dedup to a single seq; contradictory
 * variants mark the invocation conflicted (never silently merged or overwritten).
 */
export function foldEvidence(events: readonly AnyEvent[]): Map<string, Invocation> {
  interface Group {
    key: EvidenceKey;
    variants: Map<string, { seq: bigint; data: HarnessEvidenceData }>;
  }
  const groups = new Map<string, Group>();
  for (const e of events) {
    if (e.type !== EVIDENCE) continue;
    const data = e.data;
    const keyStr = evidenceKeyString(data.evidence_key);
    const sig = variantSignature(data);
    const seq = BigInt(e.seq);
    let group = groups.get(keyStr);
    if (!group) {
      group = { key: data.evidence_key, variants: new Map() };
      groups.set(keyStr, group);
    }
    const existing = group.variants.get(sig);
    // Identical reread: keep the earliest seq that recorded the fact.
    if (!existing || seq < existing.seq) group.variants.set(sig, { seq, data });
  }

  const out = new Map<string, Invocation>();
  for (const [keyStr, group] of groups) {
    const variants = [...group.variants.values()];
    const evidenceSeqs = variants.map((v) => v.seq).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const bases = new Set<string>();
    let sameBasisConflict = false;
    for (const v of variants) {
      const b = v.data.timestamp.basis;
      if (bases.has(b)) sameBasisConflict = true;
      bases.add(b);
    }
    const tools = new Set(variants.map((v) => v.data.tool_name));
    const conflicted = sameBasisConflict || tools.size > 1;
    const conflictReason = conflicted
      ? sameBasisConflict
        ? 'contradictory-records-under-one-key'
        : 'tool-name-disagreement'
      : undefined;

    let minAtMs = Infinity;
    let maxAtMs = -Infinity;
    let unknownScope: string | undefined;
    const paths = new Set<string>();
    for (const v of variants) {
      minAtMs = Math.min(minAtMs, v.data.timestamp.at_ms);
      maxAtMs = Math.max(maxAtMs, v.data.timestamp.at_ms);
      if (v.data.file_scope.kind === 'unknown') unknownScope ??= v.data.file_scope.reason;
      else for (const p of v.data.file_scope.paths) paths.add(p);
    }
    const scope: EvidenceFileScope =
      unknownScope !== undefined
        ? { kind: 'unknown', reason: unknownScope }
        : { kind: 'paths', paths: [...paths].sort() };

    out.set(keyStr, {
      key: group.key,
      keyStr,
      toolName: tools.size === 1 ? [...tools][0] : undefined,
      minAtMs,
      maxAtMs,
      scope,
      conflicted,
      conflictReason,
      evidenceSeqs,
    });
  }
  return out;
}

/** Every declared policy in ascending seq order. */
export function foldPolicies(
  events: readonly AnyEvent[],
): Array<{ seq: bigint; policy: EnrichmentPolicy }> {
  const out: Array<{ seq: bigint; policy: EnrichmentPolicy }> = [];
  for (const e of events) {
    if (e.type !== POLICY) continue;
    out.push({ seq: BigInt(e.seq), policy: e.data.policy });
  }
  out.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  return out;
}

/** The policy bound to a change: the highest-seq policy that strictly precedes
 * the change. Undefined for a change older than any policy (legacy disposition). */
export function bindPolicy(
  policies: ReadonlyArray<{ seq: bigint; policy: EnrichmentPolicy }>,
  changeSeq: bigint,
): { seq: bigint; policy: EnrichmentPolicy } | undefined {
  let bound: { seq: bigint; policy: EnrichmentPolicy } | undefined;
  for (const p of policies) {
    if (p.seq < changeSeq) bound = p;
    else break; // ascending: no later policy can precede
  }
  return bound;
}

/**
 * The Fork-3 public fold: each change's current attribution. An attribution is
 * counted only if its target reference is valid — an existing `file.changed.v1`
 * in the same source with a strictly smaller seq (Fork 1). The highest-seq valid
 * attribution wins, so a revision supersedes without mutating any prior record.
 */
export function foldAttributions(
  events: readonly AnyEvent[],
): Map<bigint, { seq: bigint; data: ChangeAttributionData }> {
  const changeSeqsBySource = new Set<string>();
  for (const e of events) {
    if (e.type === FILE_CHANGED) changeSeqsBySource.add(`${e.source}${e.seq}`);
  }
  const latest = new Map<bigint, { seq: bigint; data: ChangeAttributionData }>();
  for (const e of events) {
    if (e.type !== ATTRIBUTION) continue;
    if (!/^[1-9][0-9]*$/.test(e.data.change_seq)) continue;
    const changeSeq = BigInt(e.data.change_seq);
    const attrSeq = BigInt(e.seq);
    if (changeSeq >= attrSeq) continue; // must strictly precede its target
    if (!changeSeqsBySource.has(`${e.source}${e.data.change_seq}`)) continue;
    const cur = latest.get(changeSeq);
    if (!cur || attrSeq > cur.seq) latest.set(changeSeq, { seq: attrSeq, data: e.data });
  }
  return latest;
}

/** Whether an invocation's ±window overlaps the observation interval, inclusive. */
function windowOverlaps(inv: Invocation, start: number, end: number, windowMs: number): boolean {
  const winStart = inv.minAtMs - windowMs;
  const winEnd = inv.maxAtMs + windowMs;
  return winStart <= end && winEnd >= start;
}

function scopeIncludes(scope: EvidenceFileScope, path: string): boolean {
  return scope.kind === 'paths' && scope.paths.includes(path);
}

/**
 * Match one change against the known invocations under its bound policy. An
 * unavailable interval resolves to `unknown` with its own distinct reason — never
 * conflated with "we looked and found nothing". Each eligible invocation
 * contributes one candidate; conflicts are excluded and disclosed, never counted.
 */
export function evaluateChange(input: EvaluationInput): EvaluationResult {
  const { interval } = input;
  if (interval === undefined || 'unavailable' in interval) {
    return {
      status: 'unknown',
      reason: 'observation-interval-unavailable',
      evidenceSeqs: [],
      excludedConflicts: [],
    };
  }

  const eligible: Invocation[] = [];
  const conflicts: Invocation[] = [];
  for (const inv of input.invocations) {
    const relevant =
      scopeIncludes(inv.scope, input.path) &&
      windowOverlaps(inv, interval.start_ms, interval.end_ms, input.policy.window_ms);
    if (!relevant) continue;
    if (inv.conflicted) conflicts.push(inv);
    else eligible.push(inv);
  }

  const evidenceSeqs = eligible
    .flatMap((inv) => inv.evidenceSeqs)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const excludedConflicts = conflicts
    .slice()
    .sort((a, b) => (a.keyStr < b.keyStr ? -1 : a.keyStr > b.keyStr ? 1 : 0))
    .map((inv) => inv.key);

  let status: AttributionStatus;
  let reason: AttributionReason;
  if (eligible.length >= 2) {
    status = 'ambiguous';
    reason = 'multiple-candidates';
  } else if (eligible.length === 1) {
    status = 'heuristic';
    reason = 'single-candidate';
  } else {
    status = 'unknown';
    reason = 'no-matching-evidence';
  }

  return { status, reason, evidenceSeqs, excludedConflicts };
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Whether two attribution results are semantically identical, so a re-evaluation
 * that reproduces the last result appends nothing. Compares the meaning, not the
 * envelope: status, reason, bound policy, evidence set, and conflict disclosure.
 */
export function attributionResultsEqual(
  a: Pick<ChangeAttributionData, 'status' | 'reason' | 'policy_seq' | 'evidence_seqs' | 'excluded_conflicts'>,
  b: Pick<ChangeAttributionData, 'status' | 'reason' | 'policy_seq' | 'evidence_seqs' | 'excluded_conflicts'>,
): boolean {
  if (a.status !== b.status || a.reason !== b.reason || a.policy_seq !== b.policy_seq) return false;
  if (!sameStringSet(a.evidence_seqs, b.evidence_seqs)) return false;
  const ca = (a.excluded_conflicts ?? []).map(evidenceKeyString);
  const cb = (b.excluded_conflicts ?? []).map(evidenceKeyString);
  return sameStringSet(ca, cb);
}

export type AttributionEvent = CloudEvent<'slipstream.change.attribution.v1'>;
