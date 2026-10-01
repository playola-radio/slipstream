/** FD5 four-arm driver. Run only in an authorized measurement window. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { arch, cpus, release, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, Worker } from 'node:worker_threads';
import { isMainModule } from '../src/entrypoint.ts';
import { createCas } from '../src/cas.ts';
import { createLog } from '../src/log.ts';
import { buildPublicEnvelope, type PublicEventInput } from '../src/public-events.ts';
import { fsyncDir } from '../src/storage.ts';
import { startCapture, type CaptureSession } from '../src/session.ts';
import { startReaderServer } from '../src/http-reader.ts';
import { verifyTypeScriptGrammarArtifact } from '../src/interface-v2-typescript.ts';
import { INTERFACE_PAGE_DEADLINE_MS } from '../src/interface-service.ts';
import { SWIFT_V1 } from '../src/swift-interface.ts';
import { createHistoricalCorpus, hostSample, readRecords, runWriter, scoreCaptureArm,
  waitForQuietCapture, type BenchmarkConfig, type HistoricalChange, type LoadSummary } from '../src/clip-bench.ts';
import { assembleProjectionTrace, compareCaptureToBaseline, PLANNED_ABORT, scoreClipTrace, scoreInterfaceLoad,
  scoreProcessStartupTiming, validateInterfacePage, witnessCoverageFaults, type ExpectedFile,
  type ExpectedInterfaceRequest, type InterfaceAttempt, type InterfaceLoadInput } from './fd5-score.ts';
import { createProjectionTraceCollector } from './fd5-trace.ts';
import { encode, Journal, monitorHost, preflight, runCapped, type HostLimits } from './fd5-host.ts';

const MAX_ATTEMPTS = 100_000;
const DRAIN_TIMEOUT_MS = 15_000;
const OVERLOAD_RETRY_MS = 100;
const LANGUAGES = ['typescript', 'tsx', 'swift'] as const;
type Arm = 'baseline' | 'clip-only' | 'interface-only' | 'combined';
export interface FD5Config {
  repetitions: 3;
  scheduledWrites: 100;
  scheduledIntervalMs: 120;
  burstWrites: 100;
  requestSlots: 16;
  clipCorpusChanges: number;
  interfaceCorpusPages: number;
  admission: { C: number; Q: number; W: number; clipDeadlineMs: 100; interfaceDeadlineMs: number };
  seed: string;
  maxArmSeconds: number;
  maxPreparationSeconds: number;
  host: HostLimits;
  approvalRequired: { measurementWindow: unknown; packetDecisions: unknown };
}
const DIAGNOSTIC_HOST = (JSON.parse(readFileSync(new URL('./fd5-diagnostic-config.json', import.meta.url), 'utf8')) as
  { host: HostLimits }).host;
const rotations: Arm[][] = [
  ['baseline', 'clip-only', 'interface-only', 'combined'],
  ['interface-only', 'combined', 'baseline', 'clip-only'],
  ['combined', 'baseline', 'clip-only', 'interface-only'],
];

export function validateConfig(raw: unknown): FD5Config {
  if (raw === null || typeof raw !== 'object') throw new Error('FD5 config must be a JSON object');
  const c = raw as Record<string, unknown>;
  const a = c.admission as Record<string, unknown> | undefined;
  if (c.repetitions !== 3 || c.scheduledWrites !== 100 || c.scheduledIntervalMs !== 120 || c.burstWrites !== 100
    || c.requestSlots !== 16 || a?.clipDeadlineMs !== 100 || a?.interfaceDeadlineMs !== INTERFACE_PAGE_DEADLINE_MS)
    throw new Error('FD5 config cannot weaken the fixed B2 repetition, write, slot or clip/interface deadline protocol');
  for (const value of [c.clipCorpusChanges, c.interfaceCorpusPages, a?.C])
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('FD5 config has an invalid positive bound');
  for (const value of [a?.Q, a?.W])
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('FD5 config has an invalid queue/waiter bound');
  if ((c.clipCorpusChanges as number) < 8192 || (c.interfaceCorpusPages as number) < 8192)
    throw new Error('FD5 cold corpus must contain at least 8192 keys per workload');
  if ((a!.W as number) > (a!.Q as number)) throw new Error('W exceeds Q');
  if (typeof c.seed !== 'string' || !c.seed) throw new Error('FD5 config needs a fixed seed');
  for (const value of [c.maxArmSeconds, c.maxPreparationSeconds])
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('FD5 config needs positive wall caps');
  if (!isDeepStrictEqual(c.host, DIAGNOSTIC_HOST)) throw new Error('FD5 host vetoes must match the diagnostic quiet-host definition');
  const approvals = c.approvalRequired as Record<string, unknown> | undefined;
  if (!approvals || !('measurementWindow' in approvals) || !('packetDecisions' in approvals))
    throw new Error('FD5 config must carry its approval fields');
  return raw as FD5Config;
}

const windowEndUtc = (config: FD5Config): string => (config.approvalRequired.measurementWindow as { endUtc: string }).endUtc;

/** The registered campaign runs only inside an owner-approved window with the packet's decisions approved. */
export function campaignApprovalFaults(config: FD5Config, now = Date.now()): string[] {
  const window = config.approvalRequired.measurementWindow as { approved?: unknown; hostVetoesApproved?: unknown;
    startUtc?: unknown; endUtc?: unknown } | null;
  const decisions = config.approvalRequired.packetDecisions as { approved?: unknown } | null;
  const utc = (value: unknown): number => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ? Date.parse(value) : NaN;
  const start = utc(window?.startUtc), end = utc(window?.endUtc);
  return [
    ...(window?.approved === true && window.hostVetoesApproved === true && start <= now && now < end
      ? [] : ['measurement window or host veto approval missing']),
    ...(decisions?.approved === true ? [] : ['FD5 packet decisions approval missing']),
  ];
}

export interface CorpusPage { expected: ExpectedInterfaceRequest; limit: 1 | 4 | 16; plannedAbortMs?: number }
type Language = typeof LANGUAGES[number];
type Variant = 'unicode' | 'malformed';
export interface PagePlan { limit: 1 | 4 | 16; language: Language; sizeClass: 'tiny' | 'representative'; variant?: Variant;
  plannedAbortMs?: number }
