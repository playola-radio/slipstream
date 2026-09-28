/** Test-only reader observation. Never persisted or included in HTTP responses. */
export type ProjectionTraceEvent =
  | { kind: 'admission'; unitId: number; routeKey: string; workload: 'interface' | 'clip';
      atNs: bigint; disposition: 'running' | 'queued' | 'waiting' | 'overloaded' }
  | { kind: 'dispatch'; unitId: number; atNs: bigint }
  | { kind: 'settle'; unitId: number; atNs: bigint;
      priorState: 'running' | 'queued' | 'waiting' | 'overloaded';
      outcome: 'ok' | 'timeout' | 'overloaded' | 'cancelled' | 'closed' | 'error' }
  | { kind: 'interface-file'; routeKey: string; path: string; atNs: bigint;
      freshness: 'fresh' | 'cache-hit' | 'none'; resultStatus: string }
  | { kind: 'task-finished'; unitId: number; atNs: bigint }
  | { kind: 'process-start'; processId: number; process: 'clip-worker' | 'ts-worker' | 'swift-child';
      unitId?: number; atNs: bigint }
  | { kind: 'process-retire'; processId: number; unitId: number; atNs: bigint }
  | { kind: 'process-exit'; processId: number; atNs: bigint; code: number | null; signal?: string | null }
  | { kind: 'process-spawn-failed'; processId: number; unitId?: number; atNs: bigint }
  | { kind: 'clip-cache-bypass'; routeKey: string; atNs: bigint }
  | { kind: 'phase'; phase: string; durationNs: bigint; atNs: bigint;
      unitId?: number; path?: string; routeKey?: string; processId?: number };

export type ProjectionTraceObserver = (event: ProjectionTraceEvent) => void;

let nextProcessId = 0;
export function traceProcessId(): number { return ++nextProcessId; }

/** Test observation must never alter reader outcomes or create unhandled rejections. */
export function emitProjectionTrace(observer: ProjectionTraceObserver | undefined, event: ProjectionTraceEvent): void {
  try {
    const returned = observer?.(event) as unknown;
    if (returned instanceof Promise) void returned.catch(() => {});
  } catch { /* optional observation */ }
}

export function emitProjectionPhase(observer: ProjectionTraceObserver | undefined, phase: string,
  startedAtNs: bigint | undefined, detail: { unitId?: number; path?: string; routeKey?: string; processId?: number } = {}): void {
  if (!observer || startedAtNs === undefined) return;
  const atNs = process.hrtime.bigint();
  emitProjectionTrace(observer, { kind: 'phase', phase, durationNs: atNs - startedAtNs, atNs, ...detail });
}
