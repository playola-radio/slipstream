/** Pure FD5 evidence scorer. A ready HTTP page is not proof of admitted or fresh work. */
import { isDeepStrictEqual } from 'node:util';
import { scoreCaptureArm } from '../src/clip-bench.ts';

export type Language = 'typescript' | 'tsx' | 'swift';
export type AdmissionOutcome = 'ok' | 'timeout' | 'overloaded' | 'cancelled' | 'closed' | 'error';
/** Frozen test-only FD4 observer wire shape; see .context/fd5-trace-seam-handoff.md. */
export type ProjectionTraceEvent =
  | { kind: 'admission'; unitId: number; routeKey: string; workload: 'interface' | 'clip';
      atNs: bigint; disposition: 'running' | 'queued' | 'waiting' | 'overloaded' }
  | { kind: 'dispatch'; unitId: number; atNs: bigint }
  | { kind: 'settle'; unitId: number; atNs: bigint;
      priorState: 'running' | 'queued' | 'waiting' | 'overloaded'; outcome: AdmissionOutcome }
  | { kind: 'interface-file'; routeKey: string; path: string; atNs: bigint;
      freshness: 'fresh' | 'cache-hit' | 'none'; resultStatus: string };
export interface AdmissionTrace {
  unitId: number;
  routeKey: string;
  workload: 'clip' | 'interface';
  submittedAtNs: bigint;
  admittedAtNs?: bigint;
  startedAtNs?: bigint;
  settledAtNs: bigint;
  outcome: AdmissionOutcome;
  /** True only after the owned compute actually exited following cancellation. */
  exitedAtNs?: bigint;
}
export interface ExpectedFile {
  path: string;
  language: 'typescript' | 'swift';
  languageVersion: string;
  beforeSha256: string;
  afterSha256: string;
  beforeRecordSeq: string;
  afterRecordSeq: string;
  /** Expected complete structured changes, from a hand-specified fixture. */
  changes: unknown[];
}
export interface ExpectedInterfaceRequest {
  key: string;
  /** Raw HTTP request target; repeated overload retries share this route key. */
  routeKey: string;
  language: Language;
  sizeClass: 'tiny' | 'representative';
  sessionId: string;
  beforeSeq: string;
  afterSeq: string;
  files: ExpectedFile[];
}
export interface InterfaceAttempt {
  requestId: string;
  expected: ExpectedInterfaceRequest;
  startedAtNs: bigint;
  completedAtNs?: bigint;
  httpStatus?: number;
  body?: unknown;
  error?: string;
  /** Test-only per-file service observations, never inferred from HTTP readiness. */
  freshnessByPath?: Record<string, 'fresh' | 'cache-hit' | 'none'>;
}
export function assembleProjectionTrace(events: ProjectionTraceEvent[], attempts: InterfaceAttempt[]):
  { traces: AdmissionTrace[]; attempts: InterfaceAttempt[]; faults: string[] } {
  const faults: string[] = [];
  const units = new Map<number, { trace: Partial<AdmissionTrace>; disposition: 'running' | 'queued' | 'waiting' | 'overloaded'; settled: boolean }>();
  const joinedAttempts = attempts.map(a => ({ ...a, freshnessByPath: { ...a.freshnessByPath } }));
  for (const event of events) {
    if (event.kind === 'admission') {
      if (units.has(event.unitId)) { faults.push('duplicate admission unit'); continue; }
      units.set(event.unitId, { disposition: event.disposition, settled: false,
        trace: { unitId: event.unitId, routeKey: event.routeKey, workload: event.workload,
          submittedAtNs: event.atNs,
          ...(event.disposition === 'overloaded' ? {} : { admittedAtNs: event.atNs }),
          ...(event.disposition === 'running' ? { startedAtNs: event.atNs } : {}) } });
    } else if (event.kind === 'dispatch') {
      const unit = units.get(event.unitId);
      if (!unit || unit.settled || unit.disposition !== 'queued' || unit.trace.startedAtNs !== undefined) {
        faults.push('invalid admission dispatch'); continue;
      }
      unit.trace.startedAtNs = event.atNs;
    } else if (event.kind === 'settle') {
      const unit = units.get(event.unitId);
      if (!unit || unit.settled || (unit.disposition === 'overloaded' && event.outcome !== 'overloaded')) {
        faults.push('invalid admission settlement'); continue;
      }
      const state = unit.disposition === 'queued' && unit.trace.startedAtNs !== undefined ? 'running' : unit.disposition;
      if (event.priorState !== state) faults.push('admission settlement state mismatch');
      unit.trace.settledAtNs = event.atNs;
      unit.trace.outcome = event.outcome;
      unit.settled = true;
    } else {
      const candidates = joinedAttempts.filter(a => a.expected.routeKey === event.routeKey
        && a.startedAtNs <= event.atNs && event.atNs <= (a.completedAtNs ?? -1n));
      if (candidates.length !== 1) { faults.push('interface-file event has no unique HTTP attempt'); continue; }
      const target = candidates[0]!;
      if (!target.expected.files.some(f => f.path === event.path)) { faults.push('interface-file event names unexpected path'); continue; }
      if (target.freshnessByPath?.[event.path] !== undefined) { faults.push('duplicate interface-file event'); continue; }
      target.freshnessByPath![event.path] = event.freshness;
    }
  }
  const traces: AdmissionTrace[] = [];
  for (const unit of units.values()) {
    if (!unit.settled) { faults.push('admission unit has no settlement'); continue; }
    traces.push(unit.trace as AdmissionTrace);
  }
  return { traces, attempts: joinedAttempts, faults };
}
export interface InterfaceLoadInput {
  attempts: InterfaceAttempt[];
  traces: AdmissionTrace[];
  corpusKeys: string[];
  maxConcurrentRequests: number;
  freshServer: boolean;
  loadStartedAtNs: bigint;
  loadStoppedAtNs: bigint;
  firstWriteAtNs: bigint;
  lastDurableAtNs: bigint;
  corpusExhausted: boolean;
  attemptLimitReached: boolean;
  drained: boolean;
  cleanupComplete: boolean;
}
type Counts = { submitted: number; rejected: number; admitted: number; queueTimeout: number;
  runningTimeout: number; cancelled: number; hostFailure: number; completedPages: number;
  completedFiles: number; usefulComparisons: number; cacheHits: number; unclassified: number;
  admittedTimeoutFraction: number | null; overloadFraction: number; usefulPerSecond: number };
