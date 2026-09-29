/** Offline FD5 collector isolation. Never starts a daemon or changes reader limits. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, link, unlink, open, realpath, lstat, stat } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectionTraceCollector, type PhaseSummary } from './fd5-trace.ts';
import type { ProjectionTraceEvent, ProjectionTraceObserver } from '../src/projection-trace.ts';

const SOURCE_SHA256 = 'f705218aafc6d58982b111eeba46bba1ccb12b8f2c0d0a33431b05d43586cbb8';
const CLIP_CELLS = ['overhead-clip-2-on', 'overhead-clip-3-on'] as const;
const ALL_CELLS = [...CLIP_CELLS, 'overhead-interface-2-on', 'overhead-interface-3-on'];
const PHASE_COUNTS: Record<string, number> = {
  'clip:worker-startup': 1, 'clip:worker-roundtrip': 684, 'clip:cas-read': 1368,
  'clip:grammar-load': 684, 'clip:parse-compare': 684,
  'clip:serialization': 684, 'clip:http-completion': 684,
};
const MAX_RESULT_BYTES = 1_048_576;
const MAX_SOURCE_BYTES = 32 * 1_048_576;
const ITERATIONS_PER_ORDER = 10;
const MAX_ARM_NS = 10_000_000_000n;
const MAX_CHILD_MS = 25_000;
const TOOL_PATH = fileURLToPath(import.meta.url);
const COLLECTOR_PATH = fileURLToPath(new URL('./fd5-trace.ts', import.meta.url));
const TRACE_SOURCE_PATH = fileURLToPath(new URL('../src/projection-trace.ts', import.meta.url));
const CHILD_TOKEN_ENV = 'FD5_COLLECTOR_PROFILE_CHILD_TOKEN';

interface StoredTrace { type: 'trace'; cell: string; events: unknown[];
  phases: Record<string, PhaseSummary>; faults: unknown[] }
interface ClipInput { cell: string; events: ProjectionTraceEvent[];
  phases: Record<string, PhaseSummary>; synthetic: Extract<ProjectionTraceEvent, { kind: 'phase' }>[] }
type Order = 'phase-grouped' | 'request-grouped';
type Mode = 'iteration-only' | 'noop-observer' | 'collector';

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseProfileArgs(argv: string[]): { source: string; out: string; toolSha256: string; head: string } {
  if (argv.length !== 9 || argv[0] !== '--source' || argv[2] !== '--out'
    || argv[4] !== '--tool-sha256' || argv[6] !== '--head' || argv[8] !== '--execute'
    || !argv[1] || !argv[3] || !/^[a-f0-9]{64}$/.test(argv[5] ?? '')
    || !/^[a-f0-9]{40}$/.test(argv[7] ?? ''))
    throw new Error('usage: node tools/fd5-collector-profile.ts --source PATH --out PATH --tool-sha256 SHA256 --head COMMIT --execute');
  return { source: argv[1], out: argv[3], toolSha256: argv[5]!, head: argv[7]! };
}

export async function codeHashes() {
  const [tool, collector, traceSource] = await Promise.all([
    readFile(TOOL_PATH), readFile(COLLECTOR_PATH), readFile(TRACE_SOURCE_PATH),
  ]);
  return { toolSha256: sha256(tool), collectorSha256: sha256(collector),
    traceSourceSha256: sha256(traceSource) };
}

function gitOutput(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function assertCleanHead(expectedHead: string): void {
  if (gitOutput(['rev-parse', 'HEAD']) !== expectedHead) throw new Error('git HEAD changed');
  if (gitOutput(['status', '--porcelain']) !== '') throw new Error('working tree is dirty');
}

export function validateOutputSize(bytes: Buffer): number {
  if (bytes.byteLength > MAX_RESULT_BYTES) throw new Error('profile result exceeds 1 MiB');
  return bytes.byteLength;
}

export function selectClipTraces(records: unknown[]): StoredTrace[] {
  const traces = records.filter((entry): entry is StoredTrace => record(entry) && entry.type === 'trace');
  if (traces.length !== 4) throw new Error('expected exactly four trace records');
  const seen = new Set<string>();
  for (const trace of traces) {
    if (typeof trace.cell !== 'string') throw new Error('trace cell missing');
    if (seen.has(trace.cell)) throw new Error(`duplicate trace cell: ${trace.cell}`);
    seen.add(trace.cell);
  }
  if (ALL_CELLS.some(cell => !seen.has(cell))) throw new Error('unexpected trace cells');
  return CLIP_CELLS.map(cell => traces.find(trace => trace.cell === cell)!);
}

/** Bucket values are synthetic lower-bound representatives, not recovered samples. */
export function buildSyntheticPhases(phases: Record<string, PhaseSummary>,
  units: Array<{ unitId: number; routeKey: string }>, processId: number):
  Extract<ProjectionTraceEvent, { kind: 'phase' }>[] {
  if (units.length === 0) throw new Error('no recorded parser requests');
  const result: Extract<ProjectionTraceEvent, { kind: 'phase' }>[] = [];
  for (const [key, summary] of Object.entries(phases)) {
    const [scope, phase] = key.split(':');
    if (scope !== 'clip' || !phase || !/^[a-z][a-z-]{0,47}$/.test(phase))
      throw new Error(`invalid phase key: ${key}`);
    if (!Number.isSafeInteger(summary.count) || summary.count < 0 || !Array.isArray(summary.buckets)
      || summary.buckets.length !== 65 || summary.buckets.some(count => !Number.isSafeInteger(count) || count < 0)
      || summary.buckets.reduce((sum, count) => sum + count, 0) !== summary.count)
      throw new Error(`phase bucket sum or shape invalid: ${key}`);
    let index = 0;
    for (let bucket = 0; bucket < 65; bucket++) for (let n = 0; n < summary.buckets[bucket]!; n++) {
      const unit = units[index++ % units.length]!;
      const durationNs = bucket === 0 ? 0n : 1n << BigInt(bucket - 1);
      const detail = phase === 'worker-startup' ? { processId }
        : phase === 'serialization' || phase === 'http-completion' ? { routeKey: unit.routeKey }
          : { unitId: unit.unitId, processId };
      result.push({ kind: 'phase', scope: 'clip', phase, durationNs, atNs: 0n, ...detail });
    }
  }
  return result;
}

