/**
 * Compares a known write trace against the events actually committed, bucketed
 * by how bad each kind of divergence is (per STAGE-1-BRIEF.md). A raw loss
 * percentage is deliberately avoided: burst-within-file is mild, while
 * endpoint-wrong and phantom are correctness bugs.
 */

export type ObservedState =
  | { kind: 'content'; sha256: string }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason: string };

/** The state a path was left in after one write in the scripted trace. */
export interface TraceStep {
  path: string;
  state: ObservedState;
}

export interface RecordState {
  path: string;
  after: ObservedState;
}

export interface LossReport {
  burstWithinFile: number;
  wholeChangeLost: number;
  endpointWrong: number;
  phantom: number;
  orderingWrong: number;
}

function key(s: ObservedState): string {
  if (s.kind === 'content') return `c:${s.sha256}`;
  if (s.kind === 'unavailable') return `u:${s.reason}`;
  return 'absent';
}

function collapseConsecutive(keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) if (out.at(-1) !== k) out.push(k);
  return out;
}

function isSubsequence(needles: string[], haystack: string[]): boolean {
  let i = 0;
  for (const h of haystack) {
    if (i < needles.length && needles[i] === h) i++;
  }
  return i === needles.length;
}

function groupByPath<T extends { path: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const list = map.get(item.path) ?? [];
    list.push(item);
    map.set(item.path, list);
  }
  return map;
}

export function categorize(trace: TraceStep[], records: RecordState[]): LossReport {
  const report: LossReport = {
    burstWithinFile: 0,
    wholeChangeLost: 0,
    endpointWrong: 0,
    phantom: 0,
    orderingWrong: 0,
  };

  const traceByPath = groupByPath(trace);
  const recordsByPath = groupByPath(records);
  const paths = new Set([...traceByPath.keys(), ...recordsByPath.keys()]);

  for (const path of paths) {
    const traceStates = collapseConsecutive((traceByPath.get(path) ?? []).map((s) => key(s.state)));
    const validKeys = new Set(traceStates);
    const recAll = (recordsByPath.get(path) ?? []).map((r) => key(r.after));
    const recValid = recAll.filter((k) => validKeys.has(k));

    if (traceStates.length === 0) {
      report.phantom += recAll.length;
      continue;
    }
    report.endpointWrong += recAll.length - recValid.length;
    if (recValid.length === 0) {
      report.wholeChangeLost += 1;
      continue;
    }
    if (!isSubsequence(recValid, traceStates)) {
      report.orderingWrong += 1;
      continue;
    }
    if (recValid.at(-1) !== traceStates.at(-1)) {
      report.wholeChangeLost += 1;
    } else {
      report.burstWithinFile += traceStates.length - recValid.length;
    }
  }

  return report;
}