const emptyCounts = (): Counts => ({ submitted: 0, rejected: 0, admitted: 0, queueTimeout: 0,
  runningTimeout: 0, cancelled: 0, hostFailure: 0, completedPages: 0, completedFiles: 0,
  usefulComparisons: 0, cacheHits: 0, unclassified: 0, admittedTimeoutFraction: null,
  overloadFraction: 0, usefulPerSecond: 0 });
const object = (x: unknown): Record<string, unknown> | null => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);
const sha = (x: unknown): string | null => {
  const endpoint = object(x);
  const snapshot = object(endpoint?.snapshot);
  return snapshot?.kind === 'content' && typeof snapshot.sha256 === 'string' ? snapshot.sha256 : null;
};

/** Returns all validation faults; never silently accepts a subset of a page. */
export function validateInterfacePage(body: unknown, expected: ExpectedInterfaceRequest): string[] {
  const faults: string[] = [];
  const page = object(body);
  if (!page) return ['response is not a JSON object'];
  if (page.projection_version !== 'interface.v2') faults.push('projection version mismatch');
  if (page.session_id !== expected.sessionId) faults.push('session mismatch');
  const range = object(page.range);
  if (range?.before_seq !== expected.beforeSeq || range?.after_seq !== expected.afterSeq) faults.push('range mismatch');
  if (!['ready', 'partial', 'skipped'].includes(String(page.status))) faults.push('invalid page status');
  if (!object(page.analysis) || typeof page.gaps_complete !== 'boolean'
    || (page.inventory !== null && !object(page.inventory)) || (page.gaps !== null && !Array.isArray(page.gaps)))
    faults.push('invalid page metadata');
  if (page.status === 'skipped' && typeof page.fallback_reason !== 'string') faults.push('skipped page lacks reason');
  if (!Array.isArray(page.files)) return [...faults, 'files is not an array'];
  const byPath = new Map(expected.files.map(f => [f.path, f]));
  const seen = new Set<string>();
  for (const raw of page.files) {
    const file = object(raw);
    if (!file || typeof file.path !== 'string') { faults.push('invalid file row'); continue; }
    if (seen.has(file.path)) faults.push(`duplicate file ${file.path}`);
    seen.add(file.path);
    const want = byPath.get(file.path);
    if (!want) { faults.push(`unexpected file ${file.path}`); continue; }
    if (sha(file.before) !== want.beforeSha256 || sha(file.after) !== want.afterSha256) faults.push(`source mismatch ${file.path}`);
    const before = object(file.before), after = object(file.after);
    if (before?.kind !== 'recorded' || before.record_seq !== want.beforeRecordSeq || before.field !== 'snapshot'
      || after?.kind !== 'recorded' || after.record_seq !== want.afterRecordSeq || after.field !== 'after'
      || after.observation !== 'watcher') faults.push(`source provenance mismatch ${file.path}`);
    if (file.language !== want.language || file.language_version !== want.languageVersion) faults.push(`language/version mismatch ${file.path}`);
    if (file.status === 'ready') {
      if (!Array.isArray(file.changes) || !same(file.changes, want.changes)) faults.push(`change mismatch ${file.path}`);
    } else if (!['identical', 'incomplete', 'unavailable', 'unsupported', 'skipped'].includes(String(file.status))) {
      faults.push(`invalid file status ${file.path}`);
    }
  }
  // A complete ready page is an exhaustive claim. Interrupted pages retain only a prefix.
  if (page.status === 'ready' && object(page.page)?.complete === true) {
    for (const path of byPath.keys()) if (!seen.has(path)) faults.push(`missing file ${path}`);
    if (object(page.page)?.complete === true)
      for (const raw of page.files) if (object(raw)?.status !== 'ready') faults.push(`complete page has non-ready file ${String(object(raw)?.path)}`);
  }
  const pagination = object(page.page);
  if (!pagination || typeof pagination.complete !== 'boolean'
    || (pagination.next_after_path !== null && typeof pagination.next_after_path !== 'string')
    || (pagination.complete === true && pagination.next_after_path !== null)) faults.push('invalid pagination');
  return faults;
}

