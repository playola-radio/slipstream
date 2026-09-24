/**
 * Attribution scoring — candidate matching ({@link evaluateChange}) and result
 * equality ({@link attributionResultsEqual}). Deliberately kept out of
 * `attribution.ts` so the display fold's code boundary covers display code only.
 */
import type {
  AttributionReason,
  AttributionStatus,
  ChangeAttributionData,
  EnrichmentPolicy,
  EvidenceKey,
  ObservedInterval,
} from './event.ts';
import { evidenceKeyString, type Invocation } from './attribution.ts';

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