function parseSource(bytes: Buffer): ClipInput[] {
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('source exceeds 32 MiB');
  if (sha256(bytes) !== SOURCE_SHA256) throw new Error('failed overhead evidence SHA-256 mismatch');
  const records = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as unknown);
  return selectClipTraces(records).map(trace => {
    if (!Array.isArray(trace.events) || trace.events.length !== 4106 || !record(trace.phases)
      || !Array.isArray(trace.faults) || trace.faults.length !== 0)
      throw new Error(`invalid retained clip trace: ${trace.cell}`);
    if (Object.keys(trace.phases).length !== Object.keys(PHASE_COUNTS).length
      || Object.entries(PHASE_COUNTS).some(([name, count]) => trace.phases[name]?.count !== count))
      throw new Error(`unexpected phase inventory: ${trace.cell}`);
    const events = trace.events.map(value => {
      if (!record(value) || typeof value.kind !== 'string' || typeof value.atNs !== 'string'
        || !/^\d+$/.test(value.atNs)) throw new Error(`invalid retained event: ${trace.cell}`);
      return { ...value, atNs: BigInt(value.atNs) } as ProjectionTraceEvent;
    });
    const requests = events.filter(event => event.kind === 'parser-request');
    if (requests.length !== 684) throw new Error(`parser-request count mismatch: ${trace.cell}`);
    const admissions = new Map(events.filter(event => event.kind === 'admission')
      .map(event => [event.unitId, event.routeKey]));
    const units = requests.map(event => ({ unitId: event.unitId,
      routeKey: admissions.get(event.unitId) }));
    if (units.some(unit => !unit.routeKey)) throw new Error(`parser request lacks route: ${trace.cell}`);
    const starts = events.filter(event => event.kind === 'process-start');
    if (starts.length !== 1) throw new Error(`process count mismatch: ${trace.cell}`);
    const synthetic = buildSyntheticPhases(trace.phases,
      units as Array<{ unitId: number; routeKey: string }>, starts[0]!.processId);
    if (synthetic.length !== 4789) throw new Error(`phase count mismatch: ${trace.cell}`);
    return { cell: trace.cell, events, phases: trace.phases, synthetic };
  });
}

