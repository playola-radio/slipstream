/**
 * A terminable Swift-parse worker, used only to demonstrate cancellation
 * (STAGE-T-PREREQS 3.4). It inherits `--liftoff-only` from the host that spawns
 * it (tools/swift-parse-host.ts), so it can load the grammar without aborting.
 *
 * Protocol: the parent posts `{ source, progress? }`; the worker posts
 * `{ type: 'started' }` immediately before the (synchronous, blocking) parse,
 * then — after the parse returns — writes the shared `progress` flag to 1 and
 * posts `{ type: 'done', result }` (or `{ type: 'error', message }`). A
 * synchronous parse cannot post mid-flight, so `started` fires just before the
 * worker blocks; the parent proves mid-flight cancellation by reading the shared
 * flag (which the worker sets only once the parse has actually finished, immune
 * to the parent's event-loop scheduling), then calling `worker.terminate()` —
 * the clip worker precedent (src/clip-worker-pool.ts).
 */
import { parentPort } from 'node:worker_threads';
import { loadSwiftLanguage, parseSwiftSource, type LoadedSwift } from '../src/swift-grammar.ts';

interface WorkerRequest {
  source: string;
  /** Shared int32; the worker stores 1 the instant the parse returns, before
   * posting `done`, so the parent can tell "finished" from "still parsing"
   * without depending on message delivery. */
  progress?: Int32Array;
}
export type WorkerMessage =
  | { type: 'started' }
  | { type: 'done'; result: ReturnType<typeof parseSwiftSource> }
  | { type: 'error'; message: string };

const port = parentPort;
if (!port) throw new Error('swift-parse-worker must run as a worker thread');

let loaded: LoadedSwift | undefined;

port.on('message', async (req: WorkerRequest) => {
  try {
    loaded ??= await loadSwiftLanguage();
    port.postMessage({ type: 'started' } satisfies WorkerMessage);
    const result = parseSwiftSource(loaded.language, req.source);
    if (req.progress) Atomics.store(req.progress, 0, 1);
    port.postMessage({ type: 'done', result } satisfies WorkerMessage);
  } catch (err) {
    port.postMessage({ type: 'error', message: (err as Error).message } satisfies WorkerMessage);
  }
});