export interface InterfaceLoadReport {
  sufficient: boolean;
  reasons: string[];
  byLanguage: Record<Language, Counts>;
  total: Counts;
  activityWindows: Array<{ ready: number; overloaded: number }>;
  continuousRequests: boolean;
  malformedResponses: number;
  timeoutWithoutHttpReason: number;
}

/** Admission evidence is mandatory. HTTP errors and partial pages cannot classify a denominator. */
export function scoreInterfaceLoad(input: InterfaceLoadInput): InterfaceLoadReport {
  const reasons: string[] = [];
  const byLanguage: Record<Language, Counts> = { typescript: emptyCounts(), tsx: emptyCounts(), swift: emptyCounts() };
  const total = emptyCounts();
  const interfaceTraces = input.traces.filter(t => t.workload === 'interface');
  const byRoute = new Map<string, AdmissionTrace[]>();
  const unitIds = new Set<number>();
  for (const trace of interfaceTraces) {
    if (unitIds.has(trace.unitId)) reasons.push('duplicate admission unit ID');
    unitIds.add(trace.unitId);
    const group = byRoute.get(trace.routeKey) ?? [];
    group.push(trace);
    byRoute.set(trace.routeKey, group);
  }
  const matched = new Map<string, AdmissionTrace>();
  const usedUnits = new Set<number>();
  const keys = new Set(input.corpusKeys);
  if (keys.size !== input.corpusKeys.length) reasons.push('cold corpus repeats a key');
  const ordered = [...input.attempts].sort((a, b) => a.startedAtNs < b.startedAtNs ? -1 : a.startedAtNs > b.startedAtNs ? 1 : 0);
  const prior = new Map<string, InterfaceAttempt>();
  const seenIds = new Set<string>();
  let malformedResponses = 0;
  let timeoutWithoutHttpReason = 0;
  for (const attempt of ordered) {
    const counts = byLanguage[attempt.expected.language];
    counts.submitted++; total.submitted++;
    const extension = attempt.expected.language === 'swift' ? '.swift'
      : attempt.expected.language === 'tsx' ? '.tsx' : '.ts';
    if (attempt.expected.files.some(file => !file.path.endsWith(extension)))
      reasons.push('page language label mixes file languages or extensions');
    if (seenIds.has(attempt.requestId)) reasons.push('duplicate request ID');
    seenIds.add(attempt.requestId);
    if (!keys.has(attempt.expected.key)) reasons.push('request key is outside cold corpus');
    const previous = prior.get(attempt.expected.key);
    if (previous) {
      const preceding = matched.get(previous.requestId);
      const priorPage = object(previous.body);
      if (preceding?.outcome !== 'overloaded' || priorPage?.status !== 'skipped' || priorPage.fallback_reason !== 'overloaded'
        || previous.completedAtNs === undefined || previous.completedAtNs > attempt.startedAtNs)
        reasons.push('cold key repeated without completed uncached overload');
    }
    prior.set(attempt.expected.key, attempt);
    const candidates = (byRoute.get(attempt.expected.routeKey) ?? []).filter(trace =>
      trace.submittedAtNs >= attempt.startedAtNs && trace.settledAtNs <= (attempt.completedAtNs ?? -1n));
    const trace = candidates.length === 1 ? candidates[0] : undefined;
    if (!trace || usedUnits.has(trace.unitId)) {
      counts.unclassified++; total.unclassified++;
      reasons.push('request lacks correlated admission outcome');
      continue;
    }
    matched.set(attempt.requestId, trace);
    usedUnits.add(trace.unitId);
    if (trace.settledAtNs < trace.submittedAtNs
      || (trace.admittedAtNs !== undefined && (trace.admittedAtNs < trace.submittedAtNs || trace.admittedAtNs > trace.settledAtNs))
      || (trace.startedAtNs !== undefined && (trace.admittedAtNs === undefined || trace.startedAtNs < trace.admittedAtNs || trace.startedAtNs > trace.settledAtNs)))
      reasons.push('admission trace timestamps are contradictory');
    if ((trace.outcome === 'overloaded' && (trace.admittedAtNs !== undefined || trace.startedAtNs !== undefined))
      || (trace.outcome !== 'overloaded' && trace.admittedAtNs === undefined))
      reasons.push('admission trace disposition contradicts outcome');
    if (trace.outcome === 'overloaded') { counts.rejected++; total.rejected++; }
    else if (trace.admittedAtNs !== undefined) { counts.admitted++; total.admitted++; }
    else { counts.unclassified++; total.unclassified++; reasons.push('trace has no admission disposition'); }
    if (trace.outcome === 'timeout') {
      if (trace.startedAtNs === undefined) { counts.queueTimeout++; total.queueTimeout++; }
      else { counts.runningTimeout++; total.runningTimeout++; }
    }
    if (trace.outcome === 'cancelled') { counts.cancelled++; total.cancelled++; }
    if (trace.outcome === 'error' || attempt.error || attempt.httpStatus !== 200) {
      counts.hostFailure++; total.hostFailure++;
      reasons.push('HTTP or host failure');
    }
    if (trace.startedAtNs !== undefined && ['timeout', 'cancelled', 'closed'].includes(trace.outcome) && trace.exitedAtNs === undefined)
      reasons.push('cancelled compute has no actual exit');
    if (attempt.httpStatus === 200) {
      const faults = validateInterfacePage(attempt.body, attempt.expected);
      if (faults.length) { malformedResponses++; reasons.push(...faults); continue; }
      const page = object(attempt.body)!;
      const rows = page.files as Record<string, unknown>[];
      if (page.status === 'ready' && object(page.page)?.complete === true) { counts.completedPages++; total.completedPages++; }
      for (const row of rows) if (row.status === 'ready') { counts.completedFiles++; total.completedFiles++; }
      const cacheHits = rows.filter(row => attempt.freshnessByPath?.[String(row.path)] === 'cache-hit').length;
      counts.cacheHits += cacheHits; total.cacheHits += cacheHits;
      if (trace.startedAtNs !== undefined && trace.outcome === 'ok') {
        const useful = rows.filter(row => row.status === 'ready' && Array.isArray(row.changes)
          && row.changes.length > 0 && attempt.freshnessByPath?.[String(row.path)] === 'fresh').length;
        counts.usefulComparisons += useful; total.usefulComparisons += useful;
      }
      // Partial rows may already be ready, but the request timed out in look-ahead.
      if (trace.outcome === 'timeout' && page.fallback_reason !== 'timeout' && !rows.some(row => row.fallback_reason === 'timeout'))
        timeoutWithoutHttpReason++;
      if (trace.outcome === 'timeout' && object(page.page)?.complete === true)
        reasons.push('timed-out request claims complete page');
      if (trace.outcome === 'overloaded' && (page.status !== 'skipped' || page.fallback_reason !== 'overloaded'))
        reasons.push('overload trace disagrees with HTTP page');
    }
  }
  if (input.attempts.length !== interfaceTraces.length || usedUnits.size !== interfaceTraces.length)
    reasons.push('admission trace count differs from request count');
  const duration = Number(input.lastDurableAtNs - input.firstWriteAtNs) / 1e9;
  for (const counts of [...Object.values(byLanguage), total]) {
    counts.admittedTimeoutFraction = counts.admitted ? (counts.queueTimeout + counts.runningTimeout) / counts.admitted : null;
    counts.overloadFraction = counts.submitted ? counts.rejected / counts.submitted : 0;
    counts.usefulPerSecond = duration > 0 ? counts.usefulComparisons / duration : 0;
  }
  if (input.maxConcurrentRequests < 16) reasons.push('fewer than 16 request slots active');
  if (!input.freshServer) reasons.push('reader server was not fresh');
  if (input.corpusExhausted) reasons.push('cold corpus exhausted');
  if (input.attemptLimitReached || input.attempts.length >= 100_000) reasons.push('100000-attempt guard reached');
  if (!input.drained) reasons.push('capture drain failed');
  if (!input.cleanupComplete) reasons.push('resource cleanup unproven');
  if (input.loadStartedAtNs > input.firstWriteAtNs || input.loadStoppedAtNs < input.lastDurableAtNs)
    reasons.push('load did not span first write through durable drain');
  if (byLanguage.typescript.usefulComparisons === 0 || byLanguage.tsx.usefulComparisons === 0 || byLanguage.swift.usefulComparisons === 0)
    reasons.push('one or more languages had no useful fresh comparison');
  if (total.rejected === total.submitted) reasons.push('overload-only load did no work');
  const intervals = ordered.filter(a => a.completedAtNs !== undefined);
  let covered = input.firstWriteAtNs;
  for (const attempt of intervals) {
    if (attempt.startedAtNs > covered) break;
    if (attempt.completedAtNs! > covered) covered = attempt.completedAtNs!;
  }
  const continuousRequests = covered >= input.lastDurableAtNs;
  if (!continuousRequests) reasons.push('request intervals do not continuously cover capture');
  const activityWindows: InterfaceLoadReport['activityWindows'] = [];
  if (input.lastDurableAtNs > input.firstWriteAtNs) {
    const span = input.lastDurableAtNs - input.firstWriteAtNs;
    const windows = Math.max(1, Math.floor(Number(span) / 1e9));
    for (let i = 0; i < windows; i++) {
      const start = input.firstWriteAtNs + span * BigInt(i) / BigInt(windows);
      const end = input.firstWriteAtNs + span * BigInt(i + 1) / BigInt(windows);
      activityWindows.push({
        ready: intervals.filter(a => a.startedAtNs >= start && a.completedAtNs! <= end
          && matched.get(a.requestId)?.outcome === 'ok'
          && object(a.body)?.status === 'ready' && object(object(a.body)?.page)?.complete === true
          && (object(a.body)?.files as unknown[] | undefined)?.some(row => object(row)?.status === 'ready'
            && a.freshnessByPath?.[String(object(row)?.path)] === 'fresh' && (object(row)?.changes as unknown[] | undefined)?.length)).length,
        overloaded: intervals.filter(a => a.completedAtNs! >= start && a.completedAtNs! < end && matched.get(a.requestId)?.outcome === 'overloaded').length,
      });
    }
  }
  if (!activityWindows.length || activityWindows.some(w => !w.ready || !w.overloaded)) reasons.push('window lacked fresh ready comparison or overload');
  return { sufficient: reasons.length === 0, reasons: [...new Set(reasons)], byLanguage, total,
    activityWindows, continuousRequests, malformedResponses, timeoutWithoutHttpReason };
}

