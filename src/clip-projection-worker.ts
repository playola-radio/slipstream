/**
 * Worker-thread entry for clip projection. It runs the CPU-bound diff off the
 * shared daemon event loop so a burst of cold-cache projection requests cannot
 * starve capture. It is a thin wrapper: resolve blob bytes and run the pure
 * core via {@link computeClipProjection}. One request/response per message,
 * keyed by id; the service owns pooling, admission, and the wall-clock deadline
 * (it terminates and replaces this worker on overrun — a stuck diff cannot be
 * interrupted from inside).
 */
import { parentPort } from 'node:worker_threads';
import { computeClipProjection, type ClipJob } from './clip-blob-reader.ts';

export interface ClipWorkerRequest { id: number; job: ClipJob; traceTimings?: boolean }
export type ClipWorkerResponse =
  | { id: number; ok: true; result: import('./clip-projection.ts').ClipProjection;
      traceTimings?: Array<{ phase: string; durationNs: bigint }> }
  | { id: number; ok: false };

if (!parentPort) throw new Error('clip-projection-worker must run as a worker thread');
const port = parentPort;

port.on('message', (msg: ClipWorkerRequest) => {
  const traceTimings: Array<{ phase: string; durationNs: bigint }> | undefined = msg.traceTimings ? [] : undefined;
  computeClipProjection(msg.job, traceTimings ? (phase, durationNs) => traceTimings.push({ phase, durationNs }) : undefined).then(
    (result) => port.postMessage({ id: msg.id, ok: true, result, traceTimings } satisfies ClipWorkerResponse),
    () => port.postMessage({ id: msg.id, ok: false } satisfies ClipWorkerResponse),
  );
});
