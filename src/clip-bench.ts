/**
 * B2 live-capture measurement harness. This reports a protocol run; it does
 * not define a performance bar or declare a pass. See CLIP-LATENCY-PROTOCOL.md.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, loadavg, freemem } from 'node:os';
import { Worker } from 'node:worker_threads';
import { createCas } from './cas.ts';
import { percentile } from './bench.ts';
import { isMainModule } from './entrypoint.ts';
import type { AnyEvent } from './event.ts';
import { startReaderServer } from './http-reader.ts';
import { createLog } from './log.ts';
import { startCapture, type CaptureSession } from './session.ts';
import { CLIP_PROJECTION_VERSION } from './clip-projection.ts';

export interface BenchmarkConfig { repetitions: number; scheduledWrites: number; scheduledIntervalMs: number; burstWrites: number; concurrentClipRequests: number; corpusChanges: number }
const DEFAULTS: Readonly<BenchmarkConfig> = Object.freeze({ repetitions: 3, scheduledWrites: 100, scheduledIntervalMs: 120, burstWrites: 100, concurrentClipRequests: 16, corpusChanges: 8192 });
const CHANGES_PER_HISTORICAL_SESSION = 64;
const MAX_REQUEST_ATTEMPTS = 100_000;
const QUIET_MS = 1_000;
const DRAIN_TIMEOUT_MS = 15_000;
const NS_PER_MS = 1_000_000n;

export interface ExpectedWrite { path: string; sha256: string; startedAtNs: bigint; phase: 'scheduled' | 'burst' }
export interface ClipResponse { httpStatus: number; status: string; reason?: string; latencyMs: number; error?: string;
  key?: string; routeKey?: string; startedAtNs?: bigint; completedAtNs?: bigint }
export interface CaptureArmInput {
  name: string;
  writes: ExpectedWrite[];
  records: unknown[];
  durableAtNsBySeq: Map<string, bigint>;
  clipResponses: ClipResponse[];
  requestedClipKeys: string[];
  concurrentClipRequests: number;
  coldCacheServerFresh?: boolean;
  maxConcurrentRequests?: number;
  loadStartedAtNs?: bigint;
  loadStoppedAtNs?: bigint;
  corpusExhausted?: boolean;
  attemptLimitReached?: boolean;
  drainTimedOut?: boolean;
}

interface LatencyStats { n: number; p50: number | null; p95: number | null; p99: number | null }
export interface CaptureArmReport {
  host?: { before: ReturnType<typeof hostSample>; after: ReturnType<typeof hostSample> };
  name: string;
  written: number;
  matchedRecords: number;
  captured: number;
  missing: number;
  missingWrites: Array<{ path: string; sha256: string; reason: string }>;
  latency: LatencyStats;
  scheduledLatency: LatencyStats;
  burstLatency: LatencyStats;
  throughputPerSecond: number;
  clipResponses: { byStatus: Record<string, number>; byReason: Record<string, number>; errors: number; latency: LatencyStats };
  load: { applicable: boolean; sufficient: boolean; reasons: string[]; requested: number; uniqueKeys: number; maxConcurrentRequests: number; readyResponses: number; readyOverlappingCapture: number; nonSkippedResponses: number; overloadResponses: number; freshServer: boolean; corpusExhausted: boolean; overlap: boolean; continuousRequests: boolean; activityWindows: Array<{ ready: number; overloaded: number }> };
}

interface ChangedLike { type?: unknown; seq?: unknown; data?: { path?: unknown; after?: { kind?: unknown; sha256?: unknown } } }
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const stats = (samples: number[]): LatencyStats => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, p50: sorted.length ? percentile(sorted, 50) : null,
    p95: sorted.length ? percentile(sorted, 95) : null, p99: sorted.length ? percentile(sorted, 99) : null };
};
const increment = (target: Record<string, number>, key: string): void => { target[key] = (target[key] ?? 0) + 1; };

/** Pure scoring: joins expected writes to the real durable-sequence timestamp.
 * Deliberately never reads CloudEvents `time`, which is observation time. */
