// Run as a child process: a native addon abort must fail the regression test,
// not take down node:test itself. This reproduces the B2 stress-run crash.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

if (isMainThread) {
  for (let i = 0; i < 20; i++) {
    const worker = new Worker(new URL(import.meta.url));
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve());
        worker.once('error', reject);
      });
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      await worker.terminate();
    }
  }
} else {
  const { indexFunctions } = await import('../clip-function-parser.ts');
  const source = 'function f(){\n' + 'let a=1;\n'.repeat(1000) + '}\n';
  parentPort!.postMessage('ready');
  for (;;) indexFunctions(source, 'typescript');
}