const PLANNED_ABORT_MS = [100, 500, 2000, 5000];
/** Plain pages cycling language, page size and source size; the bounded diagnostics' cohorts depend on this layout. */
export function diagnosticCorpusPlan(index: number): PagePlan {
  return { limit: [1, 4, 16][Math.floor(index / 3) % 3]! as 1 | 4 | 16, language: LANGUAGES[index % LANGUAGES.length]!,
    sizeClass: Math.floor(index / 9) % 2 === 0 ? 'tiny' : 'representative' };
}
/** Registered page schedule: one Unicode and one parse-failure page per 20, one client disconnect per 25. */
export function corpusPlan(index: number): PagePlan {
  const plain = diagnosticCorpusPlan(index);
  const variant: Variant | undefined = index % 20 === 18 ? 'malformed'
    : index % 20 === 17 && plain.language !== 'swift' ? 'unicode' : undefined;
  if (variant) return { limit: 1, language: plain.language, sizeClass: 'tiny', variant };
  return { ...plain,
    ...index % 25 === 11 ? { plannedAbortMs: PLANNED_ABORT_MS[Math.floor(index / 25) % PLANNED_ABORT_MS.length]! } : {} };
}
interface Fixture { before: string; after: string; changes: unknown[]; extension: string; languageVersion: string;
  incompleteReason?: string }
async function fixture(name: string): Promise<Fixture> {
  const root = new URL(`../contracts/interface/v2/cases/${name}/`, import.meta.url);
  const history = JSON.parse(await readFile(new URL('history.json', root), 'utf8')) as { blobs: Record<string, string> };
  const expected = JSON.parse(await readFile(new URL('expected.json', root), 'utf8')) as { files: Array<{ before: { snapshot: { sha256: string } }; after: { snapshot: { sha256: string } }; changes: unknown[]; language_version: string; status: string; fallback_reason?: string }> };
  const file = expected.files[0]!;
  return { before: history.blobs[file.before.snapshot.sha256]!, after: history.blobs[file.after.snapshot.sha256]!,
    changes: file.changes, extension: name.startsWith('swift') ? 'swift' : 'ts', languageVersion: file.language_version,
    ...file.status === 'incomplete' ? { incompleteReason: file.fallback_reason! } : {} };
}

function sessionIdFor(name: string): string {
  const idHex = createHash('sha256').update(name).digest('hex');
  return `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-4${idHex.slice(13, 16)}-8${idHex.slice(17, 20)}-${idHex.slice(20, 32)}`;
}
const contentKey = (files: ExpectedFile[]): string => createHash('sha256')
  .update(JSON.stringify(files.map(f => [f.beforeSha256, f.afterSha256, f.language, f.languageVersion]))).digest('hex');

/** Each page has immutable before/after cutoffs; a trailing comment makes every content key unique. */
export async function createInterfaceCorpus(storeDir: string, pageCount: number, seed = 'fd5-recovery-v1',
  planFor: (index: number) => PagePlan = corpusPlan, signal?: AbortSignal): Promise<CorpusPage[]> {
  const cas = await createCas(join(storeDir, 'blobs'));
  const fixtures = {
    normal: { ts: await fixture('ts-return-change'), swift: await fixture('swift-labels-defaults-effects') },
    unicode: { ts: await fixture('ts-unicode-span') },
    malformed: { ts: await fixture('ts-parse-failure'), swift: await fixture('swift-parse-failure') },
  };
  const pages: CorpusPage[] = [];
  for (let index = 0; index < pageCount; index++) {
    signal?.throwIfAborted();
    const { limit, language: pageLanguage, sizeClass, variant, plannedAbortMs } = planFor(index);
    const family = fixtures[variant ?? 'normal'] as { ts: Fixture; swift?: Fixture };
    const ts = family.ts;
    const swift = family.swift;
    if (pageLanguage === 'swift' && !swift) throw new Error(`FD5 corpus has no Swift ${variant} fixture`);
    const sessionId = sessionIdFor(`${seed}:session:${index}`);
    await mkdir(join(storeDir, 'sessions', sessionId), { recursive: true, mode: 0o700 });
    const log = await createLog({ filePath: join(storeDir, 'sessions', sessionId, 'events.jsonl'), sessionId });
    try {
      await log.append({ type: 'slipstream.session.started.v1', occurred_at_ms: Date.now(),
        data: { root: '/synthetic-fd5-corpus', max_bytes: 1024 * 1024 } });
      const baselines: Array<Omit<ExpectedFile, 'afterRecordSeq'> & { beforeSize: number; afterSize: number }> = [];
      for (let j = 0; j < limit; j++) {
        signal?.throwIfAborted();
        const language = pageLanguage;
        const source = language === 'swift' ? swift! : ts;
        const filler = sizeClass === 'representative' ? Array.from({ length: 96 }, (_, n) => language === 'swift'
          ? `func fd5Filler${n}(x: Int) -> Int { x }\n`
          : `function fd5Filler${n}(x: number): number { return x; }\n`).join('') : '';
        const path = `file-${String(j).padStart(2, '0')}.${language === 'tsx' ? 'tsx' : source.extension}`;
        const before = await cas.put(Buffer.from(`${source.before}${filler}`));
        const after = await cas.put(Buffer.from(`${source.after}${filler}// fd5 ${seed} ${index}:${j}\n`));
        const baselineEvent = await log.append({ type: 'slipstream.file.baselined.v1', occurred_at_ms: Date.now(),
          data: { path, snapshot: { kind: 'content', sha256: before.sha256, size: before.size } } });
        baselines.push({ path, language: language === 'swift' ? 'swift' : 'typescript', languageVersion: source.languageVersion,
          beforeSha256: before.sha256, afterSha256: after.sha256, changes: source.changes,
          ...source.incompleteReason ? { incompleteReason: source.incompleteReason } : {},
          beforeRecordSeq: baselineEvent.seq,
          beforeSize: before.size, afterSize: after.size });
      }
      const baseline = await log.append({ type: 'slipstream.capture.baseline.completed.v1', occurred_at_ms: Date.now(),
        data: { unknown_scopes: [] } });
      let lastSeq = baseline.seq;
      const files: Array<ExpectedFile & { beforeSize: number; afterSize: number }> = [];
      for (const file of baselines) {
        const time = Date.now();
        const event = await log.append({ type: 'slipstream.file.changed.v1', occurred_at_ms: time,
          data: { path: file.path, before: { kind: 'content', sha256: file.beforeSha256, size: file.beforeSize },
            after: { kind: 'content', sha256: file.afterSha256, size: file.afterSize },
            observation: 'watcher', observed_interval_ms: { start_ms: time, end_ms: time } } });
        lastSeq = event.seq;
        files.push({ ...file, afterRecordSeq: event.seq });
      }
      const key = contentKey(files);
      const routeKey = `/v1/sessions/${sessionId}/interfaces?${new URLSearchParams({ before_seq: baseline.seq,
        after_seq: lastSeq, limit: String(limit) })}`;
      pages.push({ limit, ...plannedAbortMs === undefined ? {} : { plannedAbortMs },
        expected: { key, routeKey, language: pageLanguage, sizeClass, sessionId,
          beforeSeq: baseline.seq, afterSeq: lastSeq, ...variant ? { variant } : {},
          files: files.map(({ beforeSize: _a, afterSize: _b, ...file }) => file) } });
    } finally { await log.close(); }
  }
  if (new Set(pages.map(p => p.expected.key)).size !== pages.length) throw new Error('FD5 corpus repeats a cold content key');
  return pages;
}