export function scoreCaptureArm(input: CaptureArmInput): CaptureArmReport {
  const changes = new Map<string, string>();
  for (const raw of input.records) {
    const record = raw as ChangedLike;
    if (record.type !== 'slipstream.file.changed.v1' || typeof record.seq !== 'string') continue;
    if (typeof record.data?.path !== 'string' || record.data.after?.kind !== 'content' || typeof record.data.after.sha256 !== 'string') continue;
    changes.set(`${record.data.path}\u0000${record.data.after.sha256}`, record.seq);
  }

  const latencies: number[] = [];
  const scheduledLatencies: number[] = [];
  const burstLatencies: number[] = [];
  const missingWrites: CaptureArmReport['missingWrites'] = [];
  let matchedRecords = 0;
  let firstStart: bigint | undefined;
  let lastDurable: bigint | undefined;
  for (const write of input.writes) {
    firstStart = firstStart === undefined || write.startedAtNs < firstStart ? write.startedAtNs : firstStart;
    const seq = changes.get(`${write.path}\u0000${write.sha256}`);
    if (!seq) { missingWrites.push({ path: write.path, sha256: write.sha256, reason: 'no matching file.changed record' }); continue; }
    matchedRecords++;
    const durableAtNs = input.durableAtNsBySeq.get(seq);
    if (durableAtNs === undefined) { missingWrites.push({ path: write.path, sha256: write.sha256, reason: `no durable-boundary timestamp for seq ${seq}` }); continue; }
    const latency = Number(durableAtNs - write.startedAtNs) / Number(NS_PER_MS);
    latencies.push(latency);
    (write.phase === 'scheduled' ? scheduledLatencies : burstLatencies).push(latency);
    lastDurable = lastDurable === undefined || durableAtNs > lastDurable ? durableAtNs : lastDurable;
  }

  const byStatus: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  let errors = 0;
  for (const response of input.clipResponses) {
    increment(byStatus, `${response.httpStatus} ${response.status}`);
    if (response.reason) increment(byReason, response.reason);
    if (response.error || response.httpStatus < 200 || response.httpStatus >= 300) errors++;
  }
  const uniqueKeys = new Set(input.requestedClipKeys).size;
  const readyResponses = input.clipResponses.filter((response) => response.status === 'ready').length;
  const nonSkippedResponses = input.clipResponses.filter((response) => response.status !== 'skipped' && !response.error).length;
  const overloadResponses = input.clipResponses.filter((response) => response.status === 'skipped' && response.reason === 'overloaded').length;
  const readyOverlappingCapture = firstStart === undefined || lastDurable === undefined ? 0 : input.clipResponses.filter((response) =>
    response.status === 'ready' && response.startedAtNs !== undefined && response.completedAtNs !== undefined
      && response.startedAtNs <= lastDurable && response.completedAtNs >= firstStart,
  ).length;
  const overlap = firstStart !== undefined && lastDurable !== undefined && input.loadStartedAtNs !== undefined && input.loadStoppedAtNs !== undefined
    && input.loadStartedAtNs <= firstStart && input.loadStoppedAtNs >= lastDurable;
  const intervals = input.clipResponses.filter(r => r.startedAtNs !== undefined && r.completedAtNs !== undefined)
    .sort((a, b) => a.startedAtNs! < b.startedAtNs! ? -1 : a.startedAtNs! > b.startedAtNs! ? 1 : 0);
  let coldKeysVerified = intervals.length === input.clipResponses.length
    && JSON.stringify(input.clipResponses.map(r => r.key).sort()) === JSON.stringify([...input.requestedClipKeys].sort());
  const prior = new Map<string, ClipResponse>();
  for (const r of intervals) {
    if (r.key === undefined) { coldKeysVerified = false; continue; }
    const previous = prior.get(r.key);
    if (previous && (previous.status !== 'skipped' || previous.reason !== 'overloaded'
      || previous.completedAtNs! > r.startedAtNs!)) coldKeysVerified = false;
    prior.set(r.key, r);
  }
  let coveredThrough = firstStart;
  for (const r of intervals) {
    if (coveredThrough === undefined || r.startedAtNs! > coveredThrough) break;
    if (r.completedAtNs! > coveredThrough) coveredThrough = r.completedAtNs!;
  }
  const continuousRequests = lastDurable !== undefined && coveredThrough !== undefined && coveredThrough >= lastDurable;
  // HTTP occupancy alone is not parser work. In every ~1s window require a
  // complete cold ready request (so its parse happened inside that window) and
  // an overload. Equal windows avoid a tiny final tail. This proves recurring
  // parse work + admission pressure, not a claim of measured CPU utilization.
  const activityWindows: Array<{ ready: number; overloaded: number }> = [];
  if (firstStart !== undefined && lastDurable !== undefined && lastDurable > firstStart) {
    const duration = lastDurable - firstStart;
    const count = Math.max(1, Math.floor(Number(duration) / 1e9));
    for (let i = 0; i < count; i++) {
      const start = firstStart + duration * BigInt(i) / BigInt(count);
      const end = firstStart + duration * BigInt(i + 1) / BigInt(count);
      activityWindows.push({
        ready: intervals.filter(r => r.status === 'ready' && r.startedAtNs! >= start && r.completedAtNs! <= end).length,
        overloaded: intervals.filter(r => r.reason === 'overloaded' && r.completedAtNs! >= start && r.completedAtNs! < end).length,
      });
    }
  }
  const applicable = input.name.startsWith('saturation');
  const reasons: string[] = applicable ? [] : ['baseline arm intentionally makes no clip requests'];
  if (applicable) {
    if (missingWrites.length > 0) reasons.push('missing durable samples prevent complete capture-interval coverage');
    if ((input.maxConcurrentRequests ?? input.concurrentClipRequests) < DEFAULTS.concurrentClipRequests) reasons.push('fewer than 16 concurrent clip requests were outstanding');
    if (!coldKeysVerified) reasons.push('a clip request repeated a content key without a completed uncached overload, or its key trace was incomplete');
    if (!(input.coldCacheServerFresh ?? false)) reasons.push('reader server was not freshly started for this load');
    if (input.clipResponses.length !== input.requestedClipKeys.length) reasons.push('not every requested clip produced a response');
    if (errors > 0) reasons.push('one or more clip requests failed');
    if (nonSkippedResponses === 0) reasons.push('no non-skipped clip response occurred during capture');
    if (readyOverlappingCapture === 0) reasons.push('no ready response overlapped the measured capture interval');
    if (overloadResponses === 0) reasons.push('no explicit overloaded response demonstrated bounded-admission saturation');
    if (!overlap) reasons.push('saturation load did not span first write through final durable capture');
    if (!continuousRequests) reasons.push('request intervals did not provide continuous coverage through final durable capture');
    if (!activityWindows.length || activityWindows.some(w => w.ready === 0 || w.overloaded === 0)) {
      reasons.push('a capture time window lacked a completed cold parse or admission overload');
    }
    if (input.corpusExhausted) reasons.push('historical cold corpus was exhausted before capture drain');
    if (input.attemptLimitReached) reasons.push('the bounded request-attempt limit was reached');
    if (input.drainTimedOut) reasons.push('capture drain timed out');
  }

  const elapsedNs = firstStart !== undefined && lastDurable !== undefined ? lastDurable - firstStart : undefined;
  return {
    name: input.name,
    written: input.writes.length,
    matchedRecords,
    captured: latencies.length,
    missing: missingWrites.length,
    missingWrites,
    latency: stats(latencies),
    scheduledLatency: stats(scheduledLatencies),
    burstLatency: stats(burstLatencies),
    throughputPerSecond: elapsedNs !== undefined && elapsedNs > 0n ? latencies.length / (Number(elapsedNs) / 1e9) : NaN,
    clipResponses: { byStatus, byReason, errors, latency: stats(input.clipResponses.map((response) => response.latencyMs)) },
    load: { applicable, sufficient: applicable && reasons.length === 0, reasons, requested: input.requestedClipKeys.length, uniqueKeys, maxConcurrentRequests: input.maxConcurrentRequests ?? input.concurrentClipRequests, readyResponses, readyOverlappingCapture, nonSkippedResponses, overloadResponses, freshServer: input.coldCacheServerFresh ?? false, corpusExhausted: input.corpusExhausted ?? false, overlap, continuousRequests, activityWindows },
  };
}

