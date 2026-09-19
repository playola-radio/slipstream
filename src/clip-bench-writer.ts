/** Worker-side write generator for clip-bench. Keeping writes off the benchmark
 * coordinator's event loop prevents its HTTP bookkeeping from delaying writes. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

interface WriterData {
  root: string;
  repetition: number;
  scheduledWrites: number;
  scheduledIntervalMs: number;
  burstWrites: number;
}

interface WrittenFile {
  path: string;
  body: string;
  startedAtNs: string;
  phase: 'scheduled' | 'burst';
}

if (!parentPort) throw new Error('clip-bench-writer must run in a worker');
const port = parentPort;
const data = workerData as WriterData;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function body(phase: string, index: number): string {
  // Valid TypeScript with distinct source bytes for every expected capture.
  return `export function workload_${data.repetition}_${phase}_${index}(): number { return ${index}; }\n`;
}

async function writeOne(phase: 'scheduled' | 'burst', index: number): Promise<WrittenFile> {
  const path = `${phase}-${data.repetition}-${index}.ts`;
  const contents = body(phase, index);
  const startedAtNs = process.hrtime.bigint().toString();
  await writeFile(join(data.root, path), contents);
  return { path, body: contents, startedAtNs, phase };
}

async function run(): Promise<void> {
  const written: WrittenFile[] = [];
  port.postMessage({ type: 'phase', phase: 'scheduled' });
  for (let index = 0; index < data.scheduledWrites; index++) {
    written.push(await writeOne('scheduled', index));
    if (index + 1 < data.scheduledWrites) await sleep(data.scheduledIntervalMs);
  }

  port.postMessage({ type: 'phase', phase: 'burst' });
  const burst = await Promise.all(
    Array.from({ length: data.burstWrites }, (_, index) => writeOne('burst', index)),
  );
  written.push(...burst);
  port.postMessage({ type: 'complete', written });
}

void run().catch((err) => port.postMessage({ type: 'error', error: String(err) }));
