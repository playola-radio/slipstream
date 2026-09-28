/** FD5 four-arm driver. Run only in an authorized measurement window. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { arch, cpus, release, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, Worker } from 'node:worker_threads';
import { isMainModule } from '../src/entrypoint.ts';
import { createCas } from '../src/cas.ts';
import { createLog } from '../src/log.ts';
import { startCapture, type CaptureSession } from '../src/session.ts';
import { startReaderServer } from '../src/http-reader.ts';
import { verifyTypeScriptGrammarArtifact } from '../src/interface-v2-typescript.ts';
import { SWIFT_V1 } from '../src/swift-interface.ts';
import { createHistoricalCorpus, hostSample, readRecords, runWriter, scoreCaptureArm,
  waitForQuietCapture, type BenchmarkConfig, type HistoricalChange, type LoadSummary } from '../src/clip-bench.ts';
import { compareCaptureToBaseline, scoreInterfaceLoad, type AdmissionTrace, type ExpectedFile,
  type ExpectedInterfaceRequest, type InterfaceAttempt, type InterfaceLoadInput } from './fd5-score.ts';

const MAX_ATTEMPTS = 100_000;
const DRAIN_TIMEOUT_MS = 15_000;
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
}
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
    || c.requestSlots !== 16 || a?.clipDeadlineMs !== 100)
    throw new Error('FD5 config cannot weaken the fixed B2 repetition, write, slot or clip deadline protocol');
  for (const value of [c.clipCorpusChanges, c.interfaceCorpusPages, a?.C, a?.interfaceDeadlineMs])
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('FD5 config has an invalid positive bound');
  for (const value of [a?.Q, a?.W])
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('FD5 config has an invalid queue/waiter bound');
  if ((c.clipCorpusChanges as number) < 8192 || (c.interfaceCorpusPages as number) < 8192)
    throw new Error('FD5 cold corpus must contain at least 8192 keys per workload');
  if ((a!.W as number) > (a!.Q as number)) throw new Error('W exceeds Q');
  if (typeof c.seed !== 'string' || !c.seed) throw new Error('FD5 config needs a fixed seed');
  return raw as FD5Config;
}

export interface CorpusPage { expected: ExpectedInterfaceRequest; limit: 1 | 4 | 16 }
interface Fixture { before: string; after: string; changes: unknown[]; extension: string; languageVersion: string }
async function fixture(name: string): Promise<Fixture> {
  const root = new URL(`../contracts/interface/v2/cases/${name}/`, import.meta.url);
  const history = JSON.parse(await readFile(new URL('history.json', root), 'utf8')) as { blobs: Record<string, string> };
  const expected = JSON.parse(await readFile(new URL('expected.json', root), 'utf8')) as { files: Array<{ before: { snapshot: { sha256: string } }; after: { snapshot: { sha256: string } }; changes: unknown[]; language_version: string }> };
  const file = expected.files[0]!;
  return { before: history.blobs[file.before.snapshot.sha256]!, after: history.blobs[file.after.snapshot.sha256]!,
    changes: file.changes, extension: name.startsWith('swift') ? 'swift' : 'ts', languageVersion: file.language_version };
}

/** Each page has immutable before/after cutoffs; a trailing comment makes every content key unique. */
export async function createInterfaceCorpus(storeDir: string, pageCount: number, seed = 'fd5-recovery-v1'): Promise<CorpusPage[]> {
  const cas = await createCas(join(storeDir, 'blobs'));
  const ts = await fixture('ts-return-change');
  const swift = await fixture('swift-labels-defaults-effects');
  const pages: CorpusPage[] = [];
  for (let index = 0; index < pageCount; index++) {
    const limit = [1, 4, 16][Math.floor(index / 3) % 3]! as 1 | 4 | 16;
    const pageLanguage = LANGUAGES[index % LANGUAGES.length]!;
    const sizeClass = Math.floor(index / 9) % 2 === 0 ? 'tiny' : 'representative';
    const idHex = createHash('sha256').update(`${seed}:session:${index}`).digest('hex');
    const sessionId = `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-4${idHex.slice(13, 16)}-8${idHex.slice(17, 20)}-${idHex.slice(20, 32)}`;
    await mkdir(join(storeDir, 'sessions', sessionId), { recursive: true, mode: 0o700 });
    const log = await createLog({ filePath: join(storeDir, 'sessions', sessionId, 'events.jsonl'), sessionId });
    try {
      await log.append({ type: 'slipstream.session.started.v1', occurred_at_ms: Date.now(),
        data: { root: '/synthetic-fd5-corpus', max_bytes: 1024 * 1024 } });
      const baselines: Array<Omit<ExpectedFile, 'afterRecordSeq'> & { beforeSize: number; afterSize: number }> = [];
      for (let j = 0; j < limit; j++) {
        const language = pageLanguage;
        const source = language === 'swift' ? swift : ts;
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
      const key = createHash('sha256').update(JSON.stringify(files.map(f => [f.beforeSha256, f.afterSha256, f.language, f.languageVersion]))).digest('hex');
      const routeKey = `/v1/sessions/${sessionId}/interfaces?${new URLSearchParams({ before_seq: baseline.seq,
        after_seq: lastSeq, limit: String(limit) })}`;
      pages.push({ limit, expected: { key, routeKey, language: pageLanguage, sizeClass, sessionId,
        beforeSeq: baseline.seq, afterSeq: lastSeq,
        files: files.map(({ beforeSize: _a, afterSize: _b, ...file }) => file) } });
    } finally { await log.close(); }
  }
  if (new Set(pages.map(p => p.expected.key)).size !== pages.length) throw new Error('FD5 corpus repeats a cold content key');
  return pages;
}

async function requestInterface(url: string, token: string, page: CorpusPage): Promise<InterfaceAttempt> {
  const startedAtNs = process.hrtime.bigint();
  const requestId = randomUUID();
  try {
    const response = await fetch(`${url}${page.expected.routeKey}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(DRAIN_TIMEOUT_MS) });
    const body: unknown = await response.json().catch(() => null);
    return { requestId, expected: page.expected, startedAtNs, completedAtNs: process.hrtime.bigint(),
      httpStatus: response.status, body };
  } catch (error) {
    return { requestId, expected: page.expected, startedAtNs, completedAtNs: process.hrtime.bigint(), error: String(error) };
  }
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
        if (body?.status !== 'skipped' || body.fallback_reason !== 'overloaded') page = undefined;
      } finally { active--; }
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
const encode = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
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
  let stopping: Promise<LoadSummary | InterfaceLoadSummary> | undefined;
  return { ready, stop: () => stopping ??= (async () => {
    await ready;
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
async function runArm(arm: Arm, repetition: number, storeDir: string, clipCorpus: Awaited<ReturnType<typeof createHistoricalCorpus>>,
  interfaceCorpus: CorpusPage[], config: FD5Config) {
  const root = await mkdtemp(join(tmpdir(), 'slip-fd5-wt-'));
  let session: CaptureSession | undefined;
  let server: Awaited<ReturnType<typeof startReaderServer>> | undefined;
  let clipLoad: { ready: Promise<void>; stop: () => Promise<LoadSummary> } | undefined;
  let interfaceLoad: { ready: Promise<void>; stop: () => Promise<InterfaceLoadSummary> } | undefined;
  let off: (() => void) | undefined;
  const hostBefore = hostSample();
  const durableAtNsBySeq = new Map<string, bigint>();
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
      interfaceDeadlineMs: config.admission.interfaceDeadlineMs });
    if (arm === 'clip-only' || arm === 'combined') clipLoad = startLoadWorker('clip', server.url, server.token, clipCorpus, config.requestSlots);
    if (arm === 'interface-only' || arm === 'combined') interfaceLoad = startLoadWorker('interface', server.url, server.token, interfaceCorpus, config.requestSlots);
    await Promise.all([clipLoad?.ready, interfaceLoad?.ready]);
    const writerConfig: BenchmarkConfig = { repetitions: config.repetitions, scheduledWrites: config.scheduledWrites,
      scheduledIntervalMs: config.scheduledIntervalMs, burstWrites: config.burstWrites,
      concurrentClipRequests: config.requestSlots, corpusChanges: config.clipCorpusChanges };
    const written = await runWriter(root, repetition, writerConfig);
    const drained = await waitForQuietCapture(session);
    await session.stop();
    const [clips, interfaces] = await Promise.all([clipLoad?.stop(), interfaceLoad?.stop()]);
    off(); off = undefined;
    const records = await readRecords(session.logPath);
    await server.close(); server = undefined;
    await rm(root, { recursive: true, force: true });
    const writes = written.map(item => ({ path: item.path, sha256: hash(item.body), startedAtNs: BigInt(item.startedAtNs), phase: item.phase }));
    const capture = scoreCaptureArm({ name: (clips ? 'saturation' : arm) + ` repetition ${repetition + 1}`,
      writes, records, durableAtNsBySeq, clipResponses: clips?.responses ?? [], requestedClipKeys: clips?.requested ?? [],
      concurrentClipRequests: clips ? config.requestSlots : 0, maxConcurrentRequests: clips?.maxConcurrentRequests,
      coldCacheServerFresh: Boolean(clips), loadStartedAtNs: clips?.startedAtNs, loadStoppedAtNs: clips?.stoppedAtNs,
      corpusExhausted: clips?.corpusExhausted, attemptLimitReached: clips?.attemptLimitReached, drainTimedOut: !drained });
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
      ...interfaces, traces: [] as AdmissionTrace[], corpusKeys: interfaceCorpus.map(c => c.expected.key),
      freshServer: true, loadStartedAtNs: interfaces.startedAtNs, loadStoppedAtNs: interfaces.stoppedAtNs,
      firstWriteAtNs: first, lastDurableAtNs: last, drained, cleanupComplete: false,
    } : undefined;
    const interfaceReport = interfaceInput ? scoreInterfaceLoad(interfaceInput) : null;
    return { arm, repetition: repetition + 1, host: { before: hostBefore, after: hostSample() },
      capture, interface: interfaceReport,
      cleanup: { captureStopCompleted: true, quietDrainObserved: drained, readerClosed: true,
        worktreeRemoved: true, processExitsVerified: false },
      raw: { writes, durableBoundaries: [...durableAtNsBySeq], clipResponses: clips?.responses ?? [],
        interfaceAttempts: interfaces?.attempts.map(a => ({ requestId: a.requestId, key: a.expected.key,
          routeKey: a.expected.routeKey, language: a.expected.language, sizeClass: a.expected.sizeClass,
          startedAtNs: a.startedAtNs, completedAtNs: a.completedAtNs, httpStatus: a.httpStatus,
          body: a.body, error: a.error, freshnessByPath: a.freshnessByPath })) ?? [],
        admissionTraces: [] as AdmissionTrace[] } };
  } finally {
    await Promise.allSettled([clipLoad?.stop(), interfaceLoad?.stop()]);
    off?.();
    await server?.close().catch(() => {});
    await session?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

export async function runFD5(config: FD5Config, outputPath: string): Promise<void> {
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
  const outputFile = await open(output, 'ax', 0o600);
  let storeDir: string | undefined;
  const reports: Array<Omit<Awaited<ReturnType<typeof runArm>>, 'raw'>> = [];
  try {
    await outputFile.appendFile(encode({ type: 'started', revision, config, configSha256,
      node: process.version, platform: process.platform, osRelease: release(), arch: arch(), cpu: cpus()[0]?.model,
      parserArtifacts }) + '\n');
    await outputFile.sync();
    storeDir = await mkdtemp(join(tmpdir(), 'slip-fd5-store-'));
    const clipCorpus = await createHistoricalCorpus(storeDir, config.clipCorpusChanges);
    const interfaceCorpus = await createInterfaceCorpus(storeDir, config.interfaceCorpusPages, config.seed);
    for (let repetition = 0; repetition < 3; repetition++) for (const arm of rotations[repetition]!) {
      const report = await runArm(arm, repetition, storeDir, clipCorpus, interfaceCorpus, config);
      const { raw, ...summary } = report;
      reports.push(summary);
      await outputFile.appendFile(encode({ type: 'arm', report }) + '\n');
      await outputFile.sync();
      process.stderr.write(encode({ completed: `${arm} repetition ${repetition + 1}`, capture: report.capture,
        interface: report.interface }) + '\n');
    }
    const comparisons = reports.filter(r => r.arm !== 'baseline').map(report => {
      const baseline = reports.find(r => r.arm === 'baseline' && r.repetition === report.repetition)!;
      const sufficient = (report.arm === 'interface-only' ? true : report.capture.load.sufficient)
        && (report.arm === 'clip-only' ? true : (report.interface?.sufficient ?? false));
      const runLevelReasons = [baseline, report].flatMap(r => [
        ...(!r.cleanup.quietDrainObserved ? [`${r.arm} quiet drain timed out`] : []),
        ...(!r.cleanup.processExitsVerified ? [`${r.arm} actual process exits unverified`] : []),
      ]);
      return compareCaptureToBaseline(baseline.capture, report.capture, report.arm, report.repetition, sufficient, runLevelReasons);
    });
    const measuredGatesPass = comparisons.length === 9 && comparisons.every(c => c.passed)
      && reports.every(r => r.cleanup.captureStopCompleted && r.cleanup.quietDrainObserved
        && r.cleanup.readerClosed && r.cleanup.worktreeRemoved && r.cleanup.processExitsVerified);
    const outstandingEvidence = ['bounded phase timing', 'trace overhead control', 'coalesced clip W diagnostic',
      'owner-approved timeout and useful-throughput rates', 'owner-approved D7 configuration'];
    await outputFile.appendFile(encode({ type: 'final', comparisons, measuredGatesPass,
      d7Decision: 'pending', outstandingEvidence,
      measurementStatus: measuredGatesPass ? 'further evidence required' : 'invalid: missing or failed evidence' }) + '\n');
    await outputFile.sync();
  } catch (error) {
    await outputFile.appendFile(encode({ type: 'failed', error: String(error), completedArms: reports.length }) + '\n');
    await outputFile.sync();
    throw error;
  } finally {
    if (storeDir) await rm(storeDir, { recursive: true, force: true });
    await outputFile.close();
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
