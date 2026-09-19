/**
 * A tiny pool of clip-projection worker threads. It exposes the `ClipCompute`
 * seam the service drives: `run(job)` returns a promise plus a `cancel()` the
 * service calls on a wall-clock overrun — cancel terminates the stuck worker
 * (a running diff cannot be interrupted from inside) and spawns a replacement,
 * so a single pathological change cannot wedge the pool. The service's admission
 * gate guarantees at most `size` concurrent `run` calls, so a free worker is
 * always available synchronously.
 */
import { Worker } from 'node:worker_threads';
import { CLIP_PROJECTION_VERSION, type ClipProjection } from './clip-projection.ts';
import type { ClipJob } from './clip-blob-reader.ts';
import type { ClipWorkerRequest, ClipWorkerResponse } from './clip-projection-worker.ts';

export interface ClipComputeHandle { promise: Promise<ClipProjection>; cancel: () => void }
export type ClipCompute = (job: ClipJob) => ClipComputeHandle;

export interface ClipWorkerPool { run: ClipCompute; close: () => Promise<void> }

interface Slot { worker: Worker; current: { id: number; resolve: (v: ClipProjection) => void } | null }

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

export function createClipWorkerPool(size = 1, workerUrl: URL = WORKER_URL): ClipWorkerPool {
  const slots = new Set<Slot>();
  const free: Slot[] = [];
  let jobId = 0;
  let closed = false;

  const spawn = (): Slot => {
    const worker = new Worker(workerUrl);
    const slot: Slot = { worker, current: null };
    worker.on('message', (resp: ClipWorkerResponse) => {
      const cur = slot.current;
      if (!cur || cur.id !== resp.id) return; // stale message from before a cancel
      slot.current = null;
      free.push(slot);
      cur.resolve(resp.ok ? resp.result : workerErrorResult());
    });
    worker.on('error', () => {
      const cur = slot.current;
      slot.current = null;
      slots.delete(slot);
      worker.terminate().catch(() => {});
      if (!closed) { const rep = spawn(); slots.add(rep); free.push(rep); }
      if (cur) cur.resolve(workerErrorResult());
    });
    return slot;
  };

  for (let i = 0; i < size; i++) { const s = spawn(); slots.add(s); free.push(s); }

  const run: ClipCompute = (job) => {
    const slot = free.pop();
    if (!slot) {
      // Admission should prevent this; fail safe rather than block.
      return { promise: Promise.resolve(workerErrorResult()), cancel: () => {} };
    }
    let settled = false;
    const promise = new Promise<ClipProjection>((resolve) => {
      const id = ++jobId;
      slot.current = { id, resolve: (v) => { if (!settled) { settled = true; resolve(v); } } };
      slot.worker.postMessage({ id, job } satisfies ClipWorkerRequest);
    });
    const cancel = () => {
      if (settled || slot.current === null) return;
      settled = true;
      slot.current = null;
      slots.delete(slot);
      slot.worker.terminate().catch(() => {});
      if (!closed) { const rep = spawn(); slots.add(rep); free.push(rep); }
    };
    return { promise, cancel };
  };

  const close = async (): Promise<void> => {
    closed = true;
    await Promise.all([...slots].map((s) => s.worker.terminate().catch(() => {})));
    slots.clear();
    free.length = 0;
  };

  return { run, close };
}