export function buildInterleaving(input: Pick<ClipInput, 'events' | 'synthetic'>,
  order: Order): ProjectionTraceEvent[] {
  if (order === 'phase-grouped') return [...input.events, ...input.synthetic];
  const byUnit = new Map<number, ProjectionTraceEvent[]>();
  const routeToUnit = new Map(input.events.filter(event => event.kind === 'admission')
    .map(event => [event.routeKey, event.unitId]));
  const startup: ProjectionTraceEvent[] = [];
  for (const phase of input.synthetic) {
    if (phase.unitId === undefined && phase.routeKey === undefined) { startup.push(phase); continue; }
    const unitId = phase.unitId ?? routeToUnit.get(phase.routeKey!);
    if (unitId === undefined) throw new Error('synthetic phase lacks recorded route');
    const group = byUnit.get(unitId) ?? [];
    group.push(phase);
    byUnit.set(unitId, group);
  }
  const result: ProjectionTraceEvent[] = [...startup];
  for (const event of input.events) {
    result.push(event);
    if (event.kind === 'parser-request') result.push(...(byUnit.get(event.unitId) ?? []));
  }
  if (result.length !== input.events.length + input.synthetic.length)
    throw new Error('request-grouped synthetic phase placement lost events');
  return result;
}

function verifySnapshot(input: ClipInput, snapshot: ReturnType<ReturnType<typeof createProjectionTraceCollector>['snapshot']>) {
  assert.deepEqual(snapshot.faults, []);
  const expectedKinds = new Map<string, number>();
  for (const event of input.events) expectedKinds.set(event.kind, (expectedKinds.get(event.kind) ?? 0) + 1);
  const actualKinds = new Map<string, number>();
  for (const event of snapshot.events) actualKinds.set(event.kind, (actualKinds.get(event.kind) ?? 0) + 1);
  assert.deepEqual(actualKinds, expectedKinds);
  assert.deepEqual(snapshot.phases, input.phases);
}

function runArm(input: ClipInput) {
  const armStart = process.hrtime.bigint();
  const results: Array<{ order: Order; mode: Mode; iteration: number; wallNs: string;
    userMicros: number; systemMicros: number; heapUsedBytes: number; checksum?: number }> = [];
  const modes: Mode[] = ['iteration-only', 'noop-observer', 'collector'];
  const noop: ProjectionTraceObserver = () => {};
  const sequences = { 'phase-grouped': buildInterleaving(input, 'phase-grouped'),
    'request-grouped': buildInterleaving(input, 'request-grouped') };
  for (const events of Object.values(sequences)) assert.equal(events.length, 8895);
  for (let iteration = 0; iteration < ITERATIONS_PER_ORDER; iteration++) {
    const orders: Order[] = iteration % 2 === 0
      ? ['phase-grouped', 'request-grouped'] : ['request-grouped', 'phase-grouped'];
    for (const [orderIndex, order] of orders.entries()) {
      const events = sequences[order];
      for (let offset = 0; offset < modes.length; offset++) {
        const mode = modes[(iteration + orderIndex + offset) % modes.length]!;
        const collector = mode === 'collector' ? createProjectionTraceCollector(100_000) : undefined;
        let checksum = 0;
        const started = process.hrtime.bigint();
        const cpuStart = process.cpuUsage();
        for (let index = 0; index < events.length; index++) {
          const event = events[index]!;
          if (mode === 'collector') collector!.observe(event);
          else if (mode === 'noop-observer') noop(event);
          else checksum += event.kind.length;
          if ((index & 511) === 0 && process.hrtime.bigint() - armStart > MAX_ARM_NS)
            throw new Error(`${input.cell} exceeded 10-second arm cap`);
        }
        const cpu = process.cpuUsage(cpuStart);
        const wallNs = (process.hrtime.bigint() - started).toString();
        const heapUsedBytes = process.memoryUsage().heapUsed;
        if (collector) verifySnapshot(input, collector.snapshot());
        results.push({ order, mode, iteration, wallNs,
          userMicros: cpu.user, systemMicros: cpu.system, heapUsedBytes,
          ...(mode === 'iteration-only' ? { checksum } : {}) });
      }
    }
  }
  if (process.hrtime.bigint() - armStart > MAX_ARM_NS)
    throw new Error(`${input.cell} exceeded 10-second arm cap`);
  return { cell: input.cell, retainedEvents: input.events.length, syntheticPhaseEvents: input.synthetic.length,
    collectorCalls: input.synthetic.length * 20 + input.events.length * 20,
    results };
}

