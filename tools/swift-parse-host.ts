/**
 * The isolated feasibility child: the ONLY process that loads and parses the
 * Swift grammar. It must be launched with `node --liftoff-only` (see
 * src/swift-grammar.ts for why); the runner (tools/swift-parse.ts) does that.
 * It reads one JSON request on stdin, performs one operation, prints one JSON
 * result line on stdout, and exits. Keeping every real Swift load behind this
 * boundary means a stray default-launch parse can never abort the checker, the
 * test runner, or the daemon.
 */
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { isMainModule } from '../src/entrypoint.ts';
import { loadSwiftLanguage, parseSwiftSource, type ArtifactProvenance, type SwiftParseResult } from '../src/swift-grammar.ts';
import type { WorkerMessage } from './swift-parse-worker.ts';
import { extractSwiftSource, type SwiftLimits, type SwiftSide } from '../src/swift-interface-extract.ts';

const WORKER_URL = new URL('./swift-parse-worker.ts', import.meta.url);

export type HostRequest =
  | { op: 'parse'; source: string }
  | { op: 'extract'; sides: { id: string; source: string }[]; limits?: SwiftLimits }
  | { op: 'survive'; source: string; holdMs: number }
  | { op: 'measure'; sources: { label: string; source: string }[] }
  | { op: 'cancel-demo'; pathologicalSource: string; cleanSource: string };

interface ParseTimings {
  initAndLoadMs: number;
  firstParseMs: number;
}

export type HostResult =
  | { op: 'parse'; provenance: ArtifactProvenance; result: SwiftParseResult; timings: ParseTimings }
  | { op: 'extract'; results: { id: string; side: SwiftSide }[] }
  | { op: 'survive'; result: SwiftParseResult; heldMs: number }
  | { op: 'measure'; provenance: ArtifactProvenance; initAndLoadMs: number; parses: { label: string; byteLength: number; clean: boolean; firstParseMs: number; warmParseMs: number }[] }
  | { op: 'cancel-demo'; startedBeforeCancel: boolean; inProgressAtCancel: boolean; terminateMs: number; replacement: { clean: boolean; rootType: string } };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

async function readRequest(): Promise<HostRequest> {
  const [mode, path] = process.argv.slice(2);
  if (mode === '--parse-file') {
    if (path === undefined) throw new Error('--parse-file requires a path');
    return { op: 'parse', source: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path)) };
  }
  if (mode === '--parse-stdin') return { op: 'parse', source: await readStdin() };
  return JSON.parse(await readStdin()) as HostRequest;
}

/** Run one Swift parse in a fresh terminable worker, resolving when the parse
 * finishes (`done`) — or rejecting if the worker errors. Returns a `cancel`
 * that hard-terminates the worker (a synchronous parse cannot be stopped from
 * inside), a `started` promise that resolves when the worker is about to block
 * in the parse, and `finished()`, which reads a shared flag the worker sets the
 * instant the parse returns. Because the parse is synchronous, `started` can
 * only fire immediately before it; the caller proves mid-flight cancellation by
 * reading `finished()` (shared memory, immune to this process's event-loop
 * scheduling), not by trusting `started` alone or by racing a `done` message. */
export function runInWorker(source: string, workerUrl: URL = WORKER_URL): {
  done: Promise<SwiftParseResult>;
  started: Promise<void>;
  finished: () => boolean;
  cancel: () => Promise<number>;
  worker: Worker;
} {
  const worker = new Worker(workerUrl);
  const progress = new Int32Array(new SharedArrayBuffer(4));
  let onStarted!: () => void;
  let rejectStarted!: (err: Error) => void;
  const started = new Promise<void>((res, reject) => { onStarted = res; rejectStarted = reject; });
  let settled = false;
  const fail = (err: Error): void => {
    if (settled) return;
    settled = true;
    rejectStarted(err);
    rejectDone(err);
  };
  let rejectDone!: (err: Error) => void;
  const done = new Promise<SwiftParseResult>((resolve, reject) => {
    rejectDone = reject;
    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'started') onStarted();
      else if (msg.type === 'done') {
        settled = true;
        resolve(msg.result);
      } else fail(new Error(msg.message));
    });
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (code !== 0) fail(new Error(`Swift parse worker exited before completing (code=${code})`));
    });
  });
  // The cancellation path intentionally does not await `done`; mark its
  // rejection observed while preserving the promise for normal callers.
  void done.catch(() => {});
  worker.postMessage({ source, progress });
  return {
    done,
    started,
    finished: () => Atomics.load(progress, 0) === 1,
    cancel: () => worker.terminate(),
    worker,
  };
}

