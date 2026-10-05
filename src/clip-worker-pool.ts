/**
 * A single persistent clip-projection worker thread. It exposes the `ClipCompute`
 * seam the service drives: `run(job)` returns a promise plus a `cancel()` the
 * service calls on a wall-clock overrun — cancel terminates the stuck worker
 * (a running diff cannot be interrupted from inside) and spawns a replacement,
 * so a single pathological change cannot wedge the worker. The service's
 * admission gate guarantees at most one concurrent `run` call (B1 runs exactly
 * one worker), so the worker is always free synchronously.
 */
import { Worker } from 'node:worker_threads';
import { siblingModuleUrl } from './sibling-module.ts';
import { CLIP_PROJECTION_VERSION, type ClipProjection } from './clip-projection.ts';
import type { ClipJob } from './clip-blob-reader.ts';
import type { ClipWorkerRequest, ClipWorkerResponse } from './clip-projection-worker.ts';
import { emitProjectionPhase, emitProjectionTrace, traceProcessId, type ProjectionTraceObserver } from './projection-trace.ts';

export interface ClipComputeHandle { promise: Promise<ClipProjection>; cancel: () => void }
export type ClipCompute = (job: ClipJob, traceUnitId?: number) => ClipComputeHandle;

export interface ClipWorkerPool { run: ClipCompute; close: () => Promise<void> }

const WORKER_URL = siblingModuleUrl('clip-projection-worker', import.meta.url);

function workerErrorResult(): ClipProjection {
  return {
    change_seq: '',
    projection_version: CLIP_PROJECTION_VERSION,
    status: 'skipped',
    fallback_reason: 'worker-error',
    clips: [],
  };
}

export function createClipWorkerPool(trace?: ProjectionTraceObserver): ClipWorkerPool {
  let current: { id: number; traceUnitId?: number; startedAtNs?: bigint;
    resolve: (v: ClipProjection) => void } | null = null;
  let jobId = 0;
  let closed = false;
  // Terminations started by cancel()/error (fire-and-forget from the caller's
  // point of view) but not yet complete. close() must await these too — the
  // worker they belong to is no longer `current` by the time close() runs
  // (cancel() has already spawned and installed its replacement), so awaiting
  // only the current worker would let shutdown finish while the actual
  // CPU-heavy worker is still mid-terminate.
  const pendingTerminations = new Set<Promise<unknown>>();
  const identities = new WeakMap<Worker, number>();

  const trackTermination = (w: Worker, traceUnitId?: number): void => {
    const processId = identities.get(w);
    if (processId !== undefined && traceUnitId !== undefined)
      emitProjectionTrace(trace, { kind: 'process-retire', processId, unitId: traceUnitId, atNs: process.hrtime.bigint() });
    const p = w.terminate().catch(() => {});
    pendingTerminations.add(p);
    p.finally(() => pendingTerminations.delete(p));
  };

  const spawn = (): Worker => {
    const startedAtNs = trace ? process.hrtime.bigint() : undefined;
    const w = new Worker(WORKER_URL);
    const processId = trace ? traceProcessId() : undefined;
    if (processId !== undefined) {
      identities.set(w, processId);
      emitProjectionTrace(trace, { kind: 'process-start', processId, process: 'clip-worker', atNs: process.hrtime.bigint() });
      w.once('online', () => emitProjectionPhase(trace, 'worker-startup', startedAtNs, { scope: 'clip', processId }));
      w.on('exit', code => emitProjectionTrace(trace,
        { kind: 'process-exit', processId, code, atNs: process.hrtime.bigint() }));
    }
    w.on('message', (resp: ClipWorkerResponse) => {
      const cur = current;
      if (!cur || cur.id !== resp.id) return; // stale message from before a cancel
      current = null;
      emitProjectionPhase(trace, 'worker-roundtrip', cur.startedAtNs,
        { scope: 'clip', unitId: cur.traceUnitId, processId });
      if (resp.ok && trace && processId !== undefined && resp.traceTimings) for (const timing of resp.traceTimings)
        emitProjectionTrace(trace, { kind: 'phase', scope: 'clip', phase: timing.phase, durationNs: timing.durationNs,
          atNs: process.hrtime.bigint(), unitId: cur.traceUnitId, processId });
      cur.resolve(resp.ok ? resp.result : workerErrorResult());
    });
    w.on('error', () => {
      const cur = current;
      current = null;
      trackTermination(w, cur?.traceUnitId);
      if (!closed) worker = spawn();
      if (cur) cur.resolve(workerErrorResult());
    });
    return w;
  };

  let worker = spawn();

  const run: ClipCompute = (job, traceUnitId) => {
    if (closed || current !== null) {
      // Admission should prevent this; fail safe rather than block.
      return { promise: Promise.resolve(workerErrorResult()), cancel: () => {} };
    }
    let settled = false;
    const processId = identities.get(worker);
    if (processId !== undefined && traceUnitId !== undefined) emitProjectionTrace(trace,
      { kind: 'process-use', processId, unitId: traceUnitId, atNs: process.hrtime.bigint() });
    const promise = new Promise<ClipProjection>((resolve) => {
      const id = ++jobId;
      current = { id, traceUnitId, startedAtNs: trace ? process.hrtime.bigint() : undefined,
        resolve: (v) => { if (!settled) { settled = true; resolve(v); } } };
      worker.postMessage({ id, job, ...(trace ? { traceTimings: true } : {}) } satisfies ClipWorkerRequest);
    });
    const cancel = () => {
      if (settled || current === null) return;
      current.resolve(workerErrorResult());
      current = null;
      const stale = worker;
      trackTermination(stale, traceUnitId);
      if (!closed) worker = spawn();
    };
    return { promise, cancel };
  };

  const close = async (): Promise<void> => {
    closed = true;
    const cur = current;
    current = null;
    if (cur) cur.resolve(workerErrorResult());
    await worker.terminate().catch(() => {});
    await Promise.all(pendingTerminations);
  };

  return { run, close };
}