async function child(source: string, expectedToolSha: string): Promise<void> {
  const hashes = await codeHashes();
  if (hashes.toolSha256 !== expectedToolSha) throw new Error('tool SHA-256 changed');
  const sourceStat = await stat(source);
  if (!sourceStat.isFile() || sourceStat.size > MAX_SOURCE_BYTES) throw new Error('source exceeds 32 MiB or is not regular');
  const input = parseSource(await readFile(source));
  const arms = input.map(runArm);
  const result = { type: 'fd5-collector-only-profile.v1', sourceSha256: SOURCE_SHA256,
    ...hashes, gitHead: gitOutput(['rev-parse', 'HEAD']), nodeVersion: process.version,
    nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS), hostVetoesApplied: false,
    syntheticPhaseEvents: true,
    reconstruction: 'Histogram lower bounds; phase order and associations are synthetic.',
    measuredScope: 'Direct collector.observe(event) only; events were built before timing.',
    bounds: { arms: 2, iterationsPerArm: 20, iterationsPerOrder: 10,
      collectorCallsPerArm: 177900, armSeconds: 10, childSeconds: 25, resultBytes: MAX_RESULT_BYTES },
    arms };
  const bytes = Buffer.from(JSON.stringify(result) + '\n');
  validateOutputSize(bytes);
  process.stdout.write(bytes);
}

export async function publishExclusive(path: string, bytes: Buffer): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  let created = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, 'wx', 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temp, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close().catch(() => {});
    if (created) await unlink(temp).catch(() => {});
  }
}

async function requireAbsent(path: string): Promise<void> {
  try { await lstat(path); throw new Error(`profile artifact already exists: ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function parent(argv: string[]): Promise<void> {
  const { source, out, toolSha256, head } = parseProfileArgs(argv);
  const sourcePath = resolve(source), outputPath = resolve(out);
  const root = gitOutput(['rev-parse', '--show-toplevel']);
  if (await realpath(process.cwd()) !== await realpath(root))
    throw new Error('run from the workspace root');
  const contextDir = resolve(root, '.context');
  if ((await lstat(contextDir)).isSymbolicLink()) throw new Error('.context must not be a symlink');
  const contextRoot = contextDir + sep;
  if (!outputPath.startsWith(contextRoot) || sourcePath === outputPath)
    throw new Error('result must be a distinct path under this workspace .context/');
  if (process.env.NODE_OPTIONS || process.execArgv.length) throw new Error('Node flags are not permitted');
  assertCleanHead(head);
  const hashes = await codeHashes();
  if (hashes.toolSha256 !== toolSha256) throw new Error('tool SHA-256 mismatch');
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size > MAX_SOURCE_BYTES)
    throw new Error('source exceeds 32 MiB or is not regular');
  const sourceBytes = await readFile(sourcePath);
  if (sha256(sourceBytes) !== SOURCE_SHA256)
    throw new Error('failed overhead evidence SHA-256 mismatch');
  const ignored = spawnSync('git', ['check-ignore', '-q', outputPath]);
  if (ignored.status !== 0) throw new Error('result path is not gitignored');
  await requireAbsent(outputPath);
  await requireAbsent(`${outputPath}.sha256`);
  await mkdir(dirname(outputPath), { recursive: true });
  const realOutputDir = await realpath(dirname(outputPath));
  const realContextDir = await realpath(contextDir);
  if (realOutputDir !== realContextDir && !realOutputDir.startsWith(realContextDir + sep))
    throw new Error('result directory escapes .context');
  const childToken = randomBytes(16).toString('hex');
  const run = spawnSync(process.execPath, [TOOL_PATH, '--child', sourcePath, toolSha256, head, childToken],
    { encoding: 'utf8', timeout: MAX_CHILD_MS, maxBuffer: MAX_RESULT_BYTES, killSignal: 'SIGKILL',
      env: { ...process.env, [CHILD_TOKEN_ENV]: childToken } });
  if (run.error || run.status !== 0) throw new Error(`profile child failed: ${run.error?.message ?? run.stderr}`);
  const bytes = Buffer.from(run.stdout);
  validateOutputSize(bytes);
  if (sha256(await readFile(sourcePath)) !== SOURCE_SHA256) throw new Error('source changed during profile');
  assertCleanHead(head);
  assert.deepEqual(await codeHashes(), hashes, 'profile code changed during run');
  await publishExclusive(outputPath, bytes);
  try {
    await publishExclusive(`${outputPath}.sha256`, Buffer.from(`${sha256(bytes)}  ${outputPath.split(sep).at(-1)}\n`));
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    throw error;
  }
  process.stdout.write(`result=${outputPath}\nsha256=${sha256(bytes)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === TOOL_PATH) {
  const run = process.argv[2] === '--child'
    ? process.argv[6] && process.env[CHILD_TOKEN_ENV] === process.argv[6]
      ? (assertCleanHead(process.argv[5]!), child(process.argv[3]!, process.argv[4]!))
      : Promise.reject(new Error('private profile child requires parent token'))
    : parent(process.argv.slice(2));
  run.catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
