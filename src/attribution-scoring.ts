/**
 * Attribution scoring — candidate matching ({@link evaluateChange}) and result
 * equality ({@link attributionResultsEqual}). Deliberately kept out of
 * `attribution.ts` so the display fold's code boundary covers display code only.
 */
import type {
  AnyEvent,
  AttributionReason,
  AttributionStatus,
  ChangeAttributionData,
  EnrichmentPolicy,
  EvidenceKey,
  ObservedInterval,
} from './event.ts';
import { evidenceKeyString, foldEvidence, variantSignature, type Invocation } from './attribution.ts';

/** An invocation plus the distinct evidence facts its records assert. Kept here,
 * not on {@link Invocation}, so the frozen display-fold closure stays unchanged. */
export interface ScoredInvocation extends Invocation {
  signatures: readonly string[];
}

/** {@link foldEvidence} plus each invocation's sorted, distinct variant signatures. */
export function foldScoredEvidence(events: readonly AnyEvent[]): ScoredInvocation[] {
  const signatures = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type !== 'slipstream.harness.evidence.v1') continue;
    const keyStr = evidenceKeyString(e.data.evidence_key);
    const set = signatures.get(keyStr) ?? new Set<string>();
    set.add(variantSignature(e.data));
    signatures.set(keyStr, set);
  }
  return [...foldEvidence(events).values()].map((inv) => ({
    ...inv,
    signatures: [...(signatures.get(inv.keyStr) ?? [])].sort(),
  }));
}

export interface EvaluationInput {
  path: string;
  /** The change's observation interval; undefined for legacy records with none. */
  interval: ObservedInterval | undefined;
  /** The policy bound to this change (by sequence). */
  policy: EnrichmentPolicy;
  invocations: Iterable<ScoredInvocation>;
}

export interface EvaluationResult {
  status: AttributionStatus;
  reason: AttributionReason;
  /** Supporting evidence seqs from the eligible invocations, ascending. */
  evidenceSeqs: bigint[];
  /** Relevant invocations excluded because their records conflict. */
  excludedConflicts: EvidenceKey[];
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

function isExactCopy(a: ScoredInvocation, b: ScoredInvocation): boolean {
  if (!sameStringSet(a.signatures, b.signatures)) return false;
  const pa = [...a.knownPaths].sort();
  const pb = [...b.knownPaths].sort();
  return (
    a.minAtMs === b.minAtMs &&
    a.maxAtMs === b.maxAtMs &&
    a.evidenceSeqs.length === b.evidenceSeqs.length &&
    pa.length === pb.length &&
    pa.every((p, i) => p === pb[i])
  );
}

/**
 * Split invocations into eligible candidates and conflicts. Groups are formed
 * over ALL invocations sharing `(harness, record_id)` before relevance, so a
 * differing or conflicted copy that is irrelevant to this change still stops
 * the rest collapsing. A group of 2+ non-conflicted exact copies becomes one
 * candidate citing every copy's evidence (if relevant); any other group is
 * handled member by member, relevant members only.
 */
function partitionInvocations(
  invocations: Iterable<ScoredInvocation>,
  isRelevant: (inv: ScoredInvocation) => boolean,
): { eligible: ScoredInvocation[]; conflicts: ScoredInvocation[] } {
  const groups = new Map<string, ScoredInvocation[]>();
  for (const inv of invocations) {
    const id = `${inv.key.harness}\u0000${inv.key.record_id}`;
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [inv]);
    else group.push(inv);
  }
  const eligible: ScoredInvocation[] = [];
  const conflicts: ScoredInvocation[] = [];
  for (const group of groups.values()) {
    const [first] = group as [ScoredInvocation, ...ScoredInvocation[]];
    const collapsible =
      group.length >= 2 && group.every((inv) => !inv.conflicted && isExactCopy(first, inv));
    if (collapsible) {
      if (isRelevant(first)) {
        eligible.push({ ...first, evidenceSeqs: group.flatMap((inv) => inv.evidenceSeqs) });
      }
      continue;
    }
    for (const inv of group) {
      if (!isRelevant(inv)) continue;
      (inv.conflicted ? conflicts : eligible).push(inv);
    }
  }
  return { eligible, conflicts };
}

/**
 * Match one change against the known invocations under its bound policy. An
 * unavailable interval resolves to `unknown` with its own distinct reason — never
 * conflated with "we looked and found nothing". Each eligible invocation
 * contributes one candidate; conflicts are excluded and disclosed, never counted.
 * Copies from forked transcripts repeat a tool call verbatim (same id, tool
 * timestamps, paths), so identical copies count once; copies that differ or are
 * conflicted are not collapsed, so a contradiction is never hidden.
 */
export function evaluateChange(input: EvaluationInput): EvaluationResult {
  const { interval } = input;
  // An absent, explicitly-unavailable, or inverted (end before start, e.g. the
  // wall clock regressed mid-acquisition) interval bounds no real observation
  // window. Treat all three as the honest unavailable disposition rather than
  // matching evidence against a degenerate window and publishing a false result.
  if (interval === undefined || 'unavailable' in interval || interval.end_ms < interval.start_ms) {
    return {
      status: 'unknown',
      reason: 'observation-interval-unavailable',
      evidenceSeqs: [],
      excludedConflicts: [],
    };
  }

  const { eligible, conflicts } = partitionInvocations(
    input.invocations,
    (inv) =>
      touchesPath(inv, input.path) &&
      windowOverlaps(inv, interval.start_ms, interval.end_ms, input.policy.window_ms),
  );

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
