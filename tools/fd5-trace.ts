/** Bounded, synchronous observer used only by the FD5 harness. */
import type { ProjectionTraceEvent, ProjectionTraceObserver } from '../src/projection-trace.ts';

export interface PhaseSummary { count: number; buckets: number[] }
export interface ProjectionTraceSnapshot {
  events: ProjectionTraceEvent[];
  phases: Record<string, PhaseSummary>;
  unitPhases: Map<number, Set<string>>;
  routePhases: Map<string, { serialization: number; completion: number }>;
  faults: string[];
}

/** Log2 buckets retain a bounded timing distribution without retaining samples. */
export function createProjectionTraceCollector(maxEvents = 2_000_000):
  { observe: ProjectionTraceObserver; snapshot: () => ProjectionTraceSnapshot } {
  const events: ProjectionTraceEvent[] = [];
  const phases: Record<string, PhaseSummary> = Object.create(null) as Record<string, PhaseSummary>;
  const unitPhases = new Map<number, Set<string>>();
  const routePhases = new Map<string, { serialization: number; completion: number }>();
  const faults: string[] = [];
  const observe: ProjectionTraceObserver = event => {
    if (event.kind === 'phase') {
      if (event.durationNs < 0n || !/^[a-z][a-z-]{0,47}$/.test(event.phase)) {
        if (!faults.includes('invalid phase timing')) faults.push('invalid phase timing');
        return;
      }
      let phase = phases[event.phase];
      if (!phase) {
        if (Object.keys(phases).length >= 32) {
          if (!faults.includes('phase cardinality overflow')) faults.push('phase cardinality overflow');
          return;
        }
        phase = { count: 0, buckets: Array(65).fill(0) as number[] };
        phases[event.phase] = phase;
      }
      const bucket = event.durationNs === 0n ? 0 : Math.min(64, event.durationNs.toString(2).length);
      phase.count++;
      phase.buckets[bucket]!++;
      if (event.unitId !== undefined) {
        if (!unitPhases.has(event.unitId) && unitPhases.size >= maxEvents) {
          if (!faults.includes('phase unit overflow')) faults.push('phase unit overflow');
        } else {
          const names = unitPhases.get(event.unitId) ?? new Set<string>();
          names.add(event.phase);
          unitPhases.set(event.unitId, names);
        }
      }
      if (event.routeKey !== undefined && (event.phase === 'serialization' || event.phase === 'http-completion')) {
        if (!routePhases.has(event.routeKey) && routePhases.size >= maxEvents) {
          if (!faults.includes('phase route overflow')) faults.push('phase route overflow');
        } else {
          const counts = routePhases.get(event.routeKey) ?? { serialization: 0, completion: 0 };
          if (event.phase === 'serialization') counts.serialization++;
          else counts.completion++;
          routePhases.set(event.routeKey, counts);
        }
      }
      return;
    }
    if (events.length >= maxEvents) {
      if (!faults.includes('projection trace overflow')) faults.push('projection trace overflow');
      return;
    }
    events.push(event);
  };
  return { observe, snapshot: () => ({ events, phases, unitPhases, routePhases, faults: [...faults] }) };
}
