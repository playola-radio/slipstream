/** Deliberately separate from the registered 12-arm FD5 campaign. Raw diagnostic evidence only. */
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { arch, availableParallelism, cpus, loadavg, release, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface as createLineReader } from 'node:readline';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startCapture, type CaptureSession } from '../src/session.ts';
import { startReaderServer } from '../src/http-reader.ts';
import { createHistoricalCorpus, readRecords, runWriter, scoreCaptureArm, waitForQuietCapture,
  type BenchmarkConfig, type HistoricalChange, type WorkerWrite, type CaptureArmReport } from '../src/clip-bench.ts';
import { verifyTypeScriptGrammarArtifact } from '../src/interface-v2-typescript.ts';
import type { ProjectionTraceEvent } from '../src/projection-trace.ts';
import { SWIFT_V1 } from '../src/swift-interface.ts';
import { createInterfaceCorpus, type CorpusPage } from './fd5-bench.ts';
import { assembleProjectionTrace, scoreClipTrace, scoreProcessStartupTiming, validateInterfacePage,
  type InterfaceAttempt } from './fd5-score.ts';
import { createProjectionTraceCollector } from './fd5-trace.ts';
import { startDiagnosticLoad, type DiagnosticLoad } from './fd5-diag-load.ts';
import { startDiagnosticHttpClient } from './fd5-diag-http-client.ts';
import type { DiagnosticConfig, DiagnosticMode } from './fd5-diag.ts';

const encode = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item);
const sha = (body: string | Uint8Array): string => createHash('sha256').update(body).digest('hex');
interface DiagnosticLatency { n: number; p50: number | null; p95: number | null; p99: number | null }
function latency(samples: number[]): DiagnosticLatency {
  const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (percent: number): number | null => sorted.length
    ? sorted[Math.max(0, Math.ceil(sorted.length * percent / 100) - 1)]! : null;
  return { n: sorted.length, p50: at(50), p95: at(95), p99: at(99) };
}

type InterfaceCell = `${string}/${string}/${number}`;
export type PlannedInterface = { key: string; cell: InterfaceCell; expected: InterfaceAttempt['expected'] };
type Outcome = 'ready' | 'partial' | 'skipped' | 'invalid';
type CohortRow = { key: string; cell: InterfaceCell; outcome: Outcome; reason: string | null;
  httpDurationMs: number | null; completion: 'observed' | 'unfinished' | 'failed' | 'refused' };
export type InterfaceCohortReport = { valid: boolean; faults: string[]; plannedCount: number;
  shortfall: number; readyCount: number;
  httpLatency: DiagnosticLatency; transitionsByKey: CohortRow[];
  byCell: Record<string, { ready: number; outcomes: Record<Outcome, number>;
    httpLatency: DiagnosticLatency }>;
  fullArm: { count: number; outcomes: Record<Outcome, number>; httpLatency: DiagnosticLatency } };

function cellOf(page: CorpusPage): InterfaceCell {
  return `${page.expected.language}/${page.expected.sizeClass}/${page.limit}`;
}
export function planInterfaceCohort(corpus: CorpusPage[]): PlannedInterface[] {
  const first = corpus.slice(0, 180);
  if (first.length !== 180) throw new Error(`interface cohort needs 180 source identities; corpus has ${first.length}`);
  const counts = new Map<string, number>();
  const keys = new Set<string>();
  const planned = first.map(page => {
    const cell = cellOf(page);
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
    if (keys.has(page.expected.key)) throw new Error(`interface cohort duplicate source key ${page.expected.key}`);
    keys.add(page.expected.key);
    return { key: page.expected.key, cell, expected: page.expected };
  });
  const cells = ['typescript', 'tsx', 'swift'].flatMap(language =>
    ['tiny', 'representative'].flatMap(size => [1, 4, 16].map(limit => `${language}/${size}/${limit}`)));
  if (cells.some(cell => counts.get(cell) !== 10) || counts.size !== cells.length)
    throw new Error('interface cohort is not ten examples in each of 18 language/size/page cells');
  return planned;
}
function outcomeOf(attempt: InterfaceAttempt): Outcome {
  if (attempt.httpStatus !== 200 || attempt.error) return 'invalid';
  const body = attempt.body as { status?: unknown; page?: { complete?: unknown } } | null;
  const status = body?.status === 'ready' && body.page?.complete !== true ? 'partial' : body?.status;
  return status === 'ready' || status === 'partial' || status === 'skipped' ? status : 'invalid';
}
function durationOf(attempt: InterfaceAttempt): number | null {
  if (attempt.completedAtNs === undefined || attempt.completedAtNs < attempt.startedAtNs) return null;
  const duration = Number(attempt.completedAtNs - attempt.startedAtNs) / 1e6;
  return Number.isFinite(duration) ? duration : null;
}
const emptyOutcomes = (): Record<Outcome, number> => ({ ready: 0, partial: 0, skipped: 0, invalid: 0 });
export function scoreInterfaceCohort(planned: PlannedInterface[], attempts: InterfaceAttempt[]): InterfaceCohortReport {
  const faults: string[] = [];
  const observed = new Map<string, InterfaceAttempt[]>();
  for (const attempt of attempts) {
    const list = observed.get(attempt.expected.key) ?? [];
    list.push(attempt);
    observed.set(attempt.expected.key, list);
  }
  const shortfall = planned.filter(row => !observed.has(row.key)).length;
  if (shortfall) faults.push(`interface cohort shortfall: ${shortfall} of ${planned.length} planned identities`);
  const rows: CohortRow[] = [];
  const byCell: InterfaceCohortReport['byCell'] = {};
  const allOutcomes = emptyOutcomes();
  const allDurations: number[] = [];
  for (const attempt of attempts) {
    const outcome = outcomeOf(attempt);
    allOutcomes[outcome]++;
    if (attempt.httpStatus === 200 && !attempt.error) {
      const duration = durationOf(attempt);
      if (duration !== null) allDurations.push(duration);
    }
  }
  for (const plannedRow of planned) {
    const matches = observed.get(plannedRow.key) ?? [];
    if (!matches.length) { faults.push(`missing interface identity ${plannedRow.key}`); continue; }
    if (matches.length !== 1) faults.push(`duplicate interface identity ${plannedRow.key}: ${matches.length} terminal observations`);
    const attempt = matches[0]!;
    if (!isDeepStrictEqual(attempt.expected, plannedRow.expected))
      faults.push(`interface identity mismatch ${plannedRow.key}`);
    if (attempt.httpStatus !== 200 || attempt.error) faults.push(`interface HTTP outcome invalid ${plannedRow.key}`);
    const duration = durationOf(attempt);
    if (duration === null) faults.push(`interface terminal HTTP duration missing ${plannedRow.key}`);
    const outcome = outcomeOf(attempt);
    if (outcome === 'invalid') faults.push(`interface outcome ambiguous ${plannedRow.key}`);
    const body = attempt.body as { fallback_reason?: unknown; page?: { complete?: unknown };
      files?: Array<{ status?: unknown; fallback_reason?: unknown }> } | null;
    const fileReasons = body?.files?.map(file => file.fallback_reason).filter(
      (reason): reason is string => typeof reason === 'string') ?? [];
    const pageReason = typeof body?.fallback_reason === 'string' ? body.fallback_reason : null;
    const interrupted = [pageReason, ...fileReasons].some(reason => reason === 'timeout' || reason === 'cancelled');
    const explicitFailure = body?.files?.some(file =>
      file.status === 'unavailable' || file.status === 'unsupported' || file.status === 'incomplete') ?? false;
    const reason = pageReason ?? fileReasons[0] ?? (body?.page?.complete === false ? 'incomplete-page' : null);
    const completion = interrupted || body?.page?.complete === false && !explicitFailure && outcome !== 'skipped'
      ? 'unfinished' : outcome === 'ready' ? 'observed' : outcome === 'skipped' ? 'refused' : 'failed';
    rows.push({ key: plannedRow.key, cell: plannedRow.cell, outcome, reason,
      httpDurationMs: duration, completion });
    const cell = byCell[plannedRow.cell] ??= { ready: 0, outcomes: emptyOutcomes(),
      httpLatency: latency([]) };
    cell.outcomes[outcome]++;
    if (outcome === 'ready' && body?.files?.some(file => file.status === 'ready')) cell.ready++;
  }
  for (const [cellName, cell] of Object.entries(byCell))
    cell.httpLatency = latency(rows.filter(row => row.cell === cellName && row.httpDurationMs !== null)
      .map(row => row.httpDurationMs!));
  const cohortDurations = rows.filter(row => row.httpDurationMs !== null).map(row => row.httpDurationMs!);
  return { valid: faults.length === 0, faults, plannedCount: planned.length,
    shortfall, readyCount: Object.values(byCell).reduce((sum, cell) => sum + cell.ready, 0),
    httpLatency: latency(cohortDurations),
    transitionsByKey: rows, byCell,
    fullArm: { count: attempts.length, outcomes: allOutcomes, httpLatency: latency(allDurations) } };
}

