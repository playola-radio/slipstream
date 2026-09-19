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
  EnrichmentPolicy,
  EvidenceKey,
  HarnessEvidenceData,
  ObservedInterval,
} from './event.ts';

/** A distinct harness invocation, reconstructed by joining every evidence record
 * that shares one `evidence_key`. This — not an agent — is a "candidate". */
export interface Invocation {
  key: EvidenceKey;
  keyStr: string;
  /** Earliest/latest timestamp across the joined records (pre-window). */
  minAtMs: number;
  maxAtMs: number;
  /** Union of every declared known path across the joined records, ascending. A
   * record with `unknown` scope contributes no path — we cannot claim it touched
   * a given file — but its conflict is still disclosed when a sibling variant
   * names the change's path. */
  knownPaths: readonly string[];
  /** True when records under this key contradict each other; such an invocation
   * is never counted as a candidate, only disclosed. */
  conflicted: boolean;
  /** Seqs of the distinct evidence records making up this invocation, ascending. */
  evidenceSeqs: bigint[];
}

export interface EvaluationInput {
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

/** A stable string identity for an evidence key, safe as a Map key. JSON-encoded
 * so no component's bytes can bleed into another's: plain concatenation (even with
 * a unit separator) collides, since the schema forbids no character in these ids. */
export function evidenceKeyString(key: EvidenceKey): string {
  return JSON.stringify([key.harness, key.harness_session_id, key.record_id]);
}

/** Canonical signature of the semantic fact a record asserts, used for both dedup
 * (identical signature = one variant) and conflict detection. Adapter version is
 * deliberately excluded: a re-emit under a newer adapter is the same fact. Scope is
 * a structured value, so `['a,b']` (one path) and `['a','b']` (two) never collide. */
export function variantSignature(data: Omit<HarnessEvidenceData, 'session_id'>): string {
  const scope =
    data.file_scope.kind === 'paths'
      ? { kind: 'paths', paths: [...data.file_scope.paths].sort() }
      : { kind: 'unknown', reason: data.file_scope.reason };
  return JSON.stringify([data.tool_name, data.timestamp.basis, data.timestamp.at_ms, scope]);
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

    let minAtMs = Infinity;
    let maxAtMs = -Infinity;
    // Union of known paths across every variant. An `unknown`-scope variant adds
    // no path (we cannot say what it touched), but a sibling variant that names a
    // path keeps the invocation relevant — so a conflict is still disclosed.
    const paths = new Set<string>();
    for (const v of variants) {
      minAtMs = Math.min(minAtMs, v.data.timestamp.at_ms);
      maxAtMs = Math.max(maxAtMs, v.data.timestamp.at_ms);
      if (v.data.file_scope.kind === 'paths') for (const p of v.data.file_scope.paths) paths.add(p);
    }

    out.set(keyStr, {
      key: group.key,
      keyStr,
      minAtMs,
      maxAtMs,
      knownPaths: [...paths].sort(),
      conflicted,
      evidenceSeqs,
    });
  }
  return out;
}

/** The Fork-1 identity of a change/attribution target: `(source, change_seq)`.
 * A change seq alone is NOT unique — two sessions each hold a change seq `2` — so
 * a fold over a multi-session stream must key by both or silently drop one. */
export function attributionTargetKey(source: string, changeSeq: bigint | string): string {
  return JSON.stringify([source, String(changeSeq)]);
}

/**
 * The Fork-3 public fold: each change's current attribution, keyed by the
 * `(source, change_seq)` identity. An attribution is counted only if its target
 * reference is valid — an existing `file.changed.v1` in the same source with a
 * strictly smaller seq (Fork 1). The highest-seq valid attribution wins, so a
 * revision supersedes without mutating any prior record.
 */
export function foldAttributions(
  events: readonly AnyEvent[],
): Map<string, { seq: bigint; source: string; data: ChangeAttributionData }> {
  const changeTargets = new Set<string>();
  for (const e of events) {
    if (e.type === FILE_CHANGED) changeTargets.add(attributionTargetKey(e.source, e.seq));
  }
  const latest = new Map<string, { seq: bigint; source: string; data: ChangeAttributionData }>();
  for (const e of events) {
    if (e.type !== ATTRIBUTION) continue;
    if (!/^[1-9][0-9]*$/.test(e.data.change_seq)) continue;
    const changeSeq = BigInt(e.data.change_seq);
    const attrSeq = BigInt(e.seq);
    if (changeSeq >= attrSeq) continue; // must strictly precede its target
    const targetKey = attributionTargetKey(e.source, e.data.change_seq);
    if (!changeTargets.has(targetKey)) continue;
    const cur = latest.get(targetKey);
    if (!cur || attrSeq > cur.seq) latest.set(targetKey, { seq: attrSeq, source: e.source, data: e.data });
  }
  return latest;
}

/** Whether an invocation's ±window overlaps the observation interval, inclusive. */
function windowOverlaps(inv: Invocation, start: number, end: number, windowMs: number): boolean {
  const winStart = inv.minAtMs - windowMs;
  const winEnd = inv.maxAtMs + windowMs;
  return winStart <= end && winEnd >= start;
}

function touchesPath(inv: Invocation, path: string): boolean {
  return inv.knownPaths.includes(path);
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
      touchesPath(inv, input.path) &&
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