async function main(): Promise<number> {
  const request = await readRequest();

  if (request.op === 'cancel-demo') {
    const first = runInWorker(request.pathologicalSource);
    await first.started;
    // Completion guard: a synchronous parse can only be terminated from outside,
    // so `started` is posted just before the parse blocks the worker. Give it a
    // beat to get into the parse, then hard-terminate and read the worker's
    // shared progress flag AFTER teardown completes. The worker stores the flag
    // the instant the parse returns, before any teardown, so once the thread has
    // exited: flag set => the parse finished before it was killed; flag unset =>
    // it was still parsing when terminated. Sampling at the teardown boundary
    // (not before terminate) closes the check-to-terminate window — a parse that
    // completes while the host is descheduled is observed as finished, never
    // mis-reported as interrupted. `inProgressAtCancel:false` means the
    // pathological input finished before the kill landed; the acceptance check
    // treats that as a failure, never a pass. (One irreducible sub-instruction
    // window remains: a parse that returns but is killed before its very next
    // store executes — documented in SWIFT-GRAMMAR.md, inherent to a
    // non-interruptible synchronous parse.)
    await new Promise((res) => setTimeout(res, 150));
    const t = performance.now();
    await first.cancel();
    const terminateMs = performance.now() - t;
    const inProgressAtCancel = !first.finished();
    // The runtime recovers: a replacement worker parses clean input to completion.
    const second = runInWorker(request.cleanSource);
    const result = await second.done;
    await second.worker.terminate();
    print({
      op: 'cancel-demo',
      startedBeforeCancel: true,
      inProgressAtCancel,
      terminateMs,
      replacement: { clean: result.clean, rootType: result.rootType },
    });
    return 0;
  }

  const t0 = performance.now();
  const loaded = await loadSwiftLanguage();
  const initAndLoadMs = performance.now() - t0;

  if (request.op === 'parse') {
    const p0 = performance.now();
    const result = parseSwiftSource(loaded.language, request.source);
    const firstParseMs = performance.now() - p0;
    print({ op: 'parse', provenance: loaded.provenance, result, timings: { initAndLoadMs, firstParseMs } });
    return 0;
  }

  if (request.op === 'extract') {
    const results = request.sides.map(({ id, source }) => ({ id, side: extractSwiftSource(loaded.language, source, request.limits) }));
    print({ op: 'extract', results });
    return 0;
  }

  if (request.op === 'measure') {
    const parses = request.sources.map(({ label, source }) => {
      const f0 = performance.now();
      const first = parseSwiftSource(loaded.language, source);
      const firstParseMs = performance.now() - f0;
      const w0 = performance.now();
      parseSwiftSource(loaded.language, source);
      const warmParseMs = performance.now() - w0;
      return { label, byteLength: first.byteLength, clean: first.clean, firstParseMs, warmParseMs };
    });
    print({ op: 'measure', provenance: loaded.provenance, initAndLoadMs, parses });
    return 0;
  }

  // op: 'survive' — parse, then stay alive past the observed OOM window and exit
  // 0. A default-launch process aborts during this hold; surviving it is the
  // load-bearing proof that --liftoff-only actually prevents the delayed crash.
  const result = parseSwiftSource(loaded.language, request.source);
  await new Promise((res) => setTimeout(res, request.holdMs));
  print({ op: 'survive', result, heldMs: request.holdMs });
  return 0;
}

function print(result: HostResult): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (isMainModule(import.meta.url, process.argv[1] ?? '')) {
  main().then(
    (code) => process.stdout.write('', () => process.exit(code)),
    (err) => { process.stderr.write(`swift-parse-host: ${(err as Error).stack ?? err}\n`); process.exit(2); },
  );
}