/** Every record is appended in order. Result/failure records are durably synced. */
class Journal {
  private pending = Promise.resolve();
  private fault: Error | undefined;
  private readonly file: Awaited<ReturnType<typeof open>>;
  constructor(file: Awaited<ReturnType<typeof open>>) { this.file = file; }
  record(value: unknown, durable = false): Promise<void> {
    const next = this.pending.then(async () => {
      if (this.fault) return;
      await this.file.appendFile(encode(value) + '\n');
      if (durable) await this.file.sync();
    }).catch(error => { this.fault = error instanceof Error ? error : new Error(String(error)); });
    this.pending = next;
    return next;
  }
  async assertHealthy(): Promise<void> { await this.pending; if (this.fault) throw this.fault; }
  async close(): Promise<void> { await this.pending; await this.file.close(); if (this.fault) throw this.fault; }
}

function startCap(seconds: number): { signal: AbortSignal; expired: () => boolean; close: () => void } {
  const controller = new AbortController();
  let hit = false;
  const timer = setTimeout(() => { hit = true; controller.abort(new Error('diagnostic wall-time cap')); }, seconds * 1000);
  return { signal: controller.signal, expired: () => hit, close: () => clearTimeout(timer) };
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => {
      signal.removeEventListener('abort', onAbort); reject(error);
    });
  });
}
async function cleanupWithin<T>(work: Promise<T>): Promise<T> {
  return bounded(work, AbortSignal.timeout(5_000));
}
export async function acquireWithin<T>(work: Promise<T>, signal: AbortSignal,
  cleanup: (value: T) => Promise<void>): Promise<T> {
  try { return await bounded(work, signal); }
  catch (error) {
    if (signal.aborted) {
      const lateCleanup = work.then(cleanup);
      void lateCleanup.catch(() => {});
      await cleanupWithin(lateCleanup).catch(() => {});
    }
    throw error;
  }
}
const execFileAsync = promisify(execFile);
async function command(binary: string, args: string[]): Promise<string | null> {
  try { return (await execFileAsync(binary, args, { encoding: 'utf8', timeout: 2000,
    maxBuffer: 64 * 1024 })).stdout.trim(); }
  catch { return null; }
}
async function hostEvidence(config: DiagnosticConfig): Promise<{ at: string; load5: number; physicalCores: number | null;
  acPower: boolean | null; normalThermal: boolean | null; noMemoryWarning: boolean | null;
  swapUsedBytes: number | null; faults: string[] }> {
  const [batt, therm, memoryLevel, swap, cores] = await Promise.all([
    command('pmset', ['-g', 'batt']), command('pmset', ['-g', 'therm']),
    command('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    command('sysctl', ['vm.swapusage']), command('sysctl', ['-n', 'hw.physicalcpu']),
  ]);
  const used = swap?.match(/used\s*=\s*([\d.]+)([KMG])/i);
  const scale = used?.[2]?.toUpperCase() === 'G' ? 2 ** 30 : used?.[2]?.toUpperCase() === 'M' ? 2 ** 20 : 2 ** 10;
  const swapUsedBytes = used ? Math.round(Number(used[1]) * scale) : null;
  const load5 = loadavg()[1]!;
  const physicalCores = cores !== null && Number.isSafeInteger(Number(cores)) && Number(cores) > 0
    ? Number(cores) : null;
  const acPower = batt === null ? null : batt.includes('AC Power');
  const normalThermal = therm === null ? null :
    therm.includes('No thermal warning level has been recorded') &&
    therm.includes('No performance warning level has been recorded');
  const noMemoryWarning = memoryLevel === null ? null : memoryLevel === '1';
  const faults = [
    ...(physicalCores === null ? ['physical core count unverified'] :
      load5 >= config.host.maxFiveMinuteLoadFractionOfPhysicalCores * physicalCores ? ['host load veto'] : []),
    ...(config.host.requireAcPower && acPower !== true ? ['AC power unverified or absent'] : []),
    ...(config.host.requireNormalThermal && normalThermal !== true ? ['normal thermal state unverified'] : []),
    ...(config.host.requireNoMemoryPressureWarning && noMemoryWarning !== true ? ['memory pressure unverified or warned'] : []),
    ...(swapUsedBytes === null ? ['swap usage unverified'] : []),
  ];
  return { at: new Date().toISOString(), load5, physicalCores, acPower, normalThermal,
    noMemoryWarning, swapUsedBytes, faults };
}
async function preflight(config: DiagnosticConfig, journal: Journal): Promise<void> {
  let first: Awaited<ReturnType<typeof hostEvidence>> | undefined;
  for (let i = 0; i <= config.host.preflightQuietSeconds; i++) {
    const sample = await hostEvidence(config);
    const window = config.approvalRequired.measurementWindow as { endUtc: string };
    if (Date.now() >= Date.parse(window.endUtc)) throw new Error('approved measurement window ended during preflight');
    if (!first) first = sample;
    const swapGrowth = first.swapUsedBytes !== null && sample.swapUsedBytes !== null
      ? sample.swapUsedBytes - first.swapUsedBytes : null;
    await journal.record({ type: 'preflight-sample', sample, swapGrowthBytes: swapGrowth });
    if (sample.faults.length || swapGrowth === null || swapGrowth > config.host.maxSwapGrowthBytes)
      throw new Error(`host preflight veto: ${[...sample.faults, ...(swapGrowth === null ? ['swap growth unknown'] :
        swapGrowth > config.host.maxSwapGrowthBytes ? ['swap growth'] : [])].join(', ')}`);
    if (i < config.host.preflightQuietSeconds) await delay(1000);
  }
}
function monitorHost(config: DiagnosticConfig, journal: Journal): { stop: () => Promise<string[]> } {
  const faults: string[] = [];
  let previousSwap: number | null = null;
  let previousSampleAt: bigint | undefined;
  let pending = Promise.resolve();
  let sampling = false;
  const sample = async (): Promise<void> => {
    const startedAt = process.hrtime.bigint();
    if (previousSampleAt !== undefined && Number(startedAt - previousSampleAt) / 1e9 >
      config.host.sampleIntervalSeconds * 1.5) faults.push('host sample interval exceeded');
    previousSampleAt = startedAt;
    const item = await hostEvidence(config);
    const window = config.approvalRequired.measurementWindow as { endUtc: string };
    if (Date.now() >= Date.parse(window.endUtc)) faults.push('approved measurement window ended');
    const hadPrevious = previousSwap !== null;
    const growth = hadPrevious && item.swapUsedBytes !== null ? item.swapUsedBytes - previousSwap! : null;
    previousSwap = item.swapUsedBytes;
    faults.push(...item.faults);
    if (hadPrevious && (growth === null || growth > config.host.maxSwapGrowthBytes))
      faults.push('host swap growth unknown or positive');
    await journal.record({ type: 'host-sample', sample: item, swapGrowthBytes: growth });
  };
  const schedule = (): void => {
    if (sampling) { faults.push('host sample missed its interval'); return; }
    sampling = true;
    pending = sample().catch(error => { faults.push(`host sample: ${error}`); })
      .finally(() => { sampling = false; });
  };
  schedule();
  const timer = setInterval(schedule, config.host.sampleIntervalSeconds * 1000);
  return { stop: async () => { clearInterval(timer); await pending;
    await journal.record({ type: 'host-monitor-ended' });
    return [...new Set(faults)]; } };
}

async function runCaptureCell(config: DiagnosticConfig, journal: Journal, storeDir: string,
  clipCorpus: HistoricalChange[], interfaceCorpus: CorpusPage[], spec: {
    name: string; clip: boolean; interfaces: boolean; trace: boolean; C: number; Q: number; W: number;
    interfaceDeadlineMs: number; scheduled: number; burst: number; intervalMs: number;
    clipSlots: number; interfaceSlots: number; maxAttempts: number; maxSeconds: number; minRequestIntervalMs: number;
  }, plannedInterface?: PlannedInterface[]): Promise<{ valid: boolean; faults: string[]; capture: CaptureArmReport;
    requestLatency: DiagnosticLatency; interfaceCohort?: InterfaceCohortReport }> {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-diag-wt-'));
  const cap = startCap(spec.maxSeconds);
  const collector = createProjectionTraceCollector(100_000);
  const written: WorkerWrite[] = [];
  const durableAtNsBySeq = new Map<string, bigint>();
  let session: CaptureSession | undefined, server: Awaited<ReturnType<typeof startReaderServer>> | undefined;
  let clipLoad: DiagnosticLoad | undefined, interfaceLoad: DiagnosticLoad | undefined;
  let off: (() => void) | undefined;
  let drained = false, captureStopped = false, readerClosed = false, worktreeRemoved = false;
  const faults: string[] = [];
  const host = monitorHost(config, journal);
  const sharedCount = new SharedArrayBuffer(4);
  let clipSummary: Awaited<ReturnType<DiagnosticLoad['stop']>> | undefined;
  let interfaceSummary: Awaited<ReturnType<DiagnosticLoad['stop']>> | undefined;
  try {
    session = await acquireWithin(startCapture({ root, storeDir }), cap.signal,
      late => late.stop());
    let highWater = BigInt(session.health.snapshot().durable_seq);
    off = session.health.subscribe(() => {
      const next = BigInt(session!.health.snapshot().durable_seq);
      const at = process.hrtime.bigint();
      for (let seq = highWater + 1n; seq <= next; seq++) durableAtNsBySeq.set(seq.toString(), at);
      highWater = next;
    });
    server = await acquireWithin(startReaderServer({ storeDir,
      active: { id: session.sessionId, health: session.health, logPath: session.logPath },
      projectionAdmissionConfig: { C: spec.C, Q: spec.Q, W: spec.W, D: config.admission.clipDeadlineMs },
      interfaceDeadlineMs: spec.interfaceDeadlineMs, ...(spec.trace ? { projectionTrace: collector.observe } : {}) }),
    cap.signal, late => late.close());
    const loadOptions = { url: server.url, token: server.token, maxAttempts: spec.maxAttempts, sharedCount,
      minRequestIntervalMs: spec.minRequestIntervalMs, requestTimeoutMs: spec.interfaceDeadlineMs + 2000,
      onEvidence: (event: unknown) => { void journal.record({ type: 'load-evidence', cell: spec.name, event }); } };
    if (spec.clip) clipLoad = startDiagnosticLoad({ ...loadOptions, kind: 'clip', corpus: clipCorpus, slots: spec.clipSlots });
    if (spec.interfaces) interfaceLoad = startDiagnosticLoad({ ...loadOptions, kind: 'interface', corpus: interfaceCorpus,
      slots: spec.interfaceSlots });
    await bounded(Promise.all([clipLoad?.ready, interfaceLoad?.ready]), cap.signal);
    const writerConfig: BenchmarkConfig = { repetitions: 1, scheduledWrites: spec.scheduled,
      scheduledIntervalMs: spec.intervalMs, burstWrites: spec.burst, concurrentClipRequests: spec.clipSlots,
      corpusChanges: clipCorpus.length };
    await bounded(runWriter(root, 0, writerConfig, { signal: cap.signal, requireExit: true,
      onWrite: write => { written.push(write); void journal.record({ type: 'write', cell: spec.name, write }); } }), cap.signal);
    drained = await waitForQuietCapture(session, cap.signal);
    if (!drained) faults.push('capture quiet drain missing before cap');
  } catch (error) { faults.push(String(error)); }
  finally {
    off?.();
    const results = await Promise.allSettled([clipLoad?.stop(cap.expired()), interfaceLoad?.stop(cap.expired())]);
    if (results[0]?.status === 'fulfilled') clipSummary = results[0].value;
    else if (results[0]?.status === 'rejected') faults.push(`clip client exit: ${results[0].reason}`);
    if (results[1]?.status === 'fulfilled') interfaceSummary = results[1].value;
    else if (results[1]?.status === 'rejected') faults.push(`interface client exit: ${results[1].reason}`);
    try { if (session) { await cleanupWithin(session.stop()); captureStopped = true; } }
    catch (error) { faults.push(`capture stop: ${error}`); }
    try { if (server) { await cleanupWithin(server.close()); readerClosed = true; } }
    catch (error) { faults.push(`reader close: ${error}`); }
    try { await cleanupWithin(rm(root, { recursive: true, force: true })); worktreeRemoved = true; }
    catch (error) { faults.push(`worktree cleanup: ${error}`); }
    cap.close();
  }
  const hostFaults = await host.stop();
  faults.push(...hostFaults);
  if (cap.expired()) faults.push('wall-time cap hit');
  if (Atomics.load(new Int32Array(sharedCount), 0) >= spec.maxAttempts) faults.push('request cap hit');
  if (clipSummary?.corpusExhausted || interfaceSummary?.corpusExhausted) faults.push('cold corpus exhausted');
  if (clipSummary?.incompleteRequestIds.length || interfaceSummary?.incompleteRequestIds.length)
    faults.push('client request lacks final outcome');
  if (!captureStopped || !readerClosed || !worktreeRemoved) faults.push('incomplete cleanup');
  const records = session ? await readRecords(session.logPath) : [];
  const expectedWrites = written.map(write => ({ path: write.path, sha256: sha(write.body),
    startedAtNs: BigInt(write.startedAtNs), phase: write.phase }));
  const capture = scoreCaptureArm({ name: spec.name, writes: expectedWrites, records, durableAtNsBySeq,
    clipResponses: clipLoad?.attempts.filter(item => item.kind === 'clip').map(item => item.attempt) ?? [],
    requestedClipKeys: clipLoad?.attempts.filter(item => item.kind === 'clip').map(item => item.attempt.key ?? '') ?? [],
    concurrentClipRequests: spec.clip ? spec.clipSlots : 0, maxConcurrentRequests: clipSummary?.maxConcurrentRequests,
    coldCacheServerFresh: Boolean(spec.clip), loadStartedAtNs: clipSummary?.startedAtNs,
    loadStoppedAtNs: clipSummary?.stoppedAtNs, corpusExhausted: clipSummary?.corpusExhausted,
    attemptLimitReached: clipSummary?.attemptLimitReached, drainTimedOut: !drained });
  const requestLatency = latency([
    ...(clipLoad?.attempts.flatMap(item => item.kind === 'clip' && item.attempt.httpStatus === 200
      && item.attempt.status === 'ready'
      ? [item.attempt.latencyMs] : []) ?? []),
    ...(interfaceLoad?.attempts.flatMap(item => item.kind === 'interface' && item.attempt.httpStatus === 200
      && item.attempt.completedAtNs !== undefined
      && (item.attempt.body as { status?: string; files?: Array<{ status?: string }> } | null)?.status === 'ready'
      && (item.attempt.body as { files?: Array<{ status?: string }> } | null)?.files?.some(file => file.status === 'ready')
      ? [Number(item.attempt.completedAtNs - item.attempt.startedAtNs) / 1e6] : []) ?? []),
  ]);
  const interfaceCohort = plannedInterface ? scoreInterfaceCohort(plannedInterface,
    interfaceLoad?.attempts.filter(item => item.kind === 'interface').map(item => item.attempt) ?? []) : undefined;
  if (interfaceCohort) faults.push(...interfaceCohort.faults);
  if (capture.missing > 0 || capture.written !== spec.scheduled + spec.burst)
    faults.push('expected capture writes are missing or incomplete');
  if ((spec.clip || spec.interfaces) && requestLatency.n === 0 && !interfaceCohort)
    faults.push('loaded arm has no ready HTTP latency evidence');
  for (const item of clipLoad?.attempts ?? []) if (item.kind === 'clip') {
    const response = item.attempt;
    if (response.httpStatus !== 200 || response.error ||
      !(response.status === 'ready' || response.status === 'skipped'
        && ['overloaded', 'timeout'].includes(response.reason ?? '')))
      faults.push('clip HTTP outcome invalid');
  }
  for (const item of interfaceLoad?.attempts ?? []) if (item.kind === 'interface') {
    if (item.attempt.httpStatus !== 200 || item.attempt.error) faults.push('interface HTTP outcome invalid');
    else faults.push(...validateInterfacePage(item.attempt.body, item.attempt.expected));
  }
  if (spec.trace) {
    const observed = collector.snapshot();
    const interfaces = interfaceLoad?.attempts.filter(item => item.kind === 'interface').map(item => item.attempt) ?? [];
    const assembly = assembleProjectionTrace(observed.events, interfaces);
    faults.push(...observed.faults, ...assembly.faults);
    if (!assembly.processExitsVerified) faults.push('actual parser process exit missing');
    const startup = scoreProcessStartupTiming(assembly.processUses, observed.events,
      observed.processPhases, assembly.traces);
    faults.push(...startup.faults);
    if (spec.clip) faults.push(...scoreClipTrace(clipLoad?.attempts.filter(item => item.kind === 'clip')
      .map(item => item.attempt) ?? [], assembly.traces, assembly.clipCacheBypasses));
    for (const attempt of assembly.attempts) {
      const traces = assembly.traces.filter(trace => trace.workload === 'interface'
        && trace.routeKey === attempt.expected.routeKey && trace.submittedAtNs >= attempt.startedAtNs
        && trace.settledAtNs <= (attempt.completedAtNs ?? -1n));
      if (traces.length !== 1) { faults.push('interface HTTP request lacks unique admission join'); continue; }
      const trace = traces[0]!;
      const readyFiles = (attempt.body as { files?: Array<{ path?: string; status?: string }> } | null)
        ?.files?.filter(file => file.status === 'ready') ?? [];
      for (const file of readyFiles) {
        if (attempt.freshnessByPath?.[String(file.path)] !== 'fresh')
          faults.push(`cold interface file ${String(file.path)} lacks fresh extraction`);
        const phases = observed.unitPhases.get(trace.unitId);
        const scope = attempt.expected.language === 'swift' ? 'swift' : 'typescript';
        for (const phase of ['interface:range-scan', 'interface:cas-read', 'interface:cas-hash',
          `${scope}:${scope === 'swift' ? 'child-lifecycle' : 'worker-roundtrip'}`,
          `${scope}:grammar-load`, `${scope}:parse-compare`])
          if (!phases?.has(phase)) faults.push(`ready interface unit lacks ${phase}`);
      }
    }
    const successfulRoutes = new Map<string, number>();
    for (const attempt of assembly.attempts) if (attempt.httpStatus === 200)
      successfulRoutes.set(attempt.expected.routeKey, (successfulRoutes.get(attempt.expected.routeKey) ?? 0) + 1);
    for (const response of clipLoad?.attempts.filter(item => item.kind === 'clip').map(item => item.attempt) ?? [])
      if (response.httpStatus === 200 && response.routeKey)
        successfulRoutes.set(response.routeKey, (successfulRoutes.get(response.routeKey) ?? 0) + 1);
    for (const [route, count] of successfulRoutes) {
      const phases = observed.routePhases.get(route);
      if (phases?.serialization !== count || phases.completion !== count)
        faults.push(`HTTP route ${route} lacks completion timing`);
    }
    for (const route of observed.routePhases.keys()) if (!successfulRoutes.has(route))
      faults.push(`orphan HTTP timing ${route}`);
    await journal.record({ type: 'trace', cell: spec.name, assembly, phases: observed.phases,
      events: observed.events, faults: observed.faults, startupCensored: startup.censored });
  } else if (spec.clip || spec.interfaces) {
    await journal.record({ type: 'unverified-trace-off', cell: spec.name,
      reason: 'admission, freshness, parser exits and interface load sufficiency unknown' });
  }
  await journal.record({ type: 'cell', cell: spec.name, diagnosticValid: faults.length === 0,
    faults: [...new Set(faults)], capture, requestLatency, cleanup: { captureStopped, readerClosed, worktreeRemoved,
      clipClientExit: clipSummary?.actualWorkerExit ?? !spec.clip,
      interfaceClientExit: interfaceSummary?.actualWorkerExit ?? !spec.interfaces },
    ...(interfaceCohort ? { interfaceCohort } : {}),
    bounds: { requests: Atomics.load(new Int32Array(sharedCount), 0), maxSeconds: spec.maxSeconds,
      capHit: cap.expired() }, hostFaults }, true);
  return { valid: faults.length === 0, faults, capture, requestLatency,
    ...(interfaceCohort ? { interfaceCohort } : {}) };
}

async function runCaptureMode(mode: 'smoke' | 'overhead' | 'queue', config: DiagnosticConfig,
  journal: Journal, storeDir: string, selectedDeadlineMs = config.admission.interfaceDeadlineMs): Promise<void> {
  const clipCount = mode === 'smoke' ? config.smoke.coldKeysPerWorkload :
    mode === 'overhead' ? config.overhead.coldKeysPerWorkload : config.queue.coldKeysPerWorkload;
  const interfaceCount = clipCount;
  const preparation = startCap(config.maxPreparationSeconds);
  let clipCorpus: HistoricalChange[], interfaceCorpus: CorpusPage[];
  try {
    clipCorpus = await createHistoricalCorpus(storeDir, clipCount, preparation.signal);
    interfaceCorpus = await createInterfaceCorpus(storeDir, interfaceCount, `${config.seed}-${mode}`,
      undefined, preparation.signal);
    preparation.signal.throwIfAborted();
  } finally { preparation.close(); }
  const base = { C: config.admission.C, Q: config.admission.Q, W: config.admission.W,
    interfaceDeadlineMs: selectedDeadlineMs, clipSlots: 0, interfaceSlots: 0 };
  const cells = mode === 'smoke' ? [
    { name: 'smoke-baseline', clip: false, interfaces: false, trace: true, ...base,
      scheduled: config.smoke.scheduledWrites, burst: config.smoke.burstWrites, intervalMs: 120,
      maxAttempts: 1, maxSeconds: config.smoke.maxArmSeconds,
      minRequestIntervalMs: config.smoke.minRequestIntervalMs },
    { name: 'smoke-combined', clip: true, interfaces: true, trace: true, ...base,
      clipSlots: config.smoke.clipSlots, interfaceSlots: config.smoke.interfaceSlots,
      scheduled: config.smoke.scheduledWrites, burst: config.smoke.burstWrites, intervalMs: 120,
      maxAttempts: config.smoke.coldKeysPerWorkload * 2, maxSeconds: config.smoke.maxArmSeconds,
      minRequestIntervalMs: config.smoke.minRequestIntervalMs },
  ] : mode === 'overhead' ? config.overhead.workloads.flatMap(workload =>
    config.overhead.traceOrder.map((trace, index) => ({ name: `overhead-${workload}-${index + 1}-${trace}`,
      clip: workload === 'clip', interfaces: workload === 'interface', trace: trace === 'on', ...base,
      clipSlots: workload === 'clip' ? config.overhead.slotsPerWorkload : 0,
      interfaceSlots: workload === 'interface' ? config.overhead.slotsPerWorkload : 0,
      scheduled: config.overhead.scheduledWritesPerArm, burst: config.overhead.burstWritesPerArm,
      intervalMs: config.overhead.scheduledIntervalMs, maxAttempts: config.overhead.maxAttemptsPerArm,
      maxSeconds: config.overhead.maxArmSeconds, minRequestIntervalMs: config.overhead.minRequestIntervalMs }))) :
    config.queue.queueWaiterCells.flatMap(([Q, W]) => Array.from({ length: config.queue.repetitionsPerCell }, (_, i) => ({
      name: `queue-q${Q}-w${W}-${i + 1}`, clip: true, interfaces: true, trace: true, ...base,
      Q, W, clipSlots: config.queue.clipSlots, interfaceSlots: config.queue.interfaceSlots,
      scheduled: config.queue.scheduledWritesPerCell, burst: config.queue.burstWritesPerCell,
      intervalMs: config.queue.scheduledIntervalMs, maxAttempts: config.queue.maxAttemptsPerCell,
      maxSeconds: config.queue.maxCellSecondsIncludingDrain, minRequestIntervalMs: config.queue.minRequestIntervalMs,
    })));
  const plannedInterface = mode === 'overhead' ? planInterfaceCohort(interfaceCorpus) : undefined;
  if (plannedInterface) await journal.record({ type: 'interface-cohort-planned', scorer: config.interfaceScorer,
    identities: plannedInterface }, true);
  const reports: Array<{ capture: CaptureArmReport; requestLatency: DiagnosticLatency;
    interfaceCohort?: InterfaceCohortReport }> = [];
  for (const cell of cells) {
    const report = await runCaptureCell(config, journal, storeDir, clipCorpus, interfaceCorpus, cell,
      cell.interfaces ? plannedInterface : undefined);
    if (!report.valid) throw new Error(`diagnostic cell ${cell.name} invalid: ${report.faults.join('; ')}`);
    reports.push({ capture: report.capture, requestLatency: report.requestLatency,
      ...(report.interfaceCohort ? { interfaceCohort: report.interfaceCohort } : {}) });
  }
  if (mode === 'overhead') {
    const tolerance = config.approvalRequired.tracingOverheadTolerance as OverheadTolerance;
    const comparisons = scoreDiagnosticOverhead(reports, tolerance);
    await journal.record({ type: 'overhead-comparison', comparisons }, true);
    if (comparisons.some(item => !item.valid)) throw new Error('diagnostic overhead comparison invalid');
    if (comparisons.some(item => !item.passed)) throw new Error('tracing overhead exceeded approved tolerance');
  }
}

export interface OverheadTolerance { approved: true;
  maxCaptureLatencyRatio: { p50: number; p95: number; p99: number };
  maxRequestLatencyRatio: { p50: number; p95: number; p99: number };
  minCaptureThroughputRatio: number; minReadyRatio: number }
export function scoreDiagnosticOverhead(reports: Array<{ capture: CaptureArmReport;
  requestLatency: DiagnosticLatency; interfaceCohort?: InterfaceCohortReport }>, tolerance: OverheadTolerance):
  Array<{ workload: string; pair: number; captureRatios: { p50: number; p95: number; p99: number;
    throughput: number }; requestRatios: { p50: number; p95: number; p99: number;
    readyCount: number }; interfaceDetails?: { transitions: Record<string, number>;
      transitionsByCell: Record<string, Record<string, number>>;
      pairedTimings: Array<{ key: string; cell: string; offHttpMs: number | null;
        onHttpMs: number | null; httpRatio: number }>;
      byCell: Record<string, { off: InterfaceCohortReport['byCell'][string];
        on: InterfaceCohortReport['byCell'][string]; p50Ratio: number }>;
      offFullArm: InterfaceCohortReport['fullArm']; onFullArm: InterfaceCohortReport['fullArm'];
      offLegacyReadyOnly: DiagnosticLatency; onLegacyReadyOnly: DiagnosticLatency };
    valid: boolean; invalidReasons: string[]; passed: boolean }> {
  if (reports.length !== 8) throw new Error('overhead comparison requires eight fixed arms');
  const output = [];
  for (let workloadIndex = 0; workloadIndex < 2; workloadIndex++) for (let pair = 0; pair < 2; pair++) {
    const index = workloadIndex * 4;
    const off = reports[index + (pair === 0 ? 0 : 3)]!;
    const on = reports[index + (pair === 0 ? 1 : 2)]!;
    const divide = (a: number | null, b: number | null): number => a !== null && b !== null && b > 0 ? a / b : Infinity;
    const captureRatios = { p50: divide(on.capture.latency.p50, off.capture.latency.p50),
      p95: divide(on.capture.latency.p95, off.capture.latency.p95),
      p99: divide(on.capture.latency.p99, off.capture.latency.p99),
      throughput: divide(on.capture.throughputPerSecond, off.capture.throughputPerSecond) };
    const interfacePair = workloadIndex === 1;
    const offCohort = off.interfaceCohort, onCohort = on.interfaceCohort;
    const invalidReasons = interfacePair ? [
      ...(!offCohort || !onCohort || !offCohort.valid || !onCohort.valid ? ['interface cohort invalid'] : []),
      ...(offCohort?.readyCount === 0 ? ['zero-ready reference interface cohort'] : []),
    ] : [];
    const offLatency = interfacePair ? offCohort?.httpLatency : off.requestLatency;
    const onLatency = interfacePair ? onCohort?.httpLatency : on.requestLatency;
    const requestRatios = { p50: divide(onLatency?.p50 ?? null, offLatency?.p50 ?? null),
      p95: divide(onLatency?.p95 ?? null, offLatency?.p95 ?? null),
      p99: divide(onLatency?.p99 ?? null, offLatency?.p99 ?? null),
      readyCount: divide(interfacePair ? onCohort?.readyCount ?? null : on.requestLatency.n,
        interfacePair ? offCohort?.readyCount ?? null : off.requestLatency.n) };
    const interfaceDetails = interfacePair && offCohort && onCohort ? (() => {
      const transitions: Record<string, number> = {};
      const transitionsByCell: Record<string, Record<string, number>> = {};
      const pairedTimings: Array<{ key: string; cell: string; offHttpMs: number | null;
        onHttpMs: number | null; httpRatio: number }> = [];
      const offByKey = new Map(offCohort.transitionsByKey.map(row => [row.key, row]));
      for (const row of onCohort.transitionsByKey) {
        const prior = offByKey.get(row.key);
        const label = `${prior?.outcome ?? 'missing'}:${prior?.reason ?? 'none'} -> ${row.outcome}:${row.reason ?? 'none'}`;
        transitions[label] = (transitions[label] ?? 0) + 1;
        const cell = transitionsByCell[row.cell] ??= {};
        cell[label] = (cell[label] ?? 0) + 1;
        pairedTimings.push({ key: row.key, cell: row.cell, offHttpMs: prior?.httpDurationMs ?? null,
          onHttpMs: row.httpDurationMs,
          httpRatio: divide(row.httpDurationMs, prior?.httpDurationMs ?? null) });
      }
      const byCell: Record<string, { off: InterfaceCohortReport['byCell'][string];
        on: InterfaceCohortReport['byCell'][string]; p50Ratio: number }> = {};
      for (const cell of Object.keys(offCohort.byCell)) {
        const before = offCohort.byCell[cell]!, after = onCohort.byCell[cell]!;
        if (!after) continue;
        byCell[cell] = { off: before, on: after,
          p50Ratio: divide(after.httpLatency.p50, before.httpLatency.p50) };
      }
      return { transitions, transitionsByCell, pairedTimings, byCell,
        offFullArm: offCohort.fullArm, onFullArm: onCohort.fullArm,
        offLegacyReadyOnly: off.requestLatency,
        onLegacyReadyOnly: on.requestLatency };
    })() : undefined;
    output.push({ workload: workloadIndex === 0 ? 'clip' : 'interface', pair: pair + 1,
      captureRatios, requestRatios, ...(interfaceDetails ? { interfaceDetails } : {}),
      valid: invalidReasons.length === 0, invalidReasons,
      passed: Number.isFinite(captureRatios.throughput)
        && invalidReasons.length === 0
        && captureRatios.p50 <= tolerance.maxCaptureLatencyRatio.p50
        && captureRatios.p95 <= tolerance.maxCaptureLatencyRatio.p95
        && captureRatios.p99 <= tolerance.maxCaptureLatencyRatio.p99
        && captureRatios.throughput >= tolerance.minCaptureThroughputRatio
        && requestRatios.p50 <= tolerance.maxRequestLatencyRatio.p50
        && requestRatios.p95 <= tolerance.maxRequestLatencyRatio.p95
        && requestRatios.p99 <= tolerance.maxRequestLatencyRatio.p99
        && requestRatios.readyCount >= tolerance.minReadyRatio });
  }
  return output;
}

async function runUnqueued(config: DiagnosticConfig, journal: Journal, storeDir: string): Promise<void> {
  let requested = 0;
  const cacheDone = new Set<string>();
  const usefulSwift: number[] = [];
  const cells = config.unqueued.cells;
  const runCell = async (cell: typeof cells[number], deadlineMs: number, label: string): Promise<number> => {
    const cap = startCap(config.unqueued.maxSecondsPerCell);
    let pages: CorpusPage[];
    let hostFaults: string[] = [];
    try {
      pages = await createInterfaceCorpus(storeDir,
        config.unqueued.observationsPerCell + (cell.warmth === 'initialized-worker-new-content' ? 1 : 0),
        `${config.seed}-${label}`, { language: cell.language, sizeClass: cell.size, files: cell.files }, cap.signal);
    } catch (error) { cap.close(); throw error; }
    let server: Awaited<ReturnType<typeof startReaderServer>> | undefined;
    const client = startDiagnosticHttpClient();
    let collector = createProjectionTraceCollector(100_000);
    let attempts: InterfaceAttempt[] = [];
    const purposeById = new Map<string, string>();
    let useful = 0;
    const faults: string[] = [];
    const host = monitorHost(config, journal);
    const finishServer = async (): Promise<void> => {
      if (!server) return;
      const current = server;
      server = undefined;
      try { await cleanupWithin(current.close()); } catch (error) { faults.push(`reader close: ${error}`); }
      const snapshot = collector.snapshot();
      const assembly = assembleProjectionTrace(snapshot.events, attempts);
      faults.push(...snapshot.faults, ...assembly.faults);
      if (!assembly.processExitsVerified) faults.push('actual parser process exit missing');
      for (const attempt of assembly.attempts) {
        if (attempt.httpStatus === 200) faults.push(...validateInterfacePage(attempt.body, attempt.expected));
        else faults.push('unqueued HTTP request failed or did not return 200');
        const body = attempt.body as { files?: Array<{ path?: string; status?: string }> } | null;
        if (purposeById.get(attempt.requestId) === 'measured' && body?.files?.some(row => row.status === 'ready' &&
          attempt.freshnessByPath?.[String(row.path)] === 'fresh')) useful++;
        if (purposeById.get(attempt.requestId) === 'response-cache-control' &&
          !body?.files?.some(row => row.status === 'ready' &&
            attempt.freshnessByPath?.[String(row.path)] === 'cache-hit'))
          faults.push('cache control lacks observed cache-hit file');
      }
      await journal.record({ type: 'unqueued-trace', cell: label, attempts: assembly.attempts,
        traces: assembly.traces, phases: snapshot.phases, events: snapshot.events, faults: snapshot.faults });
      attempts = [];
      collector = createProjectionTraceCollector(100_000);
    };
    const openServer = async (): Promise<void> => {
      server = await acquireWithin(startReaderServer({ storeDir,
        projectionAdmissionConfig: { C: config.unqueued.C,
          Q: config.unqueued.Q, W: config.unqueued.W, D: config.admission.clipDeadlineMs },
        interfaceDeadlineMs: deadlineMs, projectionTrace: collector.observe }),
      cap.signal, late => late.close());
    };
    const request = async (page: CorpusPage, purpose: string): Promise<InterfaceAttempt> => {
      if (++requested > config.unqueued.maxRequestsIncludingConditional)
        throw new Error('unqueued global request cap reached');
      const attempt = await bounded(client.interface(server!.url, server!.token, page,
        deadlineMs + 2000, cap.signal), cap.signal);
      attempts.push(attempt);
      purposeById.set(attempt.requestId, purpose);
      await journal.record({ type: 'unqueued-attempt', cell: label, purpose, attempt });
      return attempt;
    };
    try {
      await bounded(client.ready, cap.signal);
      if (cell.warmth !== 'fresh-worker') await openServer();
      let start = 0;
      if (cell.warmth === 'initialized-worker-new-content') { await request(pages[0]!, 'warmup'); start = 1; }
      for (let index = 0; index < config.unqueued.observationsPerCell; index++) {
        if (cap.signal.aborted) throw cap.signal.reason;
        if (cell.warmth === 'fresh-worker') await openServer();
        const page = pages[start + index]!;
        const attempt = await request(page, 'measured');
        const body = attempt.body as { status?: string; files?: Array<{ status?: string }> } | null;
        if (!cacheDone.has(cell.language) && body?.status === 'ready' && body.files?.some(row => row.status === 'ready')) {
          cacheDone.add(cell.language);
          for (let hit = 0; hit < config.unqueued.cacheControlRequestsPerVariant; hit++)
            await request(page, 'response-cache-control');
        }
        if (cell.warmth === 'fresh-worker') await finishServer();
      }
    } catch (error) { faults.push(String(error)); }
    finally { try { await finishServer(); } finally {
      try { await client.stop(); } catch (error) { faults.push(`HTTP client exit: ${error}`); }
      cap.close(); hostFaults = await host.stop();
    } }
    faults.push(...hostFaults);
    if (cap.expired()) faults.push('cell wall-time cap hit');
    await journal.record({ type: 'unqueued-cell', cell: label, deadlineMs, observations: config.unqueued.observationsPerCell,
      usefulFresh: useful, cacheControlAvailable: cacheDone.has(cell.language), requested,
      faults: [...new Set(faults)], diagnosticValid: faults.length === 0 }, true);
    if (faults.length) throw new Error(`unqueued cell ${label} invalid: ${faults.join('; ')}`);
    return useful;
  };
  for (const [index, cell] of cells.entries()) {
    const useful = await runCell(cell, config.admission.interfaceDeadlineMs, `400-${index}-${cell.language}-${cell.files}-${cell.warmth}`);
    if (cell.language === 'swift') usefulSwift.push(useful);
  }
  for (const language of ['typescript', 'tsx', 'swift']) if (!cacheDone.has(language))
    await journal.record({ type: 'cache-control-unavailable', language,
      reason: 'no cacheable ready result; zero cache-control requests' }, true);
  if (usefulSwift.length === 3 && usefulSwift.every(count => count === 0)) {
    await journal.record({ type: 'conditional-800-trigger', basis: usefulSwift }, true);
    let total = 0;
    for (const [index, cell] of cells.filter(cell => cell.language === 'swift').entries())
      total += await runCell(cell, config.admission.conditionalInterfaceDeadlineMs, `800-${index}-swift-${cell.files}`);
    if (total === 0) throw new Error('conditional 800ms Swift cells yielded zero useful fresh work');
  }
  if (requested > config.unqueued.maxRequestsIncludingConditional) throw new Error('unqueued request cap exceeded');
}

async function runWPressure(config: DiagnosticConfig, journal: Journal, storeDir: string): Promise<void> {
  const spec = config.wPressure;
  const preparation = startCap(config.maxPreparationSeconds);
  let corpus: HistoricalChange[];
  try { corpus = await createHistoricalCorpus(storeDir, spec.waiterCaps.length * spec.groupsPerCap,
    preparation.signal); preparation.signal.throwIfAborted(); }
  finally { preparation.close(); }
  let totalRequests = 0;
  for (const [capIndex, W] of spec.waiterCaps.entries()) {
    const timer = startCap(spec.maxSecondsPerCap);
    const collector = createProjectionTraceCollector(100_000);
    const host = monitorHost(config, journal);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    let enteredPromise: Promise<void> = Promise.resolve();
    let barrierEnteredAtNs = 0n;
    let currentRoute = '';
    let admissionCount = 0;
    let currentAdmissions: Array<Extract<ProjectionTraceEvent, { kind: 'admission' }>> = [];
    let server: Awaited<ReturnType<typeof startReaderServer>> | undefined;
    const client = startDiagnosticHttpClient();
    const faults: string[] = [];
    const responses: Array<{ group: number; status: number; body: unknown; error?: string;
      startedAtNs: bigint; completedAtNs: bigint }> = [];
    try {
      server = await acquireWithin(startReaderServer({ storeDir,
        projectionAdmissionConfig: { C: spec.C, Q: spec.Q, W, D: config.admission.clipDeadlineMs },
        projectionTrace: event => {
          collector.observe(event);
          if (event.kind === 'admission' && event.routeKey === currentRoute) {
            admissionCount++; currentAdmissions.push(event);
          }
        },
        clipDispatchBarrier: () => new Promise<void>(resolve => {
          if (release) { faults.push('more than one leader entered the W barrier'); resolve(); return; }
          barrierEnteredAtNs = process.hrtime.bigint(); release = resolve; entered?.();
        }) }), timer.signal, late => late.close());
      await bounded(client.ready, timer.signal);
      for (let group = 0; group < spec.groupsPerCap; group++) {
        if (timer.signal.aborted) throw timer.signal.reason;
        const change = corpus[capIndex * spec.groupsPerCap + group]!;
        enteredPromise = new Promise<void>(resolve => { entered = resolve; });
        release = undefined;
        const route = `/v1/sessions/${change.sessionId}/changes/${change.seq}/clips`;
        currentRoute = route;
        admissionCount = 0;
        currentAdmissions = [];
        const send = async (): Promise<void> => {
          if (++totalRequests > spec.maxRequests) throw new Error('W request cap exceeded');
          try {
            const response = await client.clip(server!.url, server!.token, change,
              config.admission.clipDeadlineMs + 2000, timer.signal);
            const item = { group, status: response.httpStatus,
              body: { status: response.status, fallback_reason: response.reason },
              error: response.error, startedAtNs: response.startedAtNs!, completedAtNs: response.completedAtNs! };
            responses.push(item);
            await journal.record({ type: 'w-http', W, item });
          } catch (error) {
            const item = { group, status: 0, body: null, error: String(error), startedAtNs: process.hrtime.bigint(),
              completedAtNs: process.hrtime.bigint() };
            responses.push(item);
            await journal.record({ type: 'w-http', W, item });
          }
        };
        const leader = send();
        await bounded(enteredPromise, timer.signal);
        const waiters = Array.from({ length: spec.sameKeyWaitersPerGroup }, () => send());
        const admitted = async (): Promise<void> => {
          while (Number(process.hrtime.bigint() - barrierEnteredAtNs) / 1e6 < spec.maxBarrierMs
            && !timer.signal.aborted) {
            if (admissionCount >= 1 + spec.sameKeyWaitersPerGroup) return;
            await delay(1);
          }
        };
        await admitted();
        const beforeRelease = [...currentAdmissions];
        const barrierMs = Number(process.hrtime.bigint() - barrierEnteredAtNs) / 1e6;
        if (barrierMs > spec.maxBarrierMs) faults.push(`group ${group} exceeded barrier cap`);
        (release as (() => void) | undefined)?.();
        await journal.record({ type: 'w-before-release', W, group, route, barrierMs, admissions: beforeRelease }, true);
        await bounded(Promise.all([leader, ...waiters]), timer.signal);
        const admissions = [...currentAdmissions];
        await journal.record({ type: 'w-group', W, group, route, admissions }, true);
        if (admissions.length !== 1 + spec.sameKeyWaitersPerGroup) faults.push(`group ${group} missing admissions`);
        if (admissions.filter(item => item.disposition === 'running').length !== 1)
          faults.push(`group ${group} lacks exactly one leader`);
        const expectedWaiters = Math.min(W, spec.sameKeyWaitersPerGroup);
        if (admissions.filter(item => item.disposition === 'waiting').length !== expectedWaiters)
          faults.push(`group ${group} waiter count differs from W`);
        if (admissions.filter(item => item.disposition === 'overloaded').length !==
          spec.sameKeyWaitersPerGroup - expectedWaiters) faults.push(`group ${group} overload count differs from W`);
        const groupResponses = responses.filter(item => item.group === group);
        if (groupResponses.length !== 1 + spec.sameKeyWaitersPerGroup ||
          groupResponses.some(item => item.status !== 200)) faults.push(`group ${group} HTTP responses incomplete`);
        const overloaded = groupResponses.filter(item => {
          const body = item.body as { status?: string; fallback_reason?: string } | null;
          return body?.status === 'skipped' && body.fallback_reason === 'overloaded';
        }).length;
        if (overloaded !== spec.sameKeyWaitersPerGroup - expectedWaiters)
          faults.push(`group ${group} HTTP overload disagrees with admission`);
      }
    } catch (error) { faults.push(String(error)); }
    finally {
      release?.();
      try { if (server) await cleanupWithin(server.close()); } catch (error) { faults.push(`reader close: ${error}`); }
      try { await client.stop(); } catch (error) { faults.push(`HTTP client exit: ${error}`); }
      timer.close();
    }
    faults.push(...await host.stop());
    if (timer.expired()) faults.push('W cell wall-time cap hit');
    const snapshot = collector.snapshot();
    const assembly = assembleProjectionTrace(snapshot.events, []);
    faults.push(...snapshot.faults, ...assembly.faults);
    if (!assembly.processExitsVerified) faults.push('actual clip worker exit unverified');
    const byRoute = new Map<string, number>();
    const admissionRoutes = new Map(snapshot.events.filter(event => event.kind === 'admission')
      .map(event => [event.unitId, event.routeKey] as const));
    for (const event of snapshot.events) if (event.kind === 'parser-request') {
      const route = admissionRoutes.get(event.unitId);
      if (route) byRoute.set(route, (byRoute.get(route) ?? 0) + 1);
    }
    for (const change of corpus.slice(capIndex * spec.groupsPerCap, (capIndex + 1) * spec.groupsPerCap)) {
      const route = `/v1/sessions/${change.sessionId}/changes/${change.seq}/clips`;
      if (byRoute.get(route) !== 1) faults.push(`W group ${route} lacks exactly one parser request`);
    }
    if (responses.length !== spec.groupsPerCap * (1 + spec.sameKeyWaitersPerGroup))
      faults.push('W HTTP response count incomplete');
    await journal.record({ type: 'w-cell', W, diagnosticValid: faults.length === 0,
      faults: [...new Set(faults)], requests: responses.length, traces: assembly.traces,
      lifecycle: snapshot.events, processExitsVerified: assembly.processExitsVerified }, true);
    if (faults.length) throw new Error(`W=${W} invalid: ${faults.join('; ')}`);
  }
  if (totalRequests !== spec.maxRequests) throw new Error('W request count differs from frozen bound');
}

export function executionApprovalFaults(config: DiagnosticConfig, now = Date.now()): string[] {
  const approvals = config.approvalRequired;
  const tolerance = approvals.tracingOverheadTolerance as Partial<OverheadTolerance> | null;
  const window = approvals.measurementWindow as { approved?: unknown; startUtc?: unknown; endUtc?: unknown;
    hostVetoesApproved?: unknown } | null;
  const points = approvals.diagnosticDeadlinePoints as { approved?: unknown; interfaceMs?: unknown;
    conditional800?: unknown; cellsAndCountsApproved?: unknown } | null;
  const w = approvals.wPressureRuntimeHook as { approved?: unknown } | null;
  const clip = approvals.clipHistoricalComparison as { approved?: unknown; treatment?: unknown } | null;
  const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const ratios = (value: Partial<{ p50: number; p95: number; p99: number }> | undefined): boolean =>
    numeric(value?.p50) && numeric(value?.p95) && numeric(value?.p99);
  const start = typeof window?.startUtc === 'string' ? Date.parse(window.startUtc) : NaN;
  const end = typeof window?.endUtc === 'string' ? Date.parse(window.endUtc) : NaN;
  const utc = (value: unknown): boolean => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value);
  return [
    ...(window?.approved === true && window.hostVetoesApproved === true
      && utc(window.startUtc) && utc(window.endUtc) && Number.isFinite(start)
      && Number.isFinite(end) && start <= now && now < end ? [] : ['measurement window or host veto approval missing']),
    ...(tolerance?.approved === true && ratios(tolerance.maxCaptureLatencyRatio)
      && ratios(tolerance.maxRequestLatencyRatio) && numeric(tolerance.minCaptureThroughputRatio)
      && numeric(tolerance.minReadyRatio)
      ? [] : ['tracing overhead tolerance missing']),
    ...(points?.approved === true && JSON.stringify(points.interfaceMs) === JSON.stringify([
      config.admission.interfaceDeadlineMs, config.admission.conditionalInterfaceDeadlineMs])
      && points.conditional800 === true && points.cellsAndCountsApproved === true
      ? [] : ['diagnostic deadline points or selected cells/counts approval missing']),
    ...(w?.approved === true ? [] : ['W runtime hook approval missing']),
    ...(clip?.approved === true && clip.treatment === 'historical-only'
      ? [] : ['clip historical comparison disposition missing']),
  ];
}
const previousMode: Partial<Record<DiagnosticMode, DiagnosticMode>> = {
  overhead: 'smoke', unqueued: 'overhead', queue: 'unqueued', 'w-pressure': 'queue',
};
export async function readPrior(path: string | undefined, mode: DiagnosticMode, revision: string,
  configSha256: string, scorerVersion: string):
  Promise<{ selectedDeadlineMs?: number }> {
  const expected = previousMode[mode];
  if (!expected) { if (path) throw new Error('smoke has no prior diagnostic'); return {}; }
  if (!path) throw new Error(`${mode} requires the preceding ${expected} report`);
  let started: Record<string, unknown> | undefined, final: Record<string, unknown> | undefined;
  const useful: Record<string, unknown>[] = [];
  const lines = createLineReader({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    if (!/^\{"type":"(?:started|final|unqueued-cell|failed)"/.test(line)) { final = undefined; continue; }
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.type === 'started') started = record;
    if (record.type === 'unqueued-cell') useful.push(record);
    final = record;
  }
  if (started?.mode !== expected || started.revision !== revision || started.configSha256 !== configSha256
    || started.scorerVersion !== scorerVersion
    || final?.type !== 'final' || final.diagnosticValid !== true)
    throw new Error(`preceding ${expected} report is incomplete, invalid or from another head/config`);
  if (mode !== 'queue') return {};
  const swiftRows = useful.filter(line => Number(line.usefulFresh) > 0
    && String(line.cell).includes('swift'));
  const deadlines = swiftRows.map(line => Number(line.deadlineMs));
  const swiftUseful = swiftRows.length > 0;
  if (!swiftUseful) throw new Error('queue requires useful unqueued Swift completion');
  const selectedDeadlineMs = Math.min(...deadlines.filter(Number.isFinite));
  if (!Number.isFinite(selectedDeadlineMs)) throw new Error('queue diagnostic deadline lacks useful evidence');
  return { selectedDeadlineMs };
}
export async function runBoundedDiagnostic(config: DiagnosticConfig, mode: DiagnosticMode,
  outputPath: string, priorPath?: string): Promise<void> {
  const approvalFaults = executionApprovalFaults(config);
  if (approvalFaults.length) throw new Error(`owner execution decisions are incomplete in approvalRequired: ${approvalFaults.join('; ')}`);
  const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const output = resolve(outputPath);
  const parent = await realpath(dirname(output));
  const target = join(parent, basename(output));
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'],
    { cwd: repository, encoding: 'utf8' }).trim();
  const mainCheckout = dirname(await realpath(resolve(repository, common)));
  const normalized = (path: string): string => process.platform === 'darwin' ? path.toLowerCase() : path;
  const excluded = [repository, mainCheckout];
  if (excluded.some(root => normalized(target) === normalized(root)
    || normalized(target).startsWith(normalized(root) + sep)))
    throw new Error('diagnostic report must be outside both worktrees');
  if (execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim())
    throw new Error('diagnostics require a clean committed harness');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const configSha256 = sha(JSON.stringify(config));
  const prior = await readPrior(priorPath, mode, revision, configSha256, config.interfaceScorer);
  const file = await open(target, 'ax', 0o600);
  const journal = new Journal(file);
  let storeDir: string | undefined;
  try {
    await journal.record({ type: 'started', mode, diagnostic: true, d7Decision: 'pending', revision,
      scorerVersion: config.interfaceScorer,
      config, configSha256, at: new Date().toISOString(), startedAtNs: process.hrtime.bigint(),
      node: process.version, platform: process.platform, osRelease: release(), arch: arch(),
      cpu: cpus()[0]?.model, availableCpuThreads: availableParallelism(),
      parserArtifacts: { typescript: sha(verifyTypeScriptGrammarArtifact('typescript')),
        tsx: sha(verifyTypeScriptGrammarArtifact('tsx')), swift: SWIFT_V1 } }, true);
    await preflight(config, journal);
    storeDir = await mkdtemp(join(tmpdir(), 'slip-fd5-diag-store-'));
    if (mode === 'smoke' || mode === 'overhead' || mode === 'queue')
      await runCaptureMode(mode, config, journal, storeDir, prior.selectedDeadlineMs);
    else if (mode === 'unqueued') await runUnqueued(config, journal, storeDir);
    else await runWPressure(config, journal, storeDir);
    const endingRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const endingStatus = execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim();
    if (endingRevision !== revision || endingStatus) throw new Error('harness head or working tree changed during diagnostic');
    await cleanupWithin(rm(storeDir, { recursive: true, force: true }));
    storeDir = undefined;
    await journal.record({ type: 'final', diagnosticValid: true, d7Decision: 'pending',
      fullCampaignSufficiency: 'not evaluated', at: new Date().toISOString() }, true);
    await journal.assertHealthy();
  } catch (error) {
    await journal.record({ type: 'failed', error: String(error), diagnosticValid: false,
      d7Decision: 'pending', at: new Date().toISOString() }, true);
    throw error;
  } finally {
    if (storeDir) await rm(storeDir, { recursive: true, force: true });
    await journal.close();
  }
}
