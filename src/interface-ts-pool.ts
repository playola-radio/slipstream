import { Worker } from 'node:worker_threads';
import type { TypeScriptJob, TypeScriptReply, TypeScriptResult } from './interface-ts-worker.ts';
import { emitProjectionPhase, emitProjectionTrace, traceProcessId, type ProjectionTraceObserver } from './projection-trace.ts';

const WORKER_URL = new URL('./interface-ts-worker.ts', import.meta.url);

/** One persistent parser worker. Cancellation terminates synchronous WASM work. */
export function createTypeScriptPool(trace?: ProjectionTraceObserver) {
  let active: { id: number; traceUnitId?: number; startedAtNs?: bigint;
    resolve: (value: TypeScriptResult) => void; reject: (error: Error) => void } | null = null;
  let serial = 0;
  let closed = false;
  let current: Worker | null = null;
  const retiring = new Set<Promise<unknown>>();
  const identities = new WeakMap<Worker, number>();
  const retire = (worker: Worker, traceUnitId?: number): void => {
    const processId = identities.get(worker);
    if (processId !== undefined && traceUnitId !== undefined)
      emitProjectionTrace(trace, { kind: 'process-retire', processId, unitId: traceUnitId, atNs: process.hrtime.bigint() });
    const completion = worker.terminate().catch(() => {});
    retiring.add(completion);
    void completion.finally(() => retiring.delete(completion));
  };
  const spawn = (): Worker => {
    const startedAtNs = trace ? process.hrtime.bigint() : undefined;
    const worker = new Worker(WORKER_URL);
    const processId = trace ? traceProcessId() : undefined;
    if (processId !== undefined) {
      identities.set(worker, processId);
      emitProjectionTrace(trace, { kind: 'process-start', processId, process: 'ts-worker', atNs: process.hrtime.bigint() });
      worker.once('online', () => emitProjectionPhase(trace, 'worker-startup', startedAtNs, { processId }));
    }
    worker.on('message', (reply: TypeScriptReply) => {
      const task = active;
      if (!task || task.id !== reply.id) return;
      active = null;
      emitProjectionPhase(trace, 'worker-roundtrip', task.startedAtNs, { unitId: task.traceUnitId, processId });
      if (reply.ok) {
        if (reply.result.traceTimings && processId !== undefined) {
          const atNs = process.hrtime.bigint();
          emitProjectionTrace(trace, { kind: 'phase', phase: 'grammar-load', atNs,
            durationNs: reply.result.traceTimings.grammarLoadNs, unitId: task.traceUnitId, processId });
          emitProjectionTrace(trace, { kind: 'phase', phase: 'parse-compare', atNs,
            durationNs: reply.result.traceTimings.parseCompareNs, unitId: task.traceUnitId, processId });
        }
        task.resolve(reply.result);
      }
      else {
        if (worker === current) current = null;
        retire(worker, task.traceUnitId);
        task.reject(new Error('TypeScript extraction failed'));
      }
    });
    worker.on('error', (error: Error) => {
      if (worker !== current) return; // a retired worker must not fail its replacement's job
      const task = active;
      active = null;
      current = null;
      retire(worker, task?.traceUnitId);
      task?.reject(error);
    });
    worker.on('exit', code => {
      if (processId !== undefined) emitProjectionTrace(trace,
        { kind: 'process-exit', processId, code, atNs: process.hrtime.bigint() });
      if (closed || worker !== current) return;
      const task = active;
      active = null;
      current = null;
      task?.reject(new Error(`TypeScript parser worker exited ${code}`));
    });
    return worker;
  };
  const run = (input: Omit<TypeScriptJob, 'id'>, traceUnitId?: number) => {
    if (closed || active) throw new Error('TypeScript parser worker unavailable');
    current ??= spawn();
    const worker = current;
    const id = ++serial;
    const promise = new Promise<TypeScriptResult>((resolve, reject) => {
      active = { id, traceUnitId, startedAtNs: trace ? process.hrtime.bigint() : undefined, resolve, reject };
      worker.postMessage({ ...input, id, ...(trace ? { traceTimings: true } : {}) } satisfies TypeScriptJob);
    });
    const cancel = () => {
      const task = active;
      if (!task || task.id !== id) return;
      active = null;
      task.reject(new Error('TypeScript extraction cancelled'));
      if (current === worker) current = null;
      retire(worker, task.traceUnitId);
    };
    return { promise, cancel };
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    const task = active;
    active = null;
    task?.reject(new Error('TypeScript parser worker closed'));
    if (current) await current.terminate().catch(() => {});
    await Promise.all(retiring);
  };
  return { run, close };
}
