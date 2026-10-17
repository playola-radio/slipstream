/**
 * Auto-capture overhead bench (P1). Generates synthetic git worktrees and
 * transcript homes in a temp directory, runs every scenario against a forked
 * subject process (subject.ts), samples it with `top` (no sudo), and writes raw
 * results plus a gate summary. Temp worktrees and stores are always deleted.
 *
 *   npm run bench:autocapture -- [--out <dir>] [--idle-seconds 600]
 *     [--diag-idle-seconds 120] [--baseline-reps 30] [--phases gated,diag,baseline,latency,install]
 */
import { execFile, execFileSync, fork, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { DEFAULT_ENRICHMENT_POLICY } from '../../src/attribution-producer.ts';
import { DEFAULT_CODEX_SCAN_LIMIT } from '../../src/config.ts';
import { claudeSlug } from '../../src/transcript/discovery.ts';
import { evaluateGate, joinLatencies, latencyStats, parseTopLog, summarizeTop, type GateVerdict, type TopSample } from './analysis.ts';
import { isMetadataOp } from './probe-model.ts';
import { createRng, layoutPaths, sampleFileSize, sampleWorktreeFileCounts } from './plan.ts';
import type { Request, Snapshot } from './subject.ts';

const GENERATOR_VERSION = 1;
const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MiB = 2 ** 20;

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(REPO, 'docs', 'autocapture', 'raw') },
    'idle-seconds': { type: 'string', default: '600' },
    'diag-idle-seconds': { type: 'string', default: '120' },
    'baseline-reps': { type: 'string', default: '30' },
    'latency-seconds': { type: 'string', default: '120' },
    phases: { type: 'string', default: 'gated,diag,baseline,latency,install' },
    seed: { type: 'string', default: '20261017' },
    captures: { type: 'string', default: '57' },
  },
});
const IDLE_S = Number(args['idle-seconds']);
const DIAG_IDLE_S = Number(args['diag-idle-seconds']);
const BASELINE_REPS = Number(args['baseline-reps']);
const LATENCY_S = Number(args['latency-seconds']);
const PHASES = new Set(args.phases!.split(','));
const SEED = Number(args.seed);
const N = Number(args.captures);
const POOL = PHASES.has('diag') ? Math.max(136, N) : N;

