/** Test-only reader observation. Never persisted or included in HTTP responses. */
export type ProjectionTraceEvent =
  | { kind: 'admission'; unitId: number; routeKey: string; workload: 'interface' | 'clip';
      atNs: bigint; disposition: 'running' | 'queued' | 'waiting' | 'overloaded' }
  | { kind: 'dispatch'; unitId: number; atNs: bigint }
  | { kind: 'settle'; unitId: number; atNs: bigint;
      priorState: 'running' | 'queued' | 'waiting' | 'overloaded';
      outcome: 'ok' | 'timeout' | 'overloaded' | 'cancelled' | 'closed' | 'error' }
  | { kind: 'interface-file'; routeKey: string; path: string; atNs: bigint;
      freshness: 'fresh' | 'cache-hit' | 'none'; resultStatus: string };

export type ProjectionTraceObserver = (event: ProjectionTraceEvent) => void;