export async function readRecords(path: string): Promise<AnyEvent[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  return complete.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AnyEvent);
}

export async function waitForQuietCapture(session: CaptureSession, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let quietTimer = setTimeout(() => done(true), QUIET_MS);
    const deadline = setTimeout(() => done(false), DRAIN_TIMEOUT_MS);
    const off = session.health.subscribe(() => { clearTimeout(quietTimer); quietTimer = setTimeout(() => done(true), QUIET_MS); });
    const onAbort = (): void => done(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    function done(quiet: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      off();
      resolve(quiet);
    }
    if (signal?.aborted) done(false);
  });
}

export interface HistoricalChange { sessionId: string; seq: string; key: string }
function corpusBody(index: number, changed: boolean): string {
  const lines = Array.from({ length: 296 }, (_, line) => `  total += ${line === 147 && changed ? index + 2 : 1};`);
  return `export function corpus(value: number): number {\n  let total = value;\n${lines.join('\n')}\n  return total;\n}\n`;
}

export async function createHistoricalCorpus(storeDir: string, count: number, signal?: AbortSignal): Promise<HistoricalChange[]> {
  const cas = await createCas(join(storeDir, 'blobs'));
  let sessionId = '';
  let log: Awaited<ReturnType<typeof createLog>> | undefined;
  try {
    // Every requested after-blob is unique; the shared before blob keeps corpus
    // setup bounded without weakening the cold-cache key guarantee.
    const before = await cas.put(Buffer.from(corpusBody(0, false)));
    const changes: HistoricalChange[] = [];
    for (let index = 0; index < count; index++) {
      signal?.throwIfAborted();
      if (index % CHANGES_PER_HISTORICAL_SESSION === 0) {
        await log?.close();
        sessionId = randomUUID();
        await mkdir(join(storeDir, 'sessions', sessionId), { recursive: true, mode: 0o700 });
        log = await createLog({ filePath: join(storeDir, 'sessions', sessionId, 'events.jsonl'), sessionId });
        await log.append({ type: 'slipstream.session.started.v1', occurred_at_ms: Date.now(), data: { root: '/synthetic-clip-corpus', max_bytes: 1024 * 1024 } });
      }
      const after = await cas.put(Buffer.from(corpusBody(index, true)));
      const observedAtMs = Date.now();
      const event = await log!.append({
        type: 'slipstream.file.changed.v1', occurred_at_ms: observedAtMs,
        data: { path: `corpus-${index}.ts`, before: { kind: 'content', sha256: before.sha256, size: before.size }, after: { kind: 'content', sha256: after.sha256, size: after.size }, observation: 'watcher', observed_interval_ms: { start_ms: observedAtMs, end_ms: Date.now() } },
      });
      changes.push({ sessionId, seq: event.seq, key: `${before.sha256}/${after.sha256}/${CLIP_PROJECTION_VERSION}/typescript` });
    }
    if (new Set(changes.map(c => c.key)).size !== changes.length) throw new Error('historical corpus contains duplicate projection inputs');
    return changes;
  } finally { await log?.close(); }
}