function log(msg: string): void {
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ---------------------------------------------------------------- generation

interface Workspace { tmp: string; worktrees: string[]; big: string; homes: { claude: string; codex: string }; storesDir: string; store: string }

async function gitCommit(dir: string): Promise<void> {
  const git = ['-c', 'core.compression=0', '-c', 'gc.auto=0', '-c', 'core.fsmonitor=false', '-C', dir];
  await run('git', ['init', '-q', dir]);
  await run('git', [...git, 'add', '-A'], { maxBuffer: 64 * MiB });
  await run('git', [...git, '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-q', '-m', 'synthetic'],
    { maxBuffer: 64 * MiB });
}

/** Distinct bytes per file (a unique header plus a slice of one seeded random
 * buffer), so CAS dedup never makes a cold baseline look warm. */
function writeWorktree(dir: string, fileCount: number, rng: () => number, pool: Buffer): number {
  let bytes = 0;
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  for (const rel of layoutPaths(fileCount)) {
    const size = sampleFileSize(rng);
    const header = Buffer.from(`${dir}/${rel}\n`);
    const offset = Math.floor(rng() * (pool.length - size));
    const body = size <= header.length ? header.subarray(0, size)
      : Buffer.concat([header, pool.subarray(offset, offset + size - header.length)]);
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
    bytes += size;
  }
  return bytes;
}

async function generate(): Promise<{ ws: Workspace; meta: Record<string, unknown> }> {
  const tmp = await mkdtemp(join(tmpdir(), 'slip-autocapture-'));
  const real = execFileSync('realpath', [tmp]).toString().trim();
  const rng = createRng(SEED);
  const pool = Buffer.alloc(2 ** 26 + 4096);
  for (let i = 0; i < pool.length; i += 4) pool.writeUInt32LE(Math.floor(rng() * 2 ** 32), i);
  const counts = sampleWorktreeFileCounts(POOL, rng);
  const worktrees: string[] = [];
  let bytes = 0;
  const jobs: Promise<void>[] = [];
  for (const [i, count] of counts.entries()) {
    const dir = join(real, 'worktrees', `w${String(i).padStart(3, '0')}`);
    mkdirSync(dir, { recursive: true });
    bytes += writeWorktree(dir, count, rng, pool);
    if (i === 0) for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(REPO, f), join(dir, f));
    worktrees.push(dir);
    jobs.push(gitCommit(dir));
    if (jobs.length >= 6) await Promise.all(jobs.splice(0));
  }
  const big = join(real, 'worktrees', 'big4200');
  mkdirSync(big, { recursive: true });
  bytes += writeWorktree(big, 4200, rng, pool);
  jobs.push(gitCommit(big));
  await Promise.all(jobs);

  // Synthetic Codex home sized like the real one (3,498 rollouts on 2026-10-17):
  // every rollout belongs to some other cwd, so discovery scans them all and binds none.
  const codex = join(real, 'homes', 'codex');
  for (let i = 0; i < 3500; i++) {
    const day = join(codex, 'sessions', '2026', String(1 + (i % 10)).padStart(2, '0'), String(1 + (i % 28)).padStart(2, '0'));
    mkdirSync(day, { recursive: true });
    const meta = { type: 'session_meta', timestamp: '2026-10-01T00:00:00.000Z', payload: { id: `synthetic-${i}`, cwd: `/nonexistent/project-${i % 40}`, originator: 'codex-cli' } };
    const item = { type: 'response_item', timestamp: '2026-10-01T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(400) }] } };
    writeFileSync(join(day, `rollout-${i}.jsonl`), `${JSON.stringify(meta)}\n${JSON.stringify(item)}\n`);
  }
  const claude = join(real, 'homes', 'claude');
  for (const root of [...worktrees, big]) {
    const dir = join(claude, 'projects', claudeSlug(root));
    mkdirSync(dir, { recursive: true });
    const sessionId = randomUUID();
    const rec = { type: 'user', sessionId, cwd: root, uuid: randomUUID(), timestamp: '2026-10-17T00:00:00.000Z', message: { role: 'user', content: 'hello' } };
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(rec)}\n`);
  }
  const storesDir = join(real, 'stores');
  await mkdir(storesDir, { mode: 0o700 });
  // One store for every scenario, as one daemon would have: the first scenario's
  // captures meet a cold CAS, later ones a warm one. Growth is measured per window.
  const store = join(storesDir, 'main');
  await mkdir(store, { mode: 0o700 });
  return {
    ws: { tmp: real, worktrees, big, homes: { claude, codex }, storesDir, store },
    meta: { worktreeFileCounts: counts, bigFileCount: 4200, syntheticBytes: bytes, codexRollouts: 3500 },
  };
}

// ---------------------------------------------------------------- subject

class Subject {
  private seq = 0;
  private pending = new Map<number, (m: { ok: boolean; result?: unknown; error?: string }) => void>();
  private readonly child: ChildProcess;
  readonly pid: number;
  private constructor(child: ChildProcess, pid: number) {
    this.child = child;
    this.pid = pid;
    child.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      this.pending.get(m.id)?.(m);
      this.pending.delete(m.id);
    });
  }

  static async start(ws: Workspace, storeDir: string): Promise<Subject> {
    const child = fork(join(REPO, 'tools', 'autocapture-bench', 'subject.ts'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('exit', (code) => reject(new Error(`subject exited early (${code})`)));
    });
    const s = new Subject(child, child.pid!);
    await s.call({ op: 'init', storeDir, roots: { worktrees: join(ws.tmp, 'worktrees'), store: storeDir, transcripts: join(ws.tmp, 'homes') } });
    return s;
  }

  call<T = unknown>(req: Request): Promise<T> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.ok ? resolve(m.result as T) : reject(new Error(m.error))));
      this.child.send({ id, req });
    });
  }

  snapshot(): Promise<Snapshot> { return this.call<Snapshot>({ op: 'snapshot' }); }

  kill(): void {
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }

  async shutdown(): Promise<void> {
    const exited = new Promise((r) => this.child.once('exit', r));
    await this.call({ op: 'shutdown' });
    await exited;
  }
}

async function freshStore(ws: Workspace, name: string): Promise<string> {
  const dir = join(ws.storesDir, name);
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

function chatRuntime(ws: Workspace): Pick<Extract<Request, { op: 'start' }>, 'transcript' | 'enrichmentPolicy'> {
  return {
    transcript: { harnesses: ['claude-code', 'codex'], homes: { 'claude-code': ws.homes.claude, codex: ws.homes.codex }, codexScanLimit: DEFAULT_CODEX_SCAN_LIMIT },
    enrichmentPolicy: { ...DEFAULT_ENRICHMENT_POLICY, sources: { 'claude-code': 'configured', codex: 'configured' } },
  };
}

interface Started { sessionId: string; root: string; logPath: string; ms: number }

/** Start captures one at a time (the spec's admission concurrency); the first
 * `chats` carry the emulated linked-chat transcript runtime. */
async function startCaptures(s: Subject, ws: Workspace, roots: string[], chats: number): Promise<{ started: Started[]; failures: string[] }> {
  const started: Started[] = [];
  const failures: string[] = [];
  for (const [i, root] of roots.entries()) {
    const sessionId = randomUUID();
    try {
      const r = await s.call<{ ms: number; logPath: string }>({ op: 'start', root, sessionId, ...(i < chats ? chatRuntime(ws) : {}) });
      started.push({ sessionId, root, ...r });
    } catch (err) {
      failures.push(`${root}: ${(err as Error).message}`);
    }
  }
  return { started, failures };
}

/** Worktree enumeration and reads, leaving out path resolution (see isMetadataOp). */
function worktreeReads(ops: Record<string, number>): number {
  return Object.entries(ops).reduce((n, [op, k]) => (isMetadataOp(op) ? n : n + k), 0);
}

/** Settled = durable seqs, worktree reads and git spawns unchanged for 10 s, at
 * least 30 s after the last capture started. Bounded at 5 min. */
async function settle(s: Subject): Promise<{ settled: boolean; ms: number }> {
  const t0 = Date.now();
  await sleep(30_000);
  const sig = (x: Snapshot) => `${x.durableSeqTotal}/${worktreeReads(x.counters.calls.worktree)}/${x.counters.spawns}`;
  let prev = sig(await s.snapshot());
  let quietSince = Date.now();
  while (Date.now() - t0 < 300_000) {
    await sleep(5_000);
    const cur = sig(await s.snapshot());
    if (cur !== prev) { prev = cur; quietSince = Date.now(); continue; }
    if (Date.now() - quietSince >= 10_000) return { settled: true, ms: Date.now() - t0 };
  }
  return { settled: false, ms: Date.now() - t0 };
}

async function sampleTop(pid: number, seconds: number, file: string): Promise<TopSample[]> {
  const fd = openSync(file, 'w');
  const child = spawn('top', ['-l', String(seconds + 1), '-s', '1', '-n', '1000', '-pid', String(pid), '-stats', 'pid,cpu,th,mem,idlew,csw'],
    { stdio: ['ignore', fd, 'inherit'] });
  await new Promise((r) => child.once('exit', r));
  closeSync(fd);
  return parseTopLog(await readFile(file, 'utf8'), pid);
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await dirBytes(p) : (await lstat(p)).size;
  }
  return total;
}

async function storeBytes(store: string) {
  return { logs: await dirBytes(join(store, 'sessions')), blobs: await dirBytes(join(store, 'blobs')) };
}

interface LogEvent { type: string; seq: string; data: Record<string, unknown> }

async function readEvents(logPath: string): Promise<LogEvent[]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEvent);
}

async function logStats(started: Started[]) {
  const byType: Record<string, number> = {};
  const gapsByReason: Record<string, number> = {};
  let ignoredPathChanges = 0;
  for (const st of started) {
    for (const e of await readEvents(st.logPath)) {
      const type = e.type.replace(/^slipstream\./, '');
      byType[type] = (byType[type] ?? 0) + 1;
      if (type === 'capture.gap.v1') gapsByReason[String(e.data.reason)] = (gapsByReason[String(e.data.reason)] ?? 0) + 1;
      if (type === 'file.changed.v1' && String(e.data.path).startsWith('node_modules/')) ignoredPathChanges++;
    }
  }
  return { byType, gapsByReason, ignoredPathChanges };
}

function fsyncs(c: Snapshot['counters']): number {
  let n = 0;
  for (const ops of Object.values(c.calls)) for (const [op, k] of Object.entries(ops)) if (/(^|\.)(f?sync|f?datasync)(Sync)?$/.test(op)) n += k;
  return n;
}

/** One measured window: counters reset at the start, top sampling throughout,
 * a snapshot at each edge. Nothing else talks to the subject in between. */
async function measureWindow(s: Subject, seconds: number, label: string, ws: Workspace, store: string, during?: () => Promise<unknown>) {
  const storeBefore = await storeBytes(store);
  await s.call({ op: 'reset' });
  const a = await s.snapshot();
  const topFile = join(ws.tmp, `top-${label}.txt`);
  const topRun = sampleTop(s.pid, seconds, topFile);
  const duringResult = during ? await during() : undefined;
  const samples = await topRun;
  const b = await s.snapshot();
  const wallS = Number(BigInt(b.hrtimeNs) - BigInt(a.hrtimeNs)) / 1e9;
  const cpuS = (b.cpu.user + b.cpu.system - a.cpu.user - a.cpu.system) / 1e6;
  const lockOps = b.counters.calls.lock;
  return {
    seconds: wallS,
    top: summarizeTop(samples, 1),
    topSamples: samples.map((x) => [x.cpuPercent, x.memBytes]),
    processCpuMeanPercent: (cpuS / wallS) * 100,
    timerWakeupsPerSecond: b.counters.timerWakeups / wallS,
    timerCallbacksPerSecond: b.counters.timerCallbacks / wallS,
    lockHeartbeatsPerSecond: ((lockOps.readFile ?? 0)) / wallS,
    lockUtimesPerSecond: ((lockOps.utimes ?? 0)) / wallS,
    worktreeCalls: b.counters.calls.worktree,
    transcriptCallsPerSecond: Object.fromEntries(Object.entries(b.counters.calls.transcript).map(([k, v]) => [k, v / wallS])),
    storeCalls: b.counters.calls.store,
    spawns: b.counters.spawns,
    fsyncs: fsyncs(b.counters),
    bytesRead: b.counters.bytesRead,
    bytesWritten: b.counters.bytesWritten,
    blockOps: { in: b.resource.fsRead - a.resource.fsRead, out: b.resource.fsWrite - a.resource.fsWrite },
    heapUsedBytes: b.memory.heapUsed,
    rssBytes: b.memory.rss,
    fds: b.fds,
    health: b.health,
    compromised: b.compromised,
    storeGrowth: { before: storeBefore, after: await storeBytes(store) },
    during: duringResult,
  };
}

// ---------------------------------------------------------------- scenarios

async function idleScenario(ws: Workspace, name: string, n: number, chats: number, idleS: number) {
  log(`scenario ${name}: N=${n}, emulated chats=${chats}, idle ${idleS}s`);
  const store = ws.store;
  const storeAtStart = await storeBytes(store);
  const s = await Subject.start(ws, store);
  try {
    const { started, failures } = await startCaptures(s, ws, ws.worktrees.slice(0, n), chats);
    const startup = latencyStats(started.map((x) => x.ms));
    const settled = await settle(s);
    log(`  started ${started.length} (${failures.length} failed), settled=${settled.settled} after ${settled.ms}ms`);
    const idle = await measureWindow(s, idleS, name, ws, store);
    await s.shutdown();
    return { n, chats, storeAtStart, failures, startupMs: startup, settle: settled, idle, log: await logStats(started) };
  } finally {
    s.kill();
  }
}

async function baselineScenario(ws: Workspace, chats: number) {
  const name = `baseline-c${chats}`;
  log(`scenario ${name}: ${BASELINE_REPS} cold+warm 4,200-file baselines beside ${N} captures`);
  const store = ws.store;
  const storeAtStart = await storeBytes(store);
  const s = await Subject.start(ws, store);
  try {
    const { started, failures } = await startCaptures(s, ws, ws.worktrees.slice(0, N), chats);
    const settled = await settle(s);
    const cold: number[] = [];
    const warm: number[] = [];
    await s.call({ op: 'eld', on: true });
    for (let i = 0; i < BASELINE_REPS; i++) {
      // Cold CAS: a store that has never held these bytes. Warm: the same store
      // again under a new session. OS page cache stays warm (purging needs sudo).
      const repStore = await freshStore(ws, `${name}-rep${i}`);
      for (const into of [cold, warm]) {
        const sessionId = randomUUID();
        const r = await s.call<{ ms: number }>({ op: 'start', root: ws.big, sessionId, storeDir: repStore });
        into.push(r.ms);
        await s.call({ op: 'stopSession', sessionId });
      }
      await rm(repStore, { recursive: true, force: true });
    }
    const eld = await s.call({ op: 'eld', on: false });
    await s.shutdown();
    return { chats, storeAtStart, failures, settle: settled, coldMs: latencyStats(cold), warmMs: latencyStats(warm), cold, warm, eventLoopDelay: eld, log: await logStats(started) };
  } finally {
    s.kill();
  }
}

interface WriteRecord { sessionId: string; sha256: string; writtenNs: bigint }

/** One write every 200 ms, round-robin across the target captures, each a
 * unique payload so its change record can be found by hash. */
async function writeLoad(targets: Started[], seconds: number, arm: string): Promise<WriteRecord[]> {
  const out: WriteRecord[] = [];
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < seconds * 1000; i++) {
    const t = targets[i % targets.length]!;
    const content = `latency probe ${arm} ${i} ${randomUUID()}\n`;
    writeFileSync(join(t.root, 'src', 'g0', 'd0', 'f0.txt'), content);
    out.push({ sessionId: t.sessionId, sha256: createHash('sha256').update(content).digest('hex'), writtenNs: process.hrtime.bigint() });
    await sleep(Math.max(0, t0 + (i + 1) * 200 - Date.now()));
  }
  return out;
}

async function latencyScenario(ws: Workspace, chats: number) {
  const name = `latency-c${chats}`;
  log(`scenario ${name}: write latency on 8 of ${N} captures, with and without a concurrent baseline`);
  const store = ws.store;
  const storeAtStart = await storeBytes(store);
  const s = await Subject.start(ws, store);
  try {
    const { started, failures } = await startCaptures(s, ws, ws.worktrees.slice(0, N), chats);
    const settled = await settle(s);
    const targets = started.slice(chats, chats + 8);
    await s.call({ op: 'track', sessionIds: targets.map((t) => t.sessionId) });
    const arms: Record<string, { writes: WriteRecord[]; eld: unknown; baselines?: unknown }> = {};
    for (const arm of ['A1', 'B', 'A2']) {
      await s.call({ op: 'eld', on: true });
      if (arm === 'B') await s.call({ op: 'baselineLoop', roots: [ws.big, ...ws.worktrees.slice(N)] });
      const writes = await writeLoad(targets, LATENCY_S, arm);
      const baselines = arm === 'B' ? await s.call({ op: 'stopBaselineLoop' }) : undefined;
      arms[arm] = { writes, eld: await s.call({ op: 'eld', on: false }), ...(baselines ? { baselines } : {}) };
      await sleep(5_000);
    }
    const timeline = (await s.call<{ sessionId: string; seq: string; ns: string }[]>({ op: 'timeline' }))
      .map((t) => ({ sessionId: t.sessionId, seq: BigInt(t.seq), ns: BigInt(t.ns) }));
    await s.shutdown();
    const changes: { sessionId: string; seq: bigint; sha256: string }[] = [];
    for (const t of targets) {
      for (const e of await readEvents(t.logPath)) {
        const after = e.data.after as { kind?: string; sha256?: string } | undefined;
        if (e.type === 'slipstream.file.changed.v1' && after?.kind === 'content') changes.push({ sessionId: t.sessionId, seq: BigInt(e.seq), sha256: after.sha256! });
      }
    }
    const result = (writes: WriteRecord[]) => {
      const j = joinLatencies({ writes, changes, timeline });
      const worstP99 = Math.max(...Object.values(j.perSessionMs).map((v) => latencyStats(v).p99 ?? 0));
      return { writes: writes.length, missing: j.missing, all: latencyStats(j.latenciesMs), worstCaptureP99Ms: worstP99 };
    };
    const a = result([...arms.A1!.writes, ...arms.A2!.writes]);
    const b = result(arms.B!.writes);
    const baselineRuns = arms.B!.baselines as { root: string; ms: number }[];
    return {
      chats, storeAtStart, failures, settle: settled,
      armA: { ...a, eldA1: arms.A1!.eld, eldA2: arms.A2!.eld },
      armB: { ...b, eld: arms.B!.eld, baselines: baselineRuns,
        baselineCoverage: baselineRuns.reduce((x, r) => x + r.ms, 0) / (LATENCY_S * 1000) },
      armA1: result(arms.A1!.writes), armA2: result(arms.A2!.writes),
      p99Regression: a.all.p99 && b.all.p99 ? b.all.p99 / a.all.p99 - 1 : null,
      worstCaptureP99Regression: a.worstCaptureP99Ms ? b.worstCaptureP99Ms / a.worstCaptureP99Ms - 1 : null,
    };
  } finally {
    s.kill();
  }
}

async function installScenario(ws: Workspace) {
  log(`scenario install: npm ci into an ignored node_modules inside one of ${N} watched worktrees`);
  const store = ws.store;
  const storeAtStart = await storeBytes(store);
  const s = await Subject.start(ws, store);
  try {
    const { started, failures } = await startCaptures(s, ws, ws.worktrees.slice(0, N), 0);
    const settled = await settle(s);
    const target = ws.worktrees[0]!;
    const window = await measureWindow(s, 240, 'install', ws, store, async () => {
      const t0 = Date.now();
      try {
        await run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, maxBuffer: 64 * MiB });
        return { method: 'npm ci --offline --ignore-scripts', ms: Date.now() - t0 };
      } catch (err) {
        // Offline cache incomplete: fall back to copying this repo's tree, and say so.
        await run('cp', ['-R', join(REPO, 'node_modules'), join(target, 'node_modules')]);
        return { method: `copy of repo node_modules (npm ci failed: ${(err as Error).message.split('\n')[0]})`, ms: Date.now() - t0 };
      }
    });
    const files = Number((await run('sh', ['-c', `find '${join(target, 'node_modules')}' -type f | wc -l`])).stdout.trim());
    await s.shutdown();
    return { storeAtStart, failures, settle: settled, installedFiles: files, window, log: await logStats(started) };
  } finally {
    s.kill();
  }
}

// ---------------------------------------------------------------- gates

interface GateRow { gate: string; scenario: string; threshold: string; measured: string; verdict: GateVerdict; note?: string }

function gates(results: Record<string, any>, fdSoftLimit: number): GateRow[] {
  const rows: GateRow[] = [];
  const pct = (x: number) => `${x.toFixed(2)}%`;
  for (const name of [`n${N}-c0`, `n${N}-c1`, `n${N}-c10`]) {
    const r = results[name];
    if (!r) continue;
    const i = r.idle;
    rows.push({ gate: 'idle CPU mean', scenario: name, threshold: '<= 1%', measured: `${pct(i.top.cpuMeanPercent)} (process cpuUsage ${pct(i.processCpuMeanPercent)})`, verdict: evaluateGate({ threshold: 1, measured: Math.max(i.top.cpuMeanPercent, i.processCpuMeanPercent) }) });
    rows.push({ gate: 'idle CPU p95 of 1-s samples', scenario: name, threshold: '<= 3%', measured: pct(i.top.cpuP95Percent), verdict: evaluateGate({ threshold: 3, measured: i.top.cpuP95Percent }) });
    const lower = Math.max(i.top.idleWakeupsPerSecond, i.timerWakeupsPerSecond);
    rows.push({ gate: 'process wakeups/s', scenario: name, threshold: '<= 10/s', measured: `>= ${lower.toFixed(1)}/s (lower bound: top IDLEW ${i.top.idleWakeupsPerSecond.toFixed(1)}, main-thread timer wakeups ${i.timerWakeupsPerSecond.toFixed(1)}); upper bound unmeasured`, verdict: evaluateGate({ threshold: 10, lower, upper: Infinity }) });
    rows.push({ gate: 'physical footprint', scenario: name, threshold: '<= 512 MiB', measured: `${(i.top.maxMemBytes / MiB).toFixed(0)} MiB max`, verdict: evaluateGate({ threshold: 512 * MiB, measured: i.top.maxMemBytes }) });
    const wt = i.worktreeCalls as Record<string, number>;
    const reads = worktreeReads(wt) + i.spawns;
    const metadata = Object.values(wt).reduce((a, b) => a + b, 0) - worktreeReads(wt);
    rows.push({ gate: 'no recurring worktree enumeration/reads after settling', scenario: name, threshold: '0 calls', measured: `${reads} worktree listings/stats/reads + git spawns (plus ${metadata} path resolutions)`, verdict: evaluateGate({ threshold: 0, measured: reads }), note: 'main-thread JS scope; native watcher I/O untraced' });
    const failures = r.failures.length + (r.log.gapsByReason['watcher-error'] ?? 0) + i.compromised.length;
    rows.push({ gate: 'watcher subscription failures', scenario: name, threshold: '0', measured: String(failures), verdict: evaluateGate({ threshold: 0, measured: failures }) });
    rows.push({ gate: 'FDs vs soft limit', scenario: name, threshold: `< 50% of ${fdSoftLimit}`, measured: `${i.fds}`, verdict: evaluateGate({ threshold: fdSoftLimit / 2 - 1, measured: i.fds }) });
  }
  for (const name of ['baseline-c0', 'baseline-c10']) {
    const r = results[name];
    if (!r) continue;
    rows.push({ gate: '4,200-file baseline p95, warm CAS', scenario: name, threshold: '<= 5 s', measured: `${(r.warmMs.p95 / 1000).toFixed(2)} s (n=${r.warmMs.n})`, verdict: evaluateGate({ threshold: 5000, measured: r.warmMs.p95 }) });
    rows.push({ gate: '4,200-file baseline p95, cold CAS', scenario: name, threshold: '<= 15 s', measured: `${(r.coldMs.p95 / 1000).toFixed(2)} s (n=${r.coldMs.n})`, verdict: evaluateGate({ threshold: 15000, measured: r.coldMs.p95 }) });
  }
  for (const name of ['latency-c0', 'latency-c10']) {
    const r = results[name];
    if (!r) continue;
    const m = r.p99Regression;
    rows.push({ gate: 'p99 latency regression while another baselines', scenario: name, threshold: '<= 20%', measured: m === null ? 'n/a' : `${(m * 100).toFixed(1)}% (p99 ${r.armA.all.p99?.toFixed(0)} -> ${r.armB.all.p99?.toFixed(0)} ms)`, verdict: m === null ? 'UNMEASURED' : evaluateGate({ threshold: 0.2, measured: m }) });
  }
  return rows;
}

// ---------------------------------------------------------------- main

async function sh(cmd: string): Promise<string> {
  try { return (await run('sh', ['-c', cmd])).stdout.trim(); } catch (err) { return `unavailable: ${(err as Error).message.split('\n')[0]}`; }
}

async function machine() {
  return {
    cpu: await sh('sysctl -n machdep.cpu.brand_string'), cores: cpus().length, memBytes: totalmem(),
    os: await sh('sw_vers | tr "\\n" " "'), node: process.version, git: await sh('git --version'),
    commit: await sh(`git -C '${REPO}' rev-parse HEAD`),
    lockfileSha256: createHash('sha256').update(readFileSync(join(REPO, 'package-lock.json'))).digest('hex'),
    fdSoftLimit: Number(await sh('ulimit -Sn')),
    freeDisk: await sh(`df -h '${tmpdir()}' | tail -1`),
    power: await sh('pmset -g batt | head -1'), thermal: await sh('pmset -g therm | tr "\\n" " "'),
    loadAvgStart: loadavg(), memoryPressure: await sh('memory_pressure -Q 2>/dev/null | tail -1'),
    vmStat: await sh('top -l 1 -n 0 | grep PhysMem'),
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const out = join(args.out!, startedAt.slice(0, 10));
  await mkdir(out, { recursive: true });
  const host = await machine();
  log(`generating synthetic worktrees (pool ${POOL}) in ${tmpdir()}`);
  const { ws, meta } = await generate();
  const results: Record<string, unknown> = {};
  const order: string[] = [];
  const record = (name: string, value: unknown) => {
    results[name] = value;
    order.push(name);
    writeFileSync(join(out, 'results.json'), JSON.stringify({ startedAt, generatorVersion: GENERATOR_VERSION, seed: SEED, args, host, workload: meta, order, results }, null, 2));
  };
  const cleanup = () => rm(ws.tmp, { recursive: true, force: true });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void cleanup().then(() => process.exit(130)); });
  try {
    if (PHASES.has('gated')) for (const c of [0, 1, 10]) record(`n${N}-c${c}`, await idleScenario(ws, `n${N}-c${c}`, N, c, IDLE_S));
    if (PHASES.has('baseline')) for (const c of [0, 10]) record(`baseline-c${c}`, await baselineScenario(ws, c));
    if (PHASES.has('latency')) for (const c of [0, 10]) record(`latency-c${c}`, await latencyScenario(ws, c));
    if (PHASES.has('install')) record('install', await installScenario(ws));
    if (PHASES.has('diag')) {
      for (const [n, c] of [[0, 0], [1, 0], [10, 0], [N, N], [136, 0], [136, 10]] as const) {
        const name = n === N && c === N ? `n${N}-enriched-all` : `n${n}-c${c}`;
        record(name, await idleScenario(ws, name, n, c, DIAG_IDLE_S));
      }
    }
  } finally {
    await cleanup();
    log(`removed ${ws.tmp}`);
  }
  const rows = gates(results, host.fdSoftLimit);
  const table = ['| Gate | Scenario | Threshold | Measured | Verdict |', '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.gate}${r.note ? ` (${r.note})` : ''} | ${r.scenario} | ${r.threshold} | ${r.measured} | ${r.verdict} |`)].join('\n');
  writeFileSync(join(out, 'gates.md'), `${table}\n`);
  writeFileSync(join(out, 'results.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), generatorVersion: GENERATOR_VERSION, seed: SEED, args, host: { ...host, loadAvgEnd: loadavg() }, workload: meta, order, results, gates: rows }, null, 2));
  console.log(table);
  log(`raw results: ${out}`);
}

await main();
