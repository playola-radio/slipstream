/**
 * Auto-capture overhead bench (P1). Generates synthetic git worktrees and
 * transcript homes in a temp directory, runs every scenario against a forked
 * subject process (subject.ts), samples it with `top` (no sudo), and writes raw
 * results plus a gate summary. Temp worktrees and stores are always deleted.
 *
 *   npm run bench:autocapture -- [--out <dir>] [--idle-seconds 600]
 *     [--diag-idle-seconds 120] [--baseline-reps 10] [--captures 16] [--phases gated,diag,baseline,latency,install]
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
import { coveredFraction, evaluateGate, joinLatencies, latencyStats, latencyVerdict, parseTopLog, settledVerdict, summarizeTop, type GateVerdict, type TopSample } from './analysis.ts';
import { isMetadataOp } from './probe-model.ts';
import { createRng, layoutPaths, sampleFileSize, sampleWorktreeFileCounts } from './plan.ts';
import type { Request, Snapshot } from './subject.ts';

const GENERATOR_VERSION = 1;
const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MiB = 2 ** 20;

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(REPO, 'docs', 'autocapture', 'raw') },
    'idle-seconds': { type: 'string', default: '600' },
    'diag-idle-seconds': { type: 'string', default: '120' },
    'baseline-reps': { type: 'string', default: '10' },
    'latency-seconds': { type: 'string', default: '120' },
    phases: { type: 'string', default: 'gated,diag,baseline,latency,install' },
    seed: { type: 'string', default: '20261017' },
    captures: { type: 'string', default: '16' },
  },
});
function positiveInt(name: keyof typeof args): number {
  const v = Number(args[name]);
  if (!Number.isInteger(v) || v < 1) throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(args[name])}`);
  return v;
}
const IDLE_S = positiveInt('idle-seconds');
const DIAG_IDLE_S = positiveInt('diag-idle-seconds');
const BASELINE_REPS = positiveInt('baseline-reps');
const LATENCY_S = positiveInt('latency-seconds');
const PHASES = new Set(args.phases!.split(','));
const SEED = positiveInt('seed');
const N = positiveInt('captures');
/** Recordings beyond the cap of 16, reported as headroom only. */
const HEADROOM_N = 32;
const POOL = PHASES.has('diag') ? Math.max(HEADROOM_N, N) : N;