export const LARGE_LOG_RESTORED_PATHS = 8_000;
/** One real change sorted after many changed-then-restored paths, so the page's retention scan crosses
 * every restored path before its only visible row. Written as one durable log file to keep preparation short. */
export async function createLargeLogProbe(storeDir: string, restoredPaths = LARGE_LOG_RESTORED_PATHS,
  seed = 'fd5-recovery-v1'): Promise<CorpusPage> {
  const cas = await createCas(join(storeDir, 'blobs'));
  const source = await fixture('ts-return-change');
  const original = await cas.put(Buffer.from(`// fd5 ${seed} restored\n`));
  const edited = await cas.put(Buffer.from(`// fd5 ${seed} edited\n`));
  const before = await cas.put(Buffer.from(source.before));
  const after = await cas.put(Buffer.from(`${source.after}// fd5 ${seed} large-log\n`));
  const sessionId = sessionIdFor(`${seed}:large-log`);
  const dir = join(storeDir, 'sessions', sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const at = Date.now();
  const content = (blob: { sha256: string; size: number }) => ({ kind: 'content' as const, sha256: blob.sha256, size: blob.size });
  const paths = Array.from({ length: restoredPaths }, (_, i) => `p-${String(i).padStart(5, '0')}.ts`);
  const realPath = 'zz-large-log.ts';
  const changed = (path: string, from: typeof before, to: typeof before) => ({ type: 'slipstream.file.changed.v1' as const,
    occurred_at_ms: at, data: { path, before: content(from), after: content(to), observation: 'watcher' as const,
      observed_interval_ms: { start_ms: at, end_ms: at } } });
  const inputs: PublicEventInput[] = [
    { type: 'slipstream.session.started.v1', occurred_at_ms: at, data: { root: '/synthetic-fd5-large-log', max_bytes: 1024 * 1024 } },
    ...paths.map(path => ({ type: 'slipstream.file.baselined.v1' as const, occurred_at_ms: at,
      data: { path, snapshot: content(original) } })),
    { type: 'slipstream.file.baselined.v1', occurred_at_ms: at, data: { path: realPath, snapshot: content(before) } },
    { type: 'slipstream.capture.baseline.completed.v1', occurred_at_ms: at, data: { unknown_scopes: [] } },
    ...paths.map(path => changed(path, original, edited)),
    ...paths.map(path => changed(path, edited, original)),
    changed(realPath, before, after),
  ];
  const events = inputs.map((input, i) => buildPublicEnvelope(input, BigInt(i + 1), sessionId));
  const file = await open(join(dir, 'events.jsonl'), 'wx', 0o600);
  try {
    await file.writeFile(events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await file.sync();
  } finally { await file.close(); }
  await fsyncDir(dir);
  const beforeSeq = String(restoredPaths + 3), afterSeq = String(events.length);
  const files: ExpectedFile[] = [{ path: realPath, language: 'typescript', languageVersion: source.languageVersion,
    beforeSha256: before.sha256, afterSha256: after.sha256, changes: source.changes,
    beforeRecordSeq: String(restoredPaths + 2), afterRecordSeq: afterSeq }];
  const routeKey = `/v1/sessions/${sessionId}/interfaces?${new URLSearchParams({ before_seq: beforeSeq,
    after_seq: afterSeq, limit: '1' })}`;
  return { limit: 1, expected: { key: contentKey(files), routeKey, language: 'typescript', sizeClass: 'tiny', sessionId,
    beforeSeq, afterSeq, files } };
}

async function requestInterface(url: string, token: string, page: CorpusPage): Promise<InterfaceAttempt> {
  const startedAtNs = process.hrtime.bigint();
  const requestId = randomUUID();
  const planned = page.plannedAbortMs === undefined ? {} : { plannedAbortMs: page.plannedAbortMs };
  const disconnect = new AbortController();
  const timer = page.plannedAbortMs === undefined ? undefined : setTimeout(() => disconnect.abort(), page.plannedAbortMs);
  try {
    const response = await fetch(`${url}${page.expected.routeKey}`, { headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([disconnect.signal, AbortSignal.timeout(DRAIN_TIMEOUT_MS)]) });
    const body: unknown = await response.json().catch(() => null);
    if (disconnect.signal.aborted) throw new Error('planned disconnect interrupted the response body');
    return { requestId, expected: page.expected, startedAtNs, completedAtNs: process.hrtime.bigint(),
      httpStatus: response.status, body, ...planned };
  } catch (error) {
    return { requestId, expected: page.expected, startedAtNs, completedAtNs: process.hrtime.bigint(),
      error: disconnect.signal.aborted ? PLANNED_ABORT : String(error), ...planned };
  } finally { clearTimeout(timer); }
}

export interface InterfaceLoadSummary { attempts: InterfaceAttempt[]; maxConcurrentRequests: number;
  startedAtNs: bigint; stoppedAtNs: bigint; corpusExhausted: boolean; attemptLimitReached: boolean }
export function startInterfaceLoad(url: string, token: string, corpus: CorpusPage[], slots: number): { stop: () => Promise<InterfaceLoadSummary> } {
  const startedAtNs = process.hrtime.bigint();
  const attempts: InterfaceAttempt[] = [];
  let next = 0, submitted = 0, active = 0, maxConcurrentRequests = 0;
  let stopping = false, corpusExhausted = false, attemptLimitReached = false;
  const slot = async (): Promise<void> => {
    let page: CorpusPage | undefined;
    while (!stopping) {
      if (submitted >= MAX_ATTEMPTS) { attemptLimitReached = true; return; }
      page ??= corpus[next++];
      if (!page) { corpusExhausted = true; return; }
      submitted++;
      active++;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, active);
      try {
        const attempt = await requestInterface(url, token, page);
        attempts.push(attempt);
        const body = attempt.body as { status?: unknown; fallback_reason?: unknown } | null;
        if (page.plannedAbortMs !== undefined || body?.status !== 'skipped' || body.fallback_reason !== 'overloaded') page = undefined;
      } finally { active--; }
      if (page) await new Promise(resolve => setTimeout(resolve, OVERLOAD_RETRY_MS));
    }
  };
  const workers = Array.from({ length: slots }, () => slot());
  return { stop: async () => {
    stopping = true;
    await Promise.all(workers);
    return { attempts, maxConcurrentRequests, startedAtNs, stoppedAtNs: process.hrtime.bigint(),
      corpusExhausted, attemptLimitReached };
  } };
}

const hash = (body: string): string => createHash('sha256').update(body).digest('hex');
function startLoadWorker(kind: 'clip', url: string, token: string, corpus: HistoricalChange[], slots: number):
  { ready: Promise<void>; stop: () => Promise<LoadSummary> };
function startLoadWorker(kind: 'interface', url: string, token: string, corpus: CorpusPage[], slots: number):
  { ready: Promise<void>; stop: () => Promise<InterfaceLoadSummary> };
function startLoadWorker(kind: 'clip' | 'interface', url: string, token: string,
  corpus: HistoricalChange[] | CorpusPage[], slots: number) {
  const worker = new Worker(new URL('./fd5-load-worker.ts', import.meta.url), {
    workerData: { kind, url, token, corpus, slots },
  });
  let started = false, finished = false;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let stopResolve!: (value: LoadSummary | InterfaceLoadSummary) => void, stopReject!: (error: Error) => void;
  let exitResolve!: () => void, exitReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const stopped = new Promise<LoadSummary | InterfaceLoadSummary>((resolve, reject) => { stopResolve = resolve; stopReject = reject; });
  const exited = new Promise<void>((resolve, reject) => { exitResolve = resolve; exitReject = reject; });
  void stopped.catch(() => {});
  void exited.catch(() => {});
  worker.on('message', (message: { type: string; summary?: LoadSummary | InterfaceLoadSummary; error?: string }) => {
    if (message.type === 'started') { started = true; readyResolve(); }
    else if (message.type === 'summary' && message.summary) { finished = true; stopResolve(message.summary); }
    else if (message.type === 'error') { finished = true; stopReject(new Error(message.error)); }
  });
  worker.on('error', error => { if (!started) readyReject(error); if (!finished) stopReject(error); });
  worker.on('exit', code => {
    if (!started) readyReject(new Error(`FD5 load worker exited before start (${code})`));
    if (!finished) stopReject(new Error(`FD5 load worker exited without summary (${code})`));
    if (code === 0) exitResolve(); else exitReject(new Error(`FD5 load worker exited ${code}`));
  });
  let startDeadline: ReturnType<typeof setTimeout> | undefined;
  const boundedReady = Promise.race([ready, new Promise<never>((_resolve, reject) => {
    startDeadline = setTimeout(() => reject(new Error('FD5 load worker did not start within 30 seconds')), 30_000);
  })]).catch(async error => { await worker.terminate(); throw error; })
    .finally(() => { if (startDeadline) clearTimeout(startDeadline); });
  let stopping: Promise<LoadSummary | InterfaceLoadSummary> | undefined;
  return { ready: boundedReady, stop: () => stopping ??= (async () => {
    await boundedReady;
    worker.postMessage('stop');
    let responseDeadline: ReturnType<typeof setTimeout> | undefined;
    let summary: LoadSummary | InterfaceLoadSummary;
    try {
      summary = await Promise.race([stopped, new Promise<never>((_resolve, reject) => {
        responseDeadline = setTimeout(() => reject(new Error('FD5 load worker did not stop within 20 seconds')), 20_000);
      })]);
    } catch (error) {
      await worker.terminate();
      throw error;
    } finally { if (responseDeadline) clearTimeout(responseDeadline); }
    // A completed response is not enough; prove this client worker actually exited.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('FD5 load worker did not exit after stop')), 5_000);
      })]);
    } catch (error) {
      await worker.terminate();
      throw error;
    } finally { if (deadline) clearTimeout(deadline); }
    return summary;
  })() };
}
function traceEvidence(observed: ReturnType<ReturnType<typeof createProjectionTraceCollector>['snapshot']>,
  clips: LoadSummary | undefined, interfaces: InterfaceLoadSummary | undefined) {
  const assembly = assembleProjectionTrace(observed.events, interfaces?.attempts ?? []);
  const requiredPhases = new Set<string>();
  if (clips) for (const phase of ['worker-startup', 'worker-roundtrip', 'grammar-load',
    'parse-compare', 'cas-read', 'serialization', 'http-completion']) requiredPhases.add(`clip:${phase}`);
  if (interfaces) {
    for (const phase of ['range-scan', 'cas-read', 'cas-hash', 'serialization', 'http-completion'])
      requiredPhases.add(`interface:${phase}`);
    for (const phase of ['worker-startup', 'worker-roundtrip', 'grammar-load', 'parse-compare'])
      requiredPhases.add(`typescript:${phase}`);
    for (const phase of ['child-startup', 'child-lifecycle', 'grammar-load', 'parse-compare'])
      requiredPhases.add(`swift:${phase}`);
  }
  const phaseFaults = [...requiredPhases].filter(phase => (observed.phases[phase]?.count ?? 0) === 0)
    .map(phase => `missing ${phase} timing`);
  const interfaceAttemptsByRoute = new Map<string, InterfaceAttempt[]>();
  for (const attempt of assembly.attempts) {
    const group = interfaceAttemptsByRoute.get(attempt.expected.routeKey) ?? [];
    group.push(attempt);
    interfaceAttemptsByRoute.set(attempt.expected.routeKey, group);
  }
  const clipResponsesByRoute = new Map<string, LoadSummary['responses']>();
  for (const response of clips?.responses ?? []) if (response.routeKey) {
    const group = clipResponsesByRoute.get(response.routeKey) ?? [];
    group.push(response);
    clipResponsesByRoute.set(response.routeKey, group);
  }
  for (const trace of assembly.traces) {
    if (trace.outcome !== 'ok') continue;
    const names = observed.unitPhases.get(trace.unitId) ?? new Set<string>();
    const interfaceCandidates = trace.workload === 'interface'
      ? (interfaceAttemptsByRoute.get(trace.routeKey) ?? []).filter(attempt =>
      attempt.startedAtNs <= trace.submittedAtNs
        && trace.settledAtNs <= (attempt.completedAtNs ?? -1n)) : [];
    if (trace.workload === 'interface' && interfaceCandidates.length !== 1)
      phaseFaults.push(`unit ${trace.unitId} lacks unique HTTP timing join`);
    const interfaceAttempt = interfaceCandidates.length === 1 ? interfaceCandidates[0] : undefined;
    const freshInterface = interfaceAttempt && (interfaceAttempt.body as { files?: Array<{ path?: string; status?: string }> } | undefined)
      ?.files?.some(row => row.status === 'ready' && interfaceAttempt.freshnessByPath?.[String(row.path)] === 'fresh');
    const readyClip = trace.workload === 'clip' && (clipResponsesByRoute.get(trace.routeKey) ?? []).some(response =>
      response.status === 'ready' && response.startedAtNs !== undefined && response.completedAtNs !== undefined
      && response.startedAtNs <= trace.submittedAtNs && trace.settledAtNs <= response.completedAtNs);
    const needed = freshInterface ? [
      'interface:range-scan', 'interface:cas-read', 'interface:cas-hash',
      ...(interfaceAttempt!.expected.language === 'swift'
        ? ['swift:child-startup', 'swift:child-lifecycle', 'swift:grammar-load', 'swift:parse-compare']
        : ['typescript:worker-roundtrip', 'typescript:grammar-load', 'typescript:parse-compare']),
    ] : readyClip ? ['clip:cas-read', 'clip:worker-roundtrip', 'clip:grammar-load', 'clip:parse-compare']
      : trace.workload === 'interface' ? ['interface:range-scan'] : [];
    for (const phase of needed) if (!names.has(phase))
      phaseFaults.push(`unit ${trace.unitId} lacks ${phase} timing`);
  }
  const startup = scoreProcessStartupTiming(assembly.processUses, observed.events,
    observed.processPhases, assembly.traces);
  phaseFaults.push(...startup.faults);
  const successfulRoutes = new Map<string, number>();
  for (const attempt of interfaces?.attempts ?? []) if (attempt.httpStatus === 200)
    successfulRoutes.set(attempt.expected.routeKey, (successfulRoutes.get(attempt.expected.routeKey) ?? 0) + 1);
  for (const response of clips?.responses ?? []) if (response.httpStatus === 200 && response.routeKey)
    successfulRoutes.set(response.routeKey, (successfulRoutes.get(response.routeKey) ?? 0) + 1);
  for (const [routeKey, count] of successfulRoutes) {
    const phases = observed.routePhases.get(routeKey);
    if (phases?.serialization !== count || phases.completion !== count)
      phaseFaults.push(`HTTP route ${routeKey} lacks serialization or completion timing`);
  }
  for (const routeKey of observed.routePhases.keys()) if (!successfulRoutes.has(routeKey))
    phaseFaults.push(`HTTP timing has no successful client response for ${routeKey}`);
  const traceFaults = [...observed.faults, ...assembly.faults, ...phaseFaults];
  const processExitsVerified = assembly.processExitsVerified && !assembly.faults.some(fault =>
    fault === 'reader process has no actual exit' || fault === 'orphan or duplicate process exit');
  return { observed, assembly, startup, traceFaults, processExitsVerified };
}