export interface WorkerWrite { path: string; body: string; startedAtNs: string; phase: 'scheduled' | 'burst' }
export function runWriter(root: string, repetition: number, config: BenchmarkConfig,
  options?: { signal?: AbortSignal; onWrite?: (write: WorkerWrite) => void; requireExit?: boolean }): Promise<WorkerWrite[]> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(new Error('clip benchmark writer aborted')); return; }
    const worker = new Worker(new URL('./clip-bench-writer.ts', import.meta.url), {
      workerData: { root, repetition, ...config, streamWrites: Boolean(options?.onWrite) },
    });
    let settled = false;
    let completed: WorkerWrite[] | undefined;
    let failure: Error | undefined;
    const fail = (error: Error): void => {
      if (settled) return;
      if (!options?.requireExit) { finish(error); return; }
      failure ??= error;
      void worker.terminate();
    };
    const onAbort = () => fail(new Error('clip benchmark writer aborted'));
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (result: WorkerWrite[] | Error): void => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener('abort', onAbort);
      if (result instanceof Error) {
        void worker.terminate();
        reject(result);
      } else resolve(result);
    };
    worker.once('error', (err) => fail(err));
    worker.once('exit', (code) => {
      if (settled) return;
      if (failure) finish(failure);
      else if (code === 0 && options?.requireExit && completed) finish(completed);
      else finish(new Error(`clip benchmark writer exited unexpectedly (${code})`));
    });
    worker.on('message', (message: { type: string; write?: WorkerWrite; written?: WorkerWrite[]; error?: string }) => {
      if (message.type === 'error') fail(new Error(message.error));
      if (message.type === 'written' && message.write && !settled) {
        try { options?.onWrite?.(message.write); } catch (error) { fail(error as Error); }
      }
      if (message.type === 'complete') {
        if (options?.requireExit) completed = message.written ?? [];
        else finish(message.written ?? []);
      }
    });
  });
}

