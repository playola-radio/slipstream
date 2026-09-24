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
import { CLIP_PROJECTION_VERSION, type ClipProjection } from './clip-projection.ts';
import type { ClipJob } from './clip-blob-reader.ts';
import type { ClipWorkerRequest, ClipWorkerResponse } from './clip-projection-worker.ts';

export interface ClipComputeHandle { promise: Promise<ClipProjection>; cancel: () => void }
export type ClipCompute = (job: ClipJob) => ClipComputeHandle;

export interface ClipWorkerPool { run: ClipCompute; close: () => Promise<void> }

const WORKER_URL = new URL('./clip-projection-worker.ts', import.meta.url);

function workerErrorResult(): ClipProjection {
  return {
    change_seq: '',
    projection_version: CLIP_PROJECTION_VERSION,
    status: 'skipped',
    fallback_reason: 'worker-error',
    clips: [],
  };
}

export function createClipWorkerPool(): ClipWorkerPool {
  let current: { id: number; resolve: (v: ClipProjection) => void } | null = null;
  let jobId = 0;
  let closed = false;
  // Terminations started by cancel()/error (fire-and-forget from the caller's
  // point of view) but not yet complete. close() must await these too — the
  // worker they belong to is no longer `current` by the time close() runs
  // (cancel() has already spawned and installed its replacement), so awaiting
  // only the current worker would let shutdown finish while the actual
  // CPU-heavy worker is still mid-terminate.
  const pendingTerminations = new Set<Promise<unknown>>();

  const trackTermination = (w: Worker): void => {
    const p = w.terminate().catch(() => {});
    pendingTerminations.add(p);
    p.finally(() => pendingTerminations.delete(p));
  };

  const spawn = (): Worker => {
    const w = new Worker(WORKER_URL);
    w.on('message', (resp: ClipWorkerResponse) => {
      const cur = current;
      if (!cur || cur.id !== resp.id) return; // stale message from before a cancel
      current = null;
      cur.resolve(resp.ok ? resp.result : workerErrorResult());
    });
    w.on('error', () => {
      const cur = current;
      current = null;
      trackTermination(w);
      if (!closed) worker = spawn();
      if (cur) cur.resolve(workerErrorResult());
    });
    return w;
  };

  let worker = spawn();

  const run: ClipCompute = (job) => {
    if (closed || current !== null) {
      // Admission should prevent this; fail safe rather than block.
      return { promise: Promise.resolve(workerErrorResult()), cancel: () => {} };
    }
    let settled = false;
    const promise = new Promise<ClipProjection>((resolve) => {
      const id = ++jobId;
      current = { id, resolve: (v) => { if (!settled) { settled = true; resolve(v); } } };
      worker.postMessage({ id, job } satisfies ClipWorkerRequest);
    });
    const cancel = () => {
      if (settled || current === null) return;
      current.resolve(workerErrorResult());
      current = null;
      const stale = worker;
      trackTermination(stale);
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