/** Swift children are this process's children; after cleanup none may remain. TS workers are threads,
 * so their exits are proven only by traced witnesses. An inspection failure is not an observed exit. */
export async function childProcessesExit(pgrep = 'pgrep'): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const children = await new Promise<string | null>(resolve => execFile(pgrep, ['-P', String(process.pid)],
      { timeout: 2_000 }, (error, stdout) => resolve(!error ? stdout.trim()
        : (error as { code?: unknown }).code === 1 ? '' : null)));
    if (children === null) return false;
    if (!children) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function runArm(arm: Arm, repetition: number, storeDir: string, clipCorpus: Awaited<ReturnType<typeof createHistoricalCorpus>>,
  interfaceCorpus: CorpusPage[], config: FD5Config, traced: boolean, journal: Journal,
  signal: AbortSignal, veto: (reason: Error) => void) {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-wt-'));
  let session: CaptureSession | undefined;
  let server: Awaited<ReturnType<typeof startReaderServer>> | undefined;
  let clipLoad: { ready: Promise<void>; stop: () => Promise<LoadSummary> } | undefined;
  let interfaceLoad: { ready: Promise<void>; stop: () => Promise<InterfaceLoadSummary> } | undefined;
  let off: (() => void) | undefined;
  const hostBefore = hostSample();
  const durableAtNsBySeq = new Map<string, bigint>();
  // Registered arms run untraced: the 2026-09-29 overhead failure means traced capture latency is not scoreable.
  const collector = traced ? createProjectionTraceCollector() : undefined;
  const host = monitorHost(config.host, windowEndUtc(config), journal,
    fault => veto(new Error(`host veto during ${arm}: ${fault}`)));
  let hostStopped = false;
  // A cap hit or veto ends load at once; the writer and drain are bounded on their own.
  const stopLoad = (): void => { void clipLoad?.stop().catch(() => {}); void interfaceLoad?.stop().catch(() => {}); };
  signal.addEventListener('abort', stopLoad, { once: true });
  try {
    session = await startCapture({ root, storeDir });
    let highWater = BigInt(session.health.snapshot().durable_seq);
    off = session.health.subscribe(() => {
      const next = BigInt(session!.health.snapshot().durable_seq);
      const at = process.hrtime.bigint();
      for (let seq = highWater + 1n; seq <= next; seq++) durableAtNsBySeq.set(seq.toString(), at);
      highWater = next;
    });
    server = await startReaderServer({ storeDir, active: { id: session.sessionId, health: session.health, logPath: session.logPath },
      projectionAdmissionConfig: { C: config.admission.C, Q: config.admission.Q, W: config.admission.W, D: config.admission.clipDeadlineMs },
      interfaceDeadlineMs: config.admission.interfaceDeadlineMs, ...collector ? { projectionTrace: collector.observe } : {} });
    if (arm === 'clip-only' || arm === 'combined') clipLoad = startLoadWorker('clip', server.url, server.token, clipCorpus, config.requestSlots);
    if (arm === 'interface-only' || arm === 'combined') interfaceLoad = startLoadWorker('interface', server.url, server.token, interfaceCorpus, config.requestSlots);
    await Promise.all([clipLoad?.ready, interfaceLoad?.ready]);
    signal.throwIfAborted();
    const writerConfig: BenchmarkConfig = { repetitions: config.repetitions, scheduledWrites: config.scheduledWrites,
      scheduledIntervalMs: config.scheduledIntervalMs, burstWrites: config.burstWrites,
      concurrentClipRequests: config.requestSlots, corpusChanges: config.clipCorpusChanges };
    const written = await runWriter(root, repetition, writerConfig);
    signal.throwIfAborted();
    const drained = await waitForQuietCapture(session);
    signal.throwIfAborted();
    await session.stop();
    const [clips, interfaces] = await Promise.all([clipLoad?.stop(), interfaceLoad?.stop()]);
    off(); off = undefined;
    const records = await readRecords(session.logPath);
    await server.close(); server = undefined;
    await rm(root, { recursive: true, force: true });
    const hostFaults = await host.stop(); hostStopped = true;
    const childProcessesExited = await childProcessesExit();
    const trace = collector ? traceEvidence(collector.snapshot(), clips, interfaces) : undefined;
    const traceFaults = trace?.traceFaults ?? [];
    const cleanupComplete = childProcessesExited && (!trace || (trace.processExitsVerified && traceFaults.length === 0));
    const writes = written.map(item => ({ path: item.path, sha256: hash(item.body), startedAtNs: BigInt(item.startedAtNs), phase: item.phase }));
    const capture = scoreCaptureArm({ name: (clips ? 'saturation' : arm) + ` repetition ${repetition + 1}`,
      writes, records, durableAtNsBySeq, clipResponses: clips?.responses ?? [], requestedClipKeys: clips?.requested ?? [],
      concurrentClipRequests: clips ? config.requestSlots : 0, maxConcurrentRequests: clips?.maxConcurrentRequests,
      coldCacheServerFresh: Boolean(clips), loadStartedAtNs: clips?.startedAtNs, loadStoppedAtNs: clips?.stoppedAtNs,
      corpusExhausted: clips?.corpusExhausted, attemptLimitReached: clips?.attemptLimitReached, drainTimedOut: !drained });
    if (clips) {
      const clipFaults = trace ? scoreClipTrace(clips.responses, trace.assembly.traces, trace.assembly.clipCacheBypasses) : [];
      if (!childProcessesExited) clipFaults.push('child processes remained after cleanup');
      capture.load.reasons.push(...traceFaults, ...clipFaults);
      capture.load.sufficient &&= traceFaults.length === 0 && clipFaults.length === 0;
    }
    const first = writes.reduce<bigint | undefined>((min, w) => min === undefined || w.startedAtNs < min ? w.startedAtNs : min, undefined);
    const expectedHashes = new Set(writes.map(w => `${w.path}\0${w.sha256}`));
    const last = records.reduce<bigint | undefined>((max, record) => {
      if (record.type !== 'slipstream.file.changed.v1') return max;
      const data = record.data as { path?: string; after?: { kind?: string; sha256?: string } };
      if (!expectedHashes.has(`${data.path}\0${data.after?.sha256}`)) return max;
      const at = durableAtNsBySeq.get(record.seq);
      return at !== undefined && (max === undefined || at > max) ? at : max;
    }, undefined);
    const interfaceInput: InterfaceLoadInput | undefined = interfaces && first !== undefined && last !== undefined ? {
      ...interfaces, attempts: trace?.assembly.attempts ?? interfaces.attempts, traces: trace?.assembly.traces ?? null,
      corpusKeys: interfaceCorpus.map(c => c.expected.key),
      freshServer: true, loadStartedAtNs: interfaces.startedAtNs, loadStoppedAtNs: interfaces.stoppedAtNs,
      firstWriteAtNs: first, lastDurableAtNs: last, drained, cleanupComplete,
    } : undefined;
    const interfaceReport = interfaceInput ? scoreInterfaceLoad(interfaceInput) : null;
    if (interfaceReport && traceFaults.length) {
      interfaceReport.reasons.push(...traceFaults);
      interfaceReport.sufficient = false;
    }
    const witnessFaults = trace && interfaceReport ? witnessCoverageFaults(interfaceReport, trace.observed.events) : [];
    const attempts = trace?.assembly.attempts ?? interfaces?.attempts ?? [];
    return { arm, repetition: repetition + 1, traced, host: { before: hostBefore, after: hostSample(), faults: hostFaults },
      capture, interface: interfaceReport, witnessFaults,
      cleanup: { captureStopCompleted: true, quietDrainObserved: drained, readerClosed: true,
        worktreeRemoved: true, childProcessesExited,
        processExitsVerified: trace ? trace.processExitsVerified : null,
        traceEvidenceValid: trace ? traceFaults.length === 0 : null },
      raw: { writes, durableBoundaries: [...durableAtNsBySeq], clipResponses: clips?.responses ?? [],
        interfaceAttempts: attempts.map(a => ({ requestId: a.requestId, key: a.expected.key,
          routeKey: a.expected.routeKey, language: a.expected.language, sizeClass: a.expected.sizeClass,
          startedAtNs: a.startedAtNs, completedAtNs: a.completedAtNs, httpStatus: a.httpStatus,
          body: a.body, error: a.error, plannedAbortMs: a.plannedAbortMs, freshnessByPath: a.freshnessByPath })),
        ...trace ? { admissionTraces: trace.assembly.traces, traceFaults, phaseTimings: trace.observed.phases,
          startupCensoredProcesses: trace.startup.censored,
          clipCacheBypasses: trace.assembly.clipCacheBypasses,
          lifecycleEvents: trace.observed.events.filter(event => ['task-finished', 'parser-request', 'process-start',
            'process-use', 'process-retire', 'process-exit', 'process-spawn-failed'].includes(event.kind)) } : {} } };
  } finally {
    signal.removeEventListener('abort', stopLoad);
    if (!hostStopped) await host.stop().catch(() => {});
    await Promise.allSettled([clipLoad?.stop(), interfaceLoad?.stop()]);
    off?.();
    await server?.close().catch(() => {});
    await session?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

const WITNESS_ARMS: Arm[] = ['clip-only', 'interface-only', 'combined'];
const LARGE_LOG_REQUESTS = 3;
/** Longest an aborted arm's own bounded steps take to finish: writer, drain, load stop and child check. */
const ARM_SETTLE_MS = 60_000;

export function largeLogOutcome(attempt: InterfaceAttempt): { outcome: 'ready-complete' | 'explicit-timeout' | 'unexplained';
  faults: string[] } {
  const body = attempt.body as { status?: string; fallback_reason?: string; page?: { complete?: boolean };
    files?: Array<{ status?: string }> } | null;
  const faults = attempt.httpStatus === 200 ? validateInterfacePage(attempt.body, attempt.expected)
    : [`large-log request failed: ${attempt.httpStatus ?? attempt.error}`];
  // The probe's one row has a known change; an identical or partial answer is not a comparison.
  const outcome = body?.status === 'ready' && body.page?.complete === true && body.files?.length === 1
    && body.files[0]!.status === 'ready' ? 'ready-complete'
    : body?.fallback_reason === 'timeout' ? 'explicit-timeout' : 'unexplained';
  if (attempt.httpStatus === 200 && outcome === 'unexplained')
    faults.push(`unexplained large-log outcome ${body?.status}/${body?.fallback_reason}`);
  return { outcome, faults };
}

/** Each request uses a fresh untraced reader, so every page is a cold retention scan of the large log. */
async function runLargeLogProbe(storeDir: string, page: CorpusPage, config: FD5Config, signal: AbortSignal) {
  const results = [];
  for (let i = 0; i < LARGE_LOG_REQUESTS; i++) {
    signal.throwIfAborted();
    const server = await startReaderServer({ storeDir, interfaceDeadlineMs: config.admission.interfaceDeadlineMs,
      projectionAdmissionConfig: { C: config.admission.C, Q: config.admission.Q, W: config.admission.W, D: config.admission.clipDeadlineMs } });
    let attempt: InterfaceAttempt;
    try { attempt = await requestInterface(server.url, server.token, page); } finally { await server.close(); }
    results.push({ ...largeLogOutcome(attempt), httpStatus: attempt.httpStatus, durationMs:
      attempt.completedAtNs === undefined ? null : Number(attempt.completedAtNs - attempt.startedAtNs) / 1e6, body: attempt.body });
  }
  return { restoredPaths: LARGE_LOG_RESTORED_PATHS, valid: results.every(result => result.faults.length === 0), results };
}

export async function runFD5(config: FD5Config, outputPath: string): Promise<void> {
  const approvalFaults = campaignApprovalFaults(config);
  if (approvalFaults.length) throw new Error(`owner execution decisions are incomplete: ${approvalFaults.join('; ')}`);
  const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const parentRepository = resolve(repository, '../..');
  const output = resolve(outputPath);
  const outputParent = await realpath(dirname(output));
  const realOutput = join(outputParent, basename(output));
  const within = (root: string): boolean => {
    const candidate = process.platform === 'darwin' ? realOutput.toLowerCase() : realOutput;
    const base = process.platform === 'darwin' ? root.toLowerCase() : root;
    return candidate === base || candidate.startsWith(base + sep);
  };
  if (within(repository) || within(parentRepository)) throw new Error('FD5 output must be outside both worktrees');
  if (execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim())
    throw new Error('FD5 measurement requires a clean committed harness');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const configSha256 = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const parserArtifacts = { typescript: createHash('sha256').update(verifyTypeScriptGrammarArtifact('typescript')).digest('hex'),
    tsx: createHash('sha256').update(verifyTypeScriptGrammarArtifact('tsx')).digest('hex'), swift: SWIFT_V1 };
  const journal = new Journal(await open(output, 'ax', 0o600));
  let storeDir: string | undefined;
  const reports: Array<Omit<Awaited<ReturnType<typeof runArm>>, 'raw'>> = [];
  try {
    await journal.record({ type: 'started', revision, config, configSha256,
      node: process.version, platform: process.platform, osRelease: release(), arch: arch(), cpu: cpus()[0]?.model,
      parserArtifacts }, true);
    await journal.assertHealthy();
    await preflight(config.host, windowEndUtc(config), journal);
    storeDir = await mkdtemp(join(tmpdir(), 'slip-fd5-store-'));
    const corpusDir = storeDir;
    // Both builders stop on the cap and settle before the store can be removed.
    const [clipCorpus, interfaceCorpus] = await runCapped(config.maxPreparationSeconds, ARM_SETTLE_MS, async signal => [
      await createHistoricalCorpus(corpusDir, config.clipCorpusChanges, signal),
      await createInterfaceCorpus(corpusDir, config.interfaceCorpusPages, config.seed, corpusPlan, signal),
    ] as const);
    const schedule = [
      ...[0, 1, 2].flatMap(repetition => rotations[repetition]!.map(arm => ({ arm, repetition, traced: false }))),
      ...WITNESS_ARMS.map(arm => ({ arm, repetition: 3, traced: true })),
    ];
    const requireApproval = (): void => {
      const faults = campaignApprovalFaults(config);
      if (faults.length) throw new Error(`approval no longer holds: ${faults.join('; ')}`);
    };
    for (const { arm, repetition, traced } of schedule) {
      requireApproval();
      const report = await runCapped(config.maxArmSeconds, ARM_SETTLE_MS, (signal, veto) => runArm(arm, repetition,
        storeDir!, clipCorpus, interfaceCorpus, config, traced, journal, signal, veto));
      const { raw: _raw, ...summary } = report;
      reports.push(summary);
      await journal.record({ type: 'arm', report }, true);
      await journal.assertHealthy();
      process.stderr.write(encode({ completed: `${traced ? 'witness ' : ''}${arm} repetition ${repetition + 1}`,
        capture: report.capture, interface: report.interface }) + '\n');
      // A host veto or a leftover child changes the machine under every later arm: stop, never rerun.
      if (report.host.faults.length) throw new Error(`host veto during ${arm}: ${report.host.faults.join(', ')}`);
      if (!report.cleanup.childProcessesExited) throw new Error(`child processes remained after ${arm}`);
    }
    requireApproval();
    const largeLogDir = join(storeDir, 'large-log');
    const largeLog = await runCapped(config.maxPreparationSeconds + LARGE_LOG_REQUESTS * (DRAIN_TIMEOUT_MS + 5_000) / 1000,
      ARM_SETTLE_MS, async (signal, veto) => {
        const host = monitorHost(config.host, windowEndUtc(config), journal,
          fault => veto(new Error(`host veto during large-log probe: ${fault}`)));
        try {
          const page = await createLargeLogProbe(largeLogDir);
          signal.throwIfAborted();
          return await runLargeLogProbe(largeLogDir, page, config, signal);
        } finally { await host.stop(); }
      });
    await journal.record({ type: 'large-log', largeLog }, true);
    await journal.assertHealthy();
    const registered = reports.filter(r => !r.traced);
    const comparisons = registered.filter(r => r.arm !== 'baseline').map(report => {
      const baseline = registered.find(r => r.arm === 'baseline' && r.repetition === report.repetition)!;
      const sufficient = (report.arm === 'interface-only' ? true : report.capture.load.sufficient)
        && (report.arm === 'clip-only' ? true : (report.interface?.sufficient ?? false));
      const runLevelReasons = [baseline, report].flatMap(r => [
        ...(!r.cleanup.quietDrainObserved ? [`${r.arm} quiet drain timed out`] : []),
        ...(!r.cleanup.childProcessesExited ? [`${r.arm} child processes remained`] : []),
      ]);
      return compareCaptureToBaseline(baseline.capture, report.capture, report.arm, report.repetition, sufficient, runLevelReasons);
    });
    const witnesses = reports.filter(r => r.traced).map(r => {
      const reasons = [
        ...(r.arm !== 'interface-only' && !r.capture.load.sufficient ? r.capture.load.reasons.map(reason => `clip: ${reason}`) : []),
        ...(r.arm !== 'clip-only' && !r.interface?.sufficient ? (r.interface?.reasons ?? ['no interface report']).map(reason => `interface: ${reason}`) : []),
        ...r.witnessFaults,
        ...(r.cleanup.processExitsVerified !== true ? ['actual process exits unverified'] : []),
        ...(r.cleanup.traceEvidenceValid !== true ? ['trace evidence invalid'] : []),
      ];
      return { arm: r.arm, valid: reasons.length === 0, reasons, diagnosticCapture: r.capture };
    });
    const measuredGatesPass = comparisons.length === 9 && comparisons.every(c => c.passed)
      && witnesses.length === 3 && witnesses.every(w => w.valid) && largeLog.valid
      && reports.every(r => r.cleanup.captureStopCompleted && r.cleanup.quietDrainObserved
        && r.cleanup.readerClosed && r.cleanup.worktreeRemoved && r.cleanup.childProcessesExited);
    const outstandingEvidence = ['coalesced clip W pressure measurement',
      'owner-approved timeout and useful-throughput rates', 'owner-approved large-log outcome', 'owner-approved D7 configuration'];
    await journal.record({ type: 'final', comparisons, witnesses, largeLog: { valid: largeLog.valid,
      outcomes: largeLog.results.map(result => result.outcome) }, measuredGatesPass,
      tracingOverhead: 'failed 2026-09-29 at a150731 and not rerun; traced capture latency is diagnostic only',
      d7Decision: 'pending', outstandingEvidence,
      measurementStatus: measuredGatesPass ? 'further evidence required' : 'invalid: missing or failed evidence' }, true);
    await journal.assertHealthy();
  } catch (error) {
    await journal.record({ type: 'failed', error: String(error), completedArms: reports.length }, true);
    throw error;
  } finally {
    if (storeDir) await rm(storeDir, { recursive: true, force: true });
    await journal.close();
  }
}

async function main(): Promise<void> {
  const [configFlag, configPath, outFlag, outPath] = process.argv.slice(2);
  if (configFlag !== '--config' || !configPath || outFlag !== '--out' || !outPath)
    throw new Error('Usage: npm run bench:fd5 -- --config <explicit.json> --out <new report.json>');
  const config = validateConfig(JSON.parse(await readFile(resolve(configPath), 'utf8')));
  await runFD5(config, resolve(outPath));
}
if (isMainThread && process.argv[1] && isMainModule(import.meta.url, process.argv[1])) await main();
