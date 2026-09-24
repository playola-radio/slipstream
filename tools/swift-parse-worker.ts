/**
 * A terminable Swift-parse worker, used only to demonstrate cancellation
 * (STAGE-T-PREREQS 3.4). It inherits `--liftoff-only` from the host that spawns
 * it (tools/swift-parse-host.ts), so it can load the grammar without aborting.
 *
 * Protocol: the parent posts `{ source }`; the worker posts `{ type: 'started' }`
 * from the first parse progress callback (proving the parse is under way, then
 * letting it continue), and finally `{ type: 'done', result }` or
 * `{ type: 'error', message }`. A running parse cannot be interrupted from
 * inside — the parent cancels by calling `worker.terminate()`, exactly the clip
 * worker precedent (src/clip-worker-pool.ts).
 */
import { parentPort } from 'node:worker_threads';
import { loadSwiftLanguage, parseSwiftSource, type LoadedSwift } from '../src/swift-grammar.ts';

export interface WorkerRequest {
  source: string;
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
    let announced = false;
    // parseSwiftSource re-enters this callback during parsing; the first call
    // signals the parent that work is in progress, then returns false so the
    // parse keeps running (cancellation is by hard terminate, not cooperative).
    const result = parseWithStartSignal(loaded, req.source, () => {
      if (!announced) {
        announced = true;
        port.postMessage({ type: 'started' } satisfies WorkerMessage);
      }
    });
    port.postMessage({ type: 'done', result } satisfies WorkerMessage);
  } catch (err) {
    port.postMessage({ type: 'error', message: (err as Error).message } satisfies WorkerMessage);
  }
});

function parseWithStartSignal(loaded: LoadedSwift, source: string, onStart: () => void): ReturnType<typeof parseSwiftSource> {
  onStart();
  return parseSwiftSource(loaded.language, source);
}
