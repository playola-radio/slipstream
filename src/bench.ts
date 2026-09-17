/**
 * Stage 1 measurement harness. Produces the two numbers the gate requires:
 *
 *   1. Latency (p50/p99, write -> observed record time) for a single small file, a
 *      1 MiB file, and a burst of 100 files.
 *   2. Loss by category against a known write trace, via src/loss.ts.
 *
 * This is not a unit test — filesystem timing is nondeterministic, so the
 * scenarios are run and reported, never asserted. The pure piece (percentile)
 * is unit-tested in bench.test.ts. Run with `npm run bench`.
 */
import { mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { startCapture, type CaptureSession } from './session.ts';
import { isMainModule } from './entrypoint.ts';
import type { AnyEvent, CloudEvent } from './event.ts';
import { categorize, type ObservedState, type RecordState, type TraceStep } from './loss.ts';

type LoggedRecord = AnyEvent;
type ChangedRecord = CloudEvent<'slipstream.file.changed.v1'>;
const isChanged = (r: AnyEvent): r is ChangedRecord => r.type === 'slipstream.file.changed.v1';

const BENCH_WAIT_TIMEOUT_MS = 15000;

/** Nearest-rank percentile over an ascending-sorted sample. NaN if empty. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[idx]!;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function readBenchRecords(logPath: string): Promise<LoggedRecord[]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  return complete
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LoggedRecord);
}

async function waitFor(
  logPath: string,
  predicate: (recs: LoggedRecord[]) => boolean,
): Promise<LoggedRecord[]> {
  const deadline = Date.now() + BENCH_WAIT_TIMEOUT_MS;
  for (;;) {
    const recs = await readBenchRecords(logPath);
    if (predicate(recs)) return recs;
    if (Date.now() > deadline) return recs;
    await sleep(10);
  }
}

interface Session {
  root: string;
  session: CaptureSession;
}

async function withSession(fn: (s: Session) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'slip-bench-wt-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-bench-st-'));
  const session = await startCapture({ root, storeDir: store });
  try {
    await fn({ root, session });
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

function stats(latencies: number[]): { n: number; p50: number; p99: number } {
  const sorted = [...latencies].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p99: percentile(sorted, 99) };
}

/** Latency for isolated writes: one file per iteration, waited to commit. */
async function latencySingleFile(bytesPer: number, iterations: number): Promise<number[]> {
  const latencies: number[] = [];
  await withSession(async ({ root, session }) => {
    for (let i = 0; i < iterations; i++) {
      const body = Buffer.alloc(bytesPer);
      body.write(`iter-${i}-`); // make each iteration's content unique
      const digest = sha(body);
      const path = join(root, `f${i}.dat`);
      const t0 = Date.now();
      await writeFile(path, body);
      const recs = await waitFor(session.logPath, (r) =>
        r.some((x) => isChanged(x) && x.data.after.kind === 'content' && x.data.after.sha256 === digest),
      );
      const rec = recs.find((x) => isChanged(x) && x.data.after.kind === 'content' && x.data.after.sha256 === digest);
      if (rec) latencies.push(Date.parse(rec.time) - t0);
    }
  });
  return latencies;
}

/** Latency for a burst: write 100 distinct files as fast as possible. */
async function latencyBurst(count: number): Promise<number[]> {
  const latencies: number[] = [];
  await withSession(async ({ root, session }) => {
    const t0 = new Map<string, number>();
    const expected = new Map<string, string>(); // rel path -> sha
    for (let i = 0; i < count; i++) {
      const rel = `burst${i}.dat`;
      const body = `burst-file-${i}`;
      expected.set(rel, sha(body));
      t0.set(rel, Date.now());
      await writeFile(join(root, rel), body);
    }
    const recs = await waitFor(session.logPath, (r) => {
      const seen = new Set(
        r
          .filter((x) => isChanged(x) && x.data.after.kind === 'content')
          .map((x) => (x as ChangedRecord).data.path),
      );
      return [...expected.keys()].every((p) => seen.has(p));
    });
    for (const [rel, digest] of expected) {
      const rec = recs.find(
        (x) => isChanged(x) && x.data.path === rel && x.data.after.kind === 'content' && x.data.after.sha256 === digest,
      );
      const start = t0.get(rel);
      if (rec && start !== undefined) latencies.push(Date.parse(rec.time) - start);
    }
  });
  return latencies;
}

interface LossScenario {
  name: string;
  awkward: string;
  run: (root: string) => Promise<TraceStep[]>;
  /**
   * Paths this scenario creates as filesystem artifacts of the technique under
   * test (e.g. an atomic save's write-temp file) rather than as user-intended
   * changes. Records for these paths are excluded from loss scoring: the
   * scenario grades fidelity at the real target path, per its contract.
   */
  ignore?: string[];
}

const content = (body: Buffer | string): ObservedState => ({ kind: 'content', sha256: sha(body) });
const absent: ObservedState = { kind: 'absent' };

const lossScenarios: LossScenario[] = [
  {
    name: 'rapid-writes',
    awkward: 'rapid successive writes to one path',
    run: async (root) => {
      const rel = 'rapid.ts';
      const steps: TraceStep[] = [];
      for (let i = 0; i < 30; i++) {
        const body = `rapid-${i}`;
        await writeFile(join(root, rel), body);
        steps.push({ path: rel, state: content(body) });
      }
      return steps;
    },
  },
  {
    name: 'cycle-aba',
    awkward: 'A -> B -> A must be two transitions, not deduped',
    run: async (root) => {
      const rel = 'cycle.ts';
      const steps: TraceStep[] = [];
      for (const body of ['A', 'B', 'A', 'B', 'A']) {
        await writeFile(join(root, rel), body);
        steps.push({ path: rel, state: content(body) });
        await sleep(60); // give the watcher a chance to observe each endpoint
      }
      return steps;
    },
  },
  {
    name: 'atomic-save',
    awkward: 'atomic save (write-temp + rename) resolves at the final path',
    // The temp file is an artifact of the write-temp+rename technique, not a
    // user-intended change; grade only the final path.
    ignore: ['.atomic.ts.tmp'],
    run: async (root) => {
      const rel = 'atomic.ts';
      await writeFile(join(root, rel), 'original');
      const steps: TraceStep[] = [{ path: rel, state: content('original') }];
      await sleep(60);
      const tmp = join(root, '.atomic.ts.tmp');
      await writeFile(tmp, 'rewritten');
      await rename(tmp, join(root, rel));
      steps.push({ path: rel, state: content('rewritten') });
      return steps;
    },
  },
  {
    name: 'create-modify-delete',
    awkward: 'create, modify, then delete one file',
    run: async (root) => {
      const rel = 'life.ts';
      const steps: TraceStep[] = [];
      await writeFile(join(root, rel), 'born');
      steps.push({ path: rel, state: content('born') });
      await sleep(60);
      await writeFile(join(root, rel), 'grown');
      steps.push({ path: rel, state: content('grown') });
      await sleep(60);
      await rm(join(root, rel));
      steps.push({ path: rel, state: absent });
      return steps;
    },
  },
  {
    name: 'many-files',
    awkward: 'independent files change concurrently',
    run: async (root) => {
      const steps: TraceStep[] = [];
      for (let i = 0; i < 20; i++) {
        const rel = `many${i}.ts`;
        const body = `file-${i}`;
        await writeFile(join(root, rel), body);
        steps.push({ path: rel, state: content(body) });
      }
      return steps;
    },
  },
];

async function runLoss(): Promise<void> {
  const trace: TraceStep[] = [];
  let raw: LoggedRecord[] = [];

  const root = await mkdtemp(join(tmpdir(), 'slip-bench-wt-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-bench-st-'));
  const session = await startCapture({ root, storeDir: store });
  try {
    for (const scenario of lossScenarios) {
      const steps = await scenario.run(root);
      trace.push(...steps);
      await sleep(150); // let the watcher settle between scenarios
    }
    // Let FSEvents finish delivering: require a sustained quiet window before
    // unsubscribing so a valid trailing event is not cut off.
    await waitForSettled(() => readBenchRecords(session.logPath));
    // stop() unsubscribes the watcher and drains in-flight engine work before
    // the log closes, so the log read afterward reflects every committed record.
    await session.stop();
    raw = await readBenchRecords(session.logPath);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }

  // Records for scenario artifact paths (e.g. atomic-save temp files) are not
  // graded: they are real observed states, but not user-intended changes the
  // trace claims to track. Excluding them keeps an observed temp write from
  // being miscounted as a phantom.
  const ignored = new Set(lossScenarios.flatMap((s) => s.ignore ?? []));

  // Snapshot is structurally an ObservedState (its extra `size` is ignored by
  // categorize), so the committed `after` maps straight onto the trace's state.
  const records: RecordState[] = raw
    .filter(isChanged)
    .filter((r) => !ignored.has(r.data.path))
    .map((r) => ({ path: r.data.path, after: r.data.after }));

  const report = categorize(trace, records);
  const gaps = raw.filter((r) => r.type === 'slipstream.capture.gap.v1').length;

  console.log('\n## 2. Loss by category (against a known write trace)\n');
  console.log(`Trace steps written: ${trace.length}   file.changed committed: ${records.length}   capture.gap: ${gaps}\n`);
  console.log('| Category | Count | Severity |');
  console.log('|---|---|---|');
  console.log(`| Burst-within-file | ${report.burstWithinFile} | Mild (endpoint captured) |`);
  console.log(`| Whole-change-lost | ${report.wholeChangeLost} | Severe |`);
  console.log(`| Endpoint-wrong | ${report.endpointWrong} | Fatal |`);
  console.log(`| Ordering-wrong | ${report.orderingWrong} | Severe |`);
  console.log(`| Phantom | ${report.phantom} | Severe |`);

  console.log('\n## 3. Per-scenario awkward cases\n');
  for (const s of lossScenarios) console.log(`- ${s.name}: ${s.awkward}`);
}

async function runLatency(): Promise<void> {
  console.log('# Stage 1 measurements\n');
  console.log('## 1. Latency (write -> observed record time), milliseconds\n');
  console.log('| Scenario | n | p50 | p99 |');
  console.log('|---|---|---|---|');
  const single = stats(await latencySingleFile(64, 50));
  console.log(`| single small file | ${single.n} | ${single.p50} | ${single.p99} |`);
  const big = stats(await latencySingleFile(1024 * 1024, 30));
  console.log(`| 1 MiB file | ${big.n} | ${big.p50} | ${big.p99} |`);
  const burst = stats(await latencyBurst(100));
  console.log(`| burst of 100 files | ${burst.n} | ${burst.p50} | ${burst.p99} |`);
}

async function main(): Promise<void> {
  await runLatency();
  await runLoss();
  console.log('');
}

const SETTLE_QUIET_MS = 500;
const SETTLE_POLL_MS = 100;

export async function waitForSettled(
  read: () => Promise<unknown[]>,
  wait: (ms: number) => Promise<void> = sleep,
  now: () => number = Date.now,
): Promise<void> {
  let previousLength = -1;
  let lastChange = now();
  while (now() - lastChange < SETTLE_QUIET_MS) {
    const records = await read();
    if (records.length !== previousLength) {
      previousLength = records.length;
      lastChange = now();
    }
    await wait(SETTLE_POLL_MS);
  }
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) {
  await main();
}