function log(msg: string): void {
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ---------------------------------------------------------------- children

/** Every child the bench starts, so a stop can kill and await all of them
 * before the temp dir goes. Once stopping, nothing new starts. */
const liveChildren = new Set<ChildProcess>();
let stopping = false;

/** Call checkStopping() before creating the child, so a stop never abandons a
 * child's promise. */
function track(child: ChildProcess): ChildProcess {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

function run(cmd: string, argv: string[], opts: Parameters<typeof execFile>[2] = {}): Promise<{ stdout: string; stderr: string }> {
  checkStopping();
  const p = execFileP(cmd, argv, { ...opts, encoding: 'utf8' });
  track(p.child);
  return p;
}

function checkStopping(): void {
  if (stopping) throw new Error('bench is stopping');
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

async function generate(real: string): Promise<{ ws: Workspace; meta: Record<string, unknown> }> {
  const rng = createRng(SEED);
  const pool = Buffer.alloc(2 ** 26 + 4096);
  for (let i = 0; i < pool.length; i += 4) pool.writeUInt32LE(Math.floor(rng() * 2 ** 32), i);
  const counts = sampleWorktreeFileCounts(POOL, rng);
  const worktrees: string[] = [];
  let bytes = 0;
  const jobs: Promise<void>[] = [];
  for (const [i, count] of counts.entries()) {
    checkStopping();
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
  checkStopping();
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

/** Longest any single request may take: a cold 4,200-file baseline beside 16
 * captures has measured ~70 s, so this only catches a wedged subject. */
const CALL_TIMEOUT_MS = 15 * 60_000;

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
    child.once('exit', (code, signal) => {
      for (const settle of this.pending.values()) settle({ ok: false, error: `subject exited (${code ?? signal}) with a request pending` });
      this.pending.clear();
    });
  }

  static async start(ws: Workspace, storeDir: string): Promise<Subject> {
    checkStopping();
    const child = track(fork(join(REPO, 'tools', 'autocapture-bench', 'subject.ts'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('exit', (code) => reject(new Error(`subject exited early (${code})`)));
      });
      const s = new Subject(child, child.pid!);
      await s.call({ op: 'init', storeDir, roots: { worktrees: join(ws.tmp, 'worktrees'), store: ws.storesDir, transcripts: join(ws.tmp, 'homes') } });
      return s;
    } catch (err) {
      child.kill('SIGKILL');
      throw err;
    }
  }

  call<T = unknown>(req: Request): Promise<T> {
    const id = ++this.seq;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.reject(new Error(`subject already exited; cannot ${req.op}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`subject did not answer ${req.op} within ${CALL_TIMEOUT_MS / 60_000} min`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.ok) resolve(m.result as T); else reject(new Error(m.error));
      });
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
  checkStopping();
  const fd = openSync(file, 'w');
  const child = track(spawn('top', ['-l', String(seconds + 1), '-s', '1', '-n', '1000', '-pid', String(pid), '-stats', 'pid,cpu,th,mem,idlew'],
    { stdio: ['ignore', fd, 'inherit'] }));
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

/** One subject with N captures, the first `chats` carrying the emulated linked
 * chat. Several measurements run on the same set, so the fleet is started
 * once per configuration rather than once per measurement. */
interface Fleet {
  s: Subject; chats: number; store: string; storeAtStart: Awaited<ReturnType<typeof storeBytes>>;
  started: Started[]; failures: string[]; startupMs: ReturnType<typeof latencyStats>;
}

async function withFleet<T>(ws: Workspace, label: string, n: number, chats: number, body: (f: Fleet) => Promise<T>): Promise<T> {
  log(`fleet ${label}: N=${n}, emulated chats=${chats}`);
  const store = ws.store;
  const storeAtStart = await storeBytes(store);
  const s = await Subject.start(ws, store);
  try {
    const result = await body({ s, chats, store, storeAtStart, ...(await startFleet(s, ws, n, chats)) });
    await s.shutdown();
    return result;
  } finally {
    s.kill();
  }
}

async function startFleet(s: Subject, ws: Workspace, n: number, chats: number) {
  const { started, failures } = await startCaptures(s, ws, ws.worktrees.slice(0, n), chats);
  const startupMs = latencyStats(started.map((x) => x.ms));
  log(`  started ${started.length} (${failures.length} failed), startup p50 ${startupMs.p50?.toFixed(0)} ms`);
  return { started, failures, startupMs };
}

async function idle(f: Fleet, ws: Workspace, name: string, idleS: number) {
  const settled = await settle(f.s);
  log(`  ${name}: settled=${settled.settled} after ${settled.ms}ms, idle ${idleS}s`);
  const window = await measureWindow(f.s, idleS, name, ws, f.store);
  return { n: f.started.length, chats: f.chats, storeAtStart: f.storeAtStart, failures: f.failures, startupMs: f.startupMs, settle: settled, idle: window, log: await logStats(f.started) };
}

async function baselines(f: Fleet, ws: Workspace, name: string) {
  const settled = await settle(f.s);
  log(`  ${name}: ${BASELINE_REPS} cold+warm 4,200-file baselines beside ${f.started.length} captures`);
  const cold: number[] = [];
  const warm: number[] = [];
  await f.s.call({ op: 'eld', on: true });
  for (let i = 0; i < BASELINE_REPS; i++) {
    // Cold CAS: a store that has never held these bytes. Warm: the same store
    // again under a new session. OS page cache stays warm (purging needs sudo).
    const repStore = await freshStore(ws, `${name}-rep${i}`);
    for (const into of [cold, warm]) {
      const sessionId = randomUUID();
      const r = await f.s.call<{ ms: number }>({ op: 'start', root: ws.big, sessionId, storeDir: repStore });
      into.push(r.ms);
      await f.s.call({ op: 'stopSession', sessionId });
    }
    await rm(repStore, { recursive: true, force: true });
  }
  const eld = await f.s.call({ op: 'eld', on: false });
  return { chats: f.chats, settle: settled, coldMs: latencyStats(cold), warmMs: latencyStats(warm), cold, warm, eventLoopDelay: eld };
}

interface WriteRecord { sessionId: string; sha256: string; writtenNs: bigint }
interface BaselineLoopResult { runs: { root: string; ms: number; startNs: string; endNs: string }[]; error?: string }

/** One write every 200 ms, round-robin across the target captures, each a
 * unique payload so its change record can be found by hash. */
async function writeLoad(targets: Started[], seconds: number, arm: string): Promise<WriteRecord[]> {
  const out: WriteRecord[] = [];
  if (targets.length === 0) return out;
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

async function latency(f: Fleet, ws: Workspace, name: string) {
  const settled = await settle(f.s);
  const targets = f.started.slice(f.chats, f.chats + 8);
  log(`  ${name}: write latency on ${targets.length} of ${f.started.length} captures, with and without a concurrent baseline`);
  await f.s.call({ op: 'track', sessionIds: targets.map((t) => t.sessionId) });
  const arms: Record<string, { writes: WriteRecord[]; eld: unknown; baselines?: unknown }> = {};
  for (const arm of ['A1', 'B', 'A2']) {
    await f.s.call({ op: 'eld', on: true });
    if (arm === 'B') await f.s.call({ op: 'baselineLoop', roots: [ws.big, ...ws.worktrees.slice(N)] });
    const writes = await writeLoad(targets, LATENCY_S, arm);
    const loop = arm === 'B' ? await f.s.call<BaselineLoopResult>({ op: 'stopBaselineLoop' }) : undefined;
    if (loop?.error) log(`  ${name}: baseline loop stopped early: ${loop.error}`);
    arms[arm] = { writes, eld: await f.s.call({ op: 'eld', on: false }), ...(loop ? { baselines: loop } : {}) };
    await sleep(5_000);
  }
  const timeline = (await f.s.call<{ sessionId: string; seq: string; ns: string }[]>({ op: 'timeline' }))
    .map((t) => ({ sessionId: t.sessionId, seq: BigInt(t.seq), ns: BigInt(t.ns) }));
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
    return { writes: writes.length, missing: j.missing, latenciesMs: j.latenciesMs, all: latencyStats(j.latenciesMs), worstCaptureP99Ms: worstP99 };
  };
  const a = result([...arms.A1!.writes, ...arms.A2!.writes]);
  const b = result(arms.B!.writes);
  const loop = arms.B!.baselines as BaselineLoopResult;
  const intervals = loop.runs.map((r) => ({ startNs: BigInt(r.startNs), endNs: BigInt(r.endNs) }));
  return {
    chats: f.chats, settle: settled,
    armA: { ...a, eldA1: arms.A1!.eld, eldA2: arms.A2!.eld },
    armB: { ...b, eld: arms.B!.eld, baselines: loop.runs, baselineLoopError: loop.error ?? null,
      baselineCoverage: coveredFraction(arms.B!.writes.map((w) => w.writtenNs), intervals) },
    armA1: result(arms.A1!.writes), armA2: result(arms.A2!.writes),
    p99Regression: a.all.p99 && b.all.p99 ? b.all.p99 / a.all.p99 - 1 : null,
    worstCaptureP99Regression: a.worstCaptureP99Ms ? b.worstCaptureP99Ms / a.worstCaptureP99Ms - 1 : null,
  };
}

async function install(f: Fleet, ws: Workspace) {
  const settled = await settle(f.s);
  log(`  install: npm ci into an ignored node_modules inside one of ${f.started.length} watched worktrees`);
  const target = ws.worktrees[0]!;
  const before = await logStats(f.started);
  const window = await measureWindow(f.s, 240, 'install', ws, f.store, async () => {
    const t0 = Date.now();
    try {
      await run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, maxBuffer: 64 * MiB });
      return { method: 'npm ci --offline --ignore-scripts', ms: Date.now() - t0 };
    } catch (err) {
      checkStopping();
      // Offline cache incomplete: fall back to copying this repo's tree, and say so.
      await run('cp', ['-R', join(REPO, 'node_modules'), join(target, 'node_modules')]);
      return { method: `copy of repo node_modules (npm ci failed: ${(err as Error).message.split('\n')[0]})`, ms: Date.now() - t0 };
    }
  });
  const files = Number((await run('sh', ['-c', `find '${join(target, 'node_modules')}' -type f | wc -l`])).stdout.trim());
  const logAfter = await logStats(f.started);
  // Later fleets watch this worktree too; leave it as generated.
  await rm(join(target, 'node_modules'), { recursive: true, force: true });
  return { settle: settled, installedFiles: files, window, logBefore: before, logAfter };
}

// ---------------------------------------------------------------- gates

const seconds = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);

/** Downgrade rows measured after settle() gave up (see settledVerdict). */
function unsettled(rows: GateRow[], settle: { settled: boolean; ms: number }, costOnly: boolean): void {
  if (settle.settled) return;
  for (const row of rows) {
    const verdict = settledVerdict(row.verdict, { settled: false, costOnly });
    const why = `not settled after ${(settle.ms / 1000).toFixed(0)} s`;
    row.note = [row.note, verdict === row.verdict ? `${why}; a pass still holds` : `${why}; ${row.verdict} not trusted`].filter(Boolean).join('; ');
    row.verdict = verdict;
  }
}

interface GateRow { gate: string; scenario: string; threshold: string; measured: string; verdict: GateVerdict; note?: string }

function gates(results: Record<string, any>, fdSoftLimit: number): GateRow[] {
  const rows: GateRow[] = [];
  const pct = (x: number) => `${x.toFixed(2)}%`;
  for (const name of [`n${N}-c0`, `n${N}-c1`, `n${N}-c10`]) {
    const r = results[name];
    if (!r) continue;
    const i = r.idle;
    const firstRow = rows.length;
    rows.push({ gate: 'idle CPU mean', scenario: name, threshold: '<= 1%', measured: `${pct(i.top.cpuMeanPercent)} (process cpuUsage ${pct(i.processCpuMeanPercent)})`, verdict: evaluateGate({ threshold: 1, measured: Math.max(i.top.cpuMeanPercent, i.processCpuMeanPercent) }) });
    rows.push({ gate: 'idle CPU p95 of 1-s samples', scenario: name, threshold: '<= 3%', measured: pct(i.top.cpuP95Percent), verdict: evaluateGate({ threshold: 3, measured: i.top.cpuP95Percent }) });
    const lower = Math.max(i.top.idleWakeupsPerSecond, i.timerWakeupsPerSecond);
    rows.push({ gate: 'process wakeups/s', scenario: name, threshold: '<= 10/s', measured: `>= ${lower.toFixed(1)}/s (lower bound: top IDLEW ${i.top.idleWakeupsPerSecond.toFixed(1)}, main-thread timer wakeups ${i.timerWakeupsPerSecond.toFixed(1)}); upper bound unmeasured`, verdict: evaluateGate({ threshold: 10, lower, upper: Infinity }) });
    rows.push({ gate: 'physical footprint', scenario: name, threshold: '<= 512 MiB', measured: `${(i.top.maxMemBytes / MiB).toFixed(0)} MiB max`, verdict: evaluateGate({ threshold: 512 * MiB, measured: i.top.maxMemBytes }) });
    const wt = i.worktreeCalls as Record<string, number>;
    const reads = worktreeReads(wt) + i.spawns;
    const metadata = Object.values(wt).reduce((a, b) => a + b, 0) - worktreeReads(wt);
    rows.push({ gate: 'no recurring worktree enumeration/reads after settling', scenario: name, threshold: '0 calls', measured: `${reads} worktree listings/stats/reads + git spawns (plus ${metadata} path resolutions)`, verdict: evaluateGate({ threshold: 0, measured: reads }), note: 'main-thread JS scope; native watcher I/O untraced' });
    rows.push({ gate: 'FDs vs soft limit', scenario: name, threshold: `< 50% of ${fdSoftLimit}`, measured: `${i.fds}`, verdict: evaluateGate({ threshold: fdSoftLimit / 2 - 1, measured: i.fds }) });
    unsettled(rows.slice(firstRow), r.settle, true);
    // An observed failure is a fact whether or not the fleet settled.
    const failures = r.failures.length + (r.log.gapsByReason['watcher-error'] ?? 0) + i.compromised.length;
    rows.push({ gate: 'watcher subscription failures', scenario: name, threshold: '0', measured: String(failures), verdict: evaluateGate({ threshold: 0, measured: failures }) });
  }
  for (const name of ['baseline-c0', 'baseline-c10']) {
    const r = results[name];
    if (!r) continue;
    const firstRow = rows.length;
    rows.push({ gate: '4,200-file baseline p95, warm CAS', scenario: name, threshold: '<= 5 s', measured: `${seconds(r.warmMs.p95)} (n=${r.warmMs.n})`, verdict: evaluateGate({ threshold: 5000, measured: r.warmMs.p95 }) });
    rows.push({ gate: '4,200-file baseline p95, cold CAS', scenario: name, threshold: '<= 15 s', measured: `${seconds(r.coldMs.p95)} (n=${r.coldMs.n})`, verdict: evaluateGate({ threshold: 15000, measured: r.coldMs.p95 }) });
    unsettled(rows.slice(firstRow), r.settle, true);
  }
  for (const name of ['latency-c0', 'latency-c10']) {
    const r = results[name];
    if (!r) continue;
    const m = r.p99Regression;
    const v = latencyVerdict({ a: r.armA, b: r.armB, coverage: r.armB.baselineCoverage });
    const row: GateRow = { gate: 'p99 latency regression while another baselines', scenario: name, threshold: '<= 20%',
      measured: `${m === null ? 'n/a' : `${(m * 100).toFixed(1)}% (p99 ${r.armA.all.p99?.toFixed(0)} -> ${r.armB.all.p99?.toFixed(0)} ms)`}; missing A ${r.armA.missing}/${r.armA.writes}, B ${r.armB.missing}/${r.armB.writes}; arm B under a baseline ${(r.armB.baselineCoverage * 100).toFixed(1)}%`,
      verdict: v.verdict, ...(v.note ? { note: v.note } : {}) };
    rows.push(row);
    unsettled([row], r.settle, false);
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
  // The temp dir and the stop handlers exist before generation, so a stop at any
  // point removes every synthetic byte.
  const tmp = execFileSync('realpath', [await mkdtemp(join(tmpdir(), 'slip-autocapture-'))]).toString().trim();
  let workload: Record<string, unknown> = {};
  const results: Record<string, unknown> = {};
  const order: string[] = [];
  const record = (name: string, value: unknown) => {
    results[name] = value;
    order.push(name);
    writeFileSync(join(out, 'results.json'), JSON.stringify({ startedAt, generatorVersion: GENERATOR_VERSION, seed: SEED, args, host, workload, order, results }, null, 2));
  };
  const cleanup = () => rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  const killChildren = () => Promise.all([...liveChildren].map((c) => {
    if (c.exitCode !== null || c.signalCode !== null) return undefined;
    const exited = new Promise((r) => c.once('exit', r));
    c.kill('SIGKILL');
    return exited;
  }));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      stopping = true;
      void killChildren().then(cleanup).then(() => process.exit(130));
    });
  }
  try {
    log(`generating synthetic worktrees (pool ${POOL}) in ${tmp}`);
    const { ws, meta } = await generate(tmp);
    workload = meta;
    for (const c of [0, 1, 10]) {
      const steps = {
        idle: PHASES.has('gated'),
        baseline: c !== 1 && PHASES.has('baseline'),
        latency: c !== 1 && PHASES.has('latency'),
        install: c === 0 && PHASES.has('install'),
      };
      if (!Object.values(steps).some(Boolean)) continue;
      await withFleet(ws, `n${N}-c${c}`, N, c, async (f) => {
        if (steps.idle) record(`n${N}-c${c}`, await idle(f, ws, `n${N}-c${c}`, IDLE_S));
        if (steps.baseline) record(`baseline-c${c}`, await baselines(f, ws, `baseline-c${c}`));
        if (steps.latency) record(`latency-c${c}`, await latency(f, ws, `latency-c${c}`));
        if (steps.install) record('install', await install(f, ws));
      });
    }
    if (PHASES.has('diag')) {
      for (const n of [0, 1, HEADROOM_N]) {
        await withFleet(ws, `n${n}-c0`, n, 0, async (f) => record(`n${n}-c0`, await idle(f, ws, `n${n}-c0`, DIAG_IDLE_S)));
      }
    }
  } finally {
    stopping = true;
    await killChildren();
    await cleanup();
    log(`removed ${tmp}`);
  }
  const rows = gates(results, host.fdSoftLimit);
  const table = ['| Gate | Scenario | Threshold | Measured | Verdict |', '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.gate}${r.note ? ` (${r.note})` : ''} | ${r.scenario} | ${r.threshold} | ${r.measured} | ${r.verdict} |`)].join('\n');
  writeFileSync(join(out, 'gates.md'), `${table}\n`);
  writeFileSync(join(out, 'results.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), generatorVersion: GENERATOR_VERSION, seed: SEED, args, host: { ...host, loadAvgEnd: loadavg() }, workload, order, results, gates: rows }, null, 2));
  console.log(table);
  log(`raw results: ${out}`);
}

await main();