async function requestClip(url: string, token: string, change: HistoricalChange): Promise<ClipResponse> {
  const started = process.hrtime.bigint();
  const routeKey = `/v1/sessions/${change.sessionId}/changes/${change.seq}/clips`;
  try {
    const response = await fetch(`${url}${routeKey}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(DRAIN_TIMEOUT_MS) });
    const body = await response.json().catch(() => ({})) as { status?: unknown; fallback_reason?: unknown };
    const completed = process.hrtime.bigint();
    return { httpStatus: response.status, status: typeof body.status === 'string' ? body.status : 'invalid-response', ...(typeof body.fallback_reason === 'string' ? { reason: body.fallback_reason } : {}), latencyMs: Number(completed - started) / 1e6, routeKey, startedAtNs: started, completedAtNs: completed };
  } catch (err) {
    const completed = process.hrtime.bigint();
    return { httpStatus: 0, status: 'request-error', error: String(err), latencyMs: Number(completed - started) / 1e6, routeKey, startedAtNs: started, completedAtNs: completed };
  }
}

export interface LoadSummary { responses: ClipResponse[]; requested: string[]; maxConcurrentRequests: number; startedAtNs: bigint; stoppedAtNs: bigint; corpusExhausted: boolean; attemptLimitReached: boolean }
export function startContinuousLoad(url: string, token: string, corpus: HistoricalChange[], concurrent: number): { stop: () => Promise<LoadSummary> } {
  const startedAtNs = process.hrtime.bigint();
  const responses: ClipResponse[] = [];
  const requested: string[] = [];
  let next = 0;
  let active = 0;
  let maxConcurrentRequests = 0;
  let stopping = false;
  let corpusExhausted = false;
  let attemptLimitReached = false;
  const slot = async (): Promise<void> => {
    let change: HistoricalChange | undefined;
    while (!stopping) {
      if (requested.length >= MAX_REQUEST_ATTEMPTS) { attemptLimitReached = true; return; }
      change ??= corpus[next++];
      if (!change) { corpusExhausted = true; return; }
      requested.push(change.key);
      active++;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, active);
      try {
        const response = await requestClip(url, token, change);
        responses.push({ ...response, key: change.key });
        // This slot alone owns this key. Overload is never admitted or cached;
        // retrying it stays cold. Retire every other outcome permanently.
        if (response.status !== 'skipped' || response.reason !== 'overloaded') change = undefined;
      }
      finally { active--; }
    }
  };
  const slots = Array.from({ length: concurrent }, () => slot());
  return {
    stop: async () => {
      stopping = true;
      await Promise.all(slots);
      return { responses, requested, maxConcurrentRequests, startedAtNs, stoppedAtNs: process.hrtime.bigint(), corpusExhausted, attemptLimitReached };
    },
  };
}

export function hostSample() { return { at: new Date().toISOString(), loadavg: loadavg(), freeMemoryGiB: freemem() / 2 ** 30 }; }

async function runReplication(arm: 'baseline' | 'saturation', repetition: number, storeDir: string, corpus: HistoricalChange[], config: BenchmarkConfig): Promise<CaptureArmReport> {
  const hostBefore = hostSample();
  const root = await mkdtemp(join(tmpdir(), 'slip-clip-bench-wt-'));
  let session: CaptureSession | undefined;
  let server: Awaited<ReturnType<typeof startReaderServer>> | undefined;
  let load: ReturnType<typeof startContinuousLoad> | undefined;
  try {
    session = await startCapture({ root, storeDir });
    const durableAtNsBySeq = new Map<string, bigint>();
    let previousHighWater = BigInt(session.health.snapshot().durable_seq);
    const off = session.health.subscribe(() => {
      const nextHighWater = BigInt(session!.health.snapshot().durable_seq);
      const boundaryAtNs = process.hrtime.bigint();
      // If an implementation ever advances several seqs in one notification,
      // this is an upper bound for every seq in the advance, never a fabricated
      // event timestamp. Current capture advances one durable seq at a time.
      for (let seq = previousHighWater + 1n; seq <= nextHighWater; seq++) durableAtNsBySeq.set(seq.toString(), boundaryAtNs);
      previousHighWater = nextHighWater;
    });
    server = await startReaderServer({ storeDir, active: { id: session.sessionId, health: session.health, logPath: session.logPath } });
    if (arm === 'saturation') load = startContinuousLoad(server.url, server.token, corpus, config.concurrentClipRequests);
    const written = await runWriter(root, repetition, config);
    const drained = await waitForQuietCapture(session);
    // Quiet is only a heuristic. stop() actually drains pending capture work;
    // keep both load and durable timestamp collection alive through that drain.
    await session.stop();
    const loadSummary = load ? await load.stop() : undefined;
    off();
    const writes = written.map((item) => ({ path: item.path, sha256: sha(item.body), startedAtNs: BigInt(item.startedAtNs), phase: item.phase }));
    const report = scoreCaptureArm({
      name: `${arm} repetition ${repetition + 1}`,
      writes,
      records: await readRecords(session.logPath),
      durableAtNsBySeq,
      clipResponses: loadSummary?.responses ?? [],
      requestedClipKeys: loadSummary?.requested ?? [],
      concurrentClipRequests: arm === 'saturation' ? config.concurrentClipRequests : 0,
      maxConcurrentRequests: loadSummary?.maxConcurrentRequests,
      coldCacheServerFresh: arm === 'saturation',
      loadStartedAtNs: loadSummary?.startedAtNs,
      loadStoppedAtNs: loadSummary?.stoppedAtNs,
      corpusExhausted: loadSummary?.corpusExhausted,
      attemptLimitReached: loadSummary?.attemptLimitReached,
      drainTimedOut: !drained,
    });
    return { ...report, host: { before: hostBefore, after: hostSample() } };
  } finally {
    await load?.stop().catch(() => {});
    await server?.close();
    await session?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const smoke = process.argv.includes('--smoke');
  const config = smoke ? { ...DEFAULTS, repetitions: 1, scheduledWrites: 4, burstWrites: 10 } : DEFAULTS;
  const storeDir = await mkdtemp(join(tmpdir(), 'slip-clip-bench-store-'));
  try {
    // This direct-log corpus is intentionally historical synthetic input for the
    // reader only. Live captures below are produced only by @parcel/watcher.
    const corpus = await createHistoricalCorpus(storeDir, config.corpusChanges);
    const reports: CaptureArmReport[] = [];
    for (let repetition = 0; repetition < config.repetitions; repetition++) {
      for (const arm of (repetition % 2 === 0 ? ['baseline', 'saturation'] : ['saturation', 'baseline']) as Array<'baseline' | 'saturation'>) {
        const report = await runReplication(arm, repetition, storeDir, corpus, config);
        reports.push(report);
        // Emit only between measured arms. A later process crash must not erase
        // the completed repetitions' measurements, as the first B2 run did.
        console.error(JSON.stringify({ completed: report.name, report }));
      }
    }
    console.log(JSON.stringify({ protocol: 'B2 live capture vs cold-cache clip saturation', smoke, config, attribution: 'capture uses the existing default enrichment producer (unconfigured sources)', reports, interpretation: 'No numeric bar or pass verdict is defined here; Brian must ratify one from this baseline.' }, null, 2));
  } finally { await rm(storeDir, { recursive: true, force: true }); }
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) await main();