export interface FD5CaptureComparison {
  arm: string; repetition: number; passed: boolean; reasons: string[];
  latencyCells: Array<{ metric: 'latency' | 'scheduledLatency' | 'burstLatency'; percentile: 'p50' | 'p99';
    baseline: number | null; loaded: number | null; maximum: number | null; passed: boolean }>;
  throughputCell: { baseline: number; loaded: number; minimum: number; passed: boolean };
}
export function compareCaptureToBaseline(baseline: ReturnType<typeof scoreCaptureArm>, loaded: ReturnType<typeof scoreCaptureArm>,
  arm: string, repetition: number, loadSufficient: boolean, runLevelReasons: string[] = []): FD5CaptureComparison {
  const reasons: string[] = [];
  if (!loadSufficient) reasons.push('load insufficient');
  reasons.push(...runLevelReasons);
  for (const report of [baseline, loaded]) {
    if (report.written !== 200 || report.scheduledLatency.n !== 100 || report.burstLatency.n !== 100)
      reasons.push('arm did not produce 100 scheduled and 100 burst durable writes');
  }
  if (baseline.missing || loaded.missing) reasons.push('missing writes');
  const latencyCells: FD5CaptureComparison['latencyCells'] = [];
  for (const name of ['latency', 'scheduledLatency', 'burstLatency'] as const) {
    for (const percentile of ['p50', 'p99'] as const) {
      const base = baseline[name][percentile], value = loaded[name][percentile];
      const passed = base !== null && value !== null && Number.isFinite(base) && Number.isFinite(value) && value <= base * 1.20;
      latencyCells.push({ metric: name, percentile, baseline: base, loaded: value,
        maximum: base === null ? null : base * 1.20, passed });
      if (!passed) reasons.push(`${name}.${percentile} exceeds 1.20x baseline or lacks samples`);
    }
  }
  const throughputCell = { baseline: baseline.throughputPerSecond, loaded: loaded.throughputPerSecond,
    minimum: baseline.throughputPerSecond * 0.95,
    passed: Number.isFinite(baseline.throughputPerSecond) && Number.isFinite(loaded.throughputPerSecond)
      && loaded.throughputPerSecond >= baseline.throughputPerSecond * 0.95 };
  if (!throughputCell.passed) reasons.push('throughput below 0.95x baseline');
  return { arm, repetition, passed: reasons.length === 0, reasons, latencyCells, throughputCell };
}
