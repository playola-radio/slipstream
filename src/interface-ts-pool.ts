import { Worker } from 'node:worker_threads';
import type { TypeScriptJob, TypeScriptReply, TypeScriptResult } from './interface-ts-worker.ts';

const WORKER_URL = new URL('./interface-ts-worker.ts', import.meta.url);

/** One persistent parser worker. Cancellation terminates synchronous WASM work. */
export function createTypeScriptPool() {
  let active: { id: number; resolve: (value: TypeScriptResult) => void; reject: (error: Error) => void } | null = null;
  let serial = 0;
  let closed = false;
  const retiring = new Set<Promise<unknown>>();
  const retire = (worker: Worker): void => {
    const completion = worker.terminate().catch(() => {});
    retiring.add(completion);
    void completion.finally(() => retiring.delete(completion));
  };
  const spawn = (): Worker => {
    const worker = new Worker(WORKER_URL);
    worker.on('message', (reply: TypeScriptReply) => {
      const task = active;
      if (!task || task.id !== reply.id) return;
      active = null;
      if (reply.ok) task.resolve(reply.result);
      else task.reject(new Error('TypeScript extraction failed'));
    });
    worker.on('error', (error: Error) => {
      if (worker !== current) return; // a retired worker must not fail its replacement's job
      const task = active;
      active = null;
      retire(worker);
      if (!closed) current = spawn();
      task?.reject(error);
    });
    worker.on('exit', code => {
      if (closed || worker !== current) return;
      const task = active;
      active = null;
      current = spawn();
      task?.reject(new Error(`TypeScript parser worker exited ${code}`));
    });
    return worker;
  };
  let current = spawn();
  const run = (input: Omit<TypeScriptJob, 'id'>) => {
    if (closed || active) throw new Error('TypeScript parser worker unavailable');
    const id = ++serial;
    const promise = new Promise<TypeScriptResult>((resolve, reject) => {
      active = { id, resolve, reject };
      current.postMessage({ ...input, id } satisfies TypeScriptJob);
    });
    const cancel = () => {
      const task = active;
      if (!task || task.id !== id) return;
      active = null;
      task.reject(new Error('TypeScript extraction cancelled'));
      retire(current);
      if (!closed) current = spawn();
    };
    return { promise, cancel };
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    const task = active;
    active = null;
    task?.reject(new Error('TypeScript parser worker closed'));
    await current.terminate().catch(() => {});
    await Promise.all(retiring);
  };
  return { run, close };
}
