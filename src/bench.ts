/**
 * Stage 1 measurement harness. Produces the two numbers the gate requires:
 *
 *   1. Latency (p50/p99, write -> committed record) for a single small file, a
 *      1 MiB file, and a burst of 100 files.
 *   2. Loss by category against a known write trace, via src/loss.ts.
 *
 * This is not a unit test — filesystem timing is nondeterministic, so the
 * scenarios are run and reported, never asserted. The pure pieces (percentile,
 * snapshot mapping) are unit-tested in bench.test.ts. Run with `npm run bench`.
 */
import { mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { startCapture, type CaptureSession } from './session.ts';
import type { LoggedRecord } from './log.ts';
import type { Snapshot } from './snapshot.ts';
import { categorize, type ObservedState, type RecordState, type TraceStep } from './loss.ts';

/** Nearest-rank percentile over an ascending-sorted sample. NaN if empty. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[idx]!;
}

/** Collapse a Snapshot to the size-independent state the loss trace compares. */
export function snapshotToObserved(snap: Snapshot): ObservedState {
  if (snap.kind === 'content') return { kind: 'content', sha256: snap.sha256 };
  if (snap.kind === 'unavailable') return { kind: 'unavailable', reason: snap.reason };
  return { kind: 'absent' };
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readRecords(logPath: string): Promise<LoggedRecord[]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LoggedRecord);
}

async function waitFor(
  logPath: string,
  predicate: (recs: LoggedRecord[]) => boolean,
  timeoutMs = 15000,
): Promise<LoggedRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recs = await readRecords(logPath);
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
        r.some((x) => x.type === 'file.changed' && x.after.kind === 'content' && x.after.sha256 === digest),
      );
      const rec = recs.find((x) => x.type === 'file.changed' && x.after.kind === 'content' && x.after.sha256 === digest);
      if (rec) latencies.push(rec.committed_at_ms - t0);
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
          .filter((x) => x.type === 'file.changed' && x.after.kind === 'content')
          .map((x) => x.path),
      );
      return [...expected.keys()].every((p) => seen.has(p));
    });
    for (const [rel, digest] of expected) {
      const rec = recs.find(
        (x) => x.type === 'file.changed' && x.path === rel && x.after.kind === 'content' && x.after.sha256 === digest,
      );
      const start = t0.get(rel);
      if (rec && start !== undefined) latencies.push(rec.committed_at_ms - start);
    }
  });
  return latencies;
}

interface LossScenario {
  name: string;
  awkward: string;
  run: (root: string) => Promise<TraceStep[]>;
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
  let records: RecordState[] = [];
  let raw: LoggedRecord[] = [];

  await withSession(async ({ root, session }) => {
    for (const scenario of lossScenarios) {
      const steps = await scenario.run(root);
      trace.push(...steps);
      await sleep(150); // let the watcher settle between scenarios
    }
    // Drain: wait until the log stops growing, then stop the session.
    let prev = -1;
    for (let i = 0; i < 50; i++) {
      const recs = await readRecords(session.logPath);
      if (recs.length === prev) break;
      prev = recs.length;
      await sleep(100);
    }
    raw = await readRecords(session.logPath);
  });

  records = raw
    .filter((r): r is Extract<LoggedRecord, { type: 'file.changed' }> => r.type === 'file.changed')
    .map((r) => ({ path: r.path, after: snapshotToObserved(r.after) }));

  const report = categorize(trace, records);
  const gaps = raw.filter((r) => r.type === 'capture.gap').length;

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
  console.log('## 1. Latency (write -> committed record), milliseconds\n');
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

await main();
