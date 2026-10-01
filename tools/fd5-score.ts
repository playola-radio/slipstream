/** Pure FD5 evidence scorer. A ready HTTP page is not proof of admitted or fresh work. */
import { isDeepStrictEqual } from 'node:util';
import { scoreCaptureArm } from '../src/clip-bench.ts';
import type { ClipResponse } from '../src/clip-bench.ts';
import type { ProjectionTraceEvent } from '../src/projection-trace.ts';

export type Language = 'typescript' | 'tsx' | 'swift';
export type AdmissionOutcome = 'ok' | 'timeout' | 'overloaded' | 'cancelled' | 'closed' | 'error';
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
  /** A parser process linked to this unit was alive when it was cancelled and then actually exited. */
  parserCancelled?: boolean;
}

function tracesWithin(group: AdmissionTrace[], start: bigint, end: bigint): AdmissionTrace[] {
  let low = 0, high = group.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (group[middle]!.submittedAtNs < start) low = middle + 1;
    else high = middle;
  }
  const matches: AdmissionTrace[] = [];
  for (let index = low; index < group.length && group[index]!.submittedAtNs <= end; index++) {
    if (group[index]!.settledAtNs <= end) matches.push(group[index]!);
    if (matches.length > 1) break; // ambiguity is already conclusive
  }
  return matches;
}

/** A cold clip HTTP attempt must have one real admission, never a response-cache bypass. */
export function scoreClipTrace(responses: ClipResponse[], traces: AdmissionTrace[],
  bypasses: Extract<ProjectionTraceEvent, { kind: 'clip-cache-bypass' }>[]): string[] {
  const faults: string[] = [];
  const clipTraces = traces.filter(trace => trace.workload === 'clip');
  const byRoute = new Map<string, AdmissionTrace[]>();
  for (const trace of clipTraces) {
    const group = byRoute.get(trace.routeKey) ?? [];
    group.push(trace);
    byRoute.set(trace.routeKey, group);
  }
  for (const group of byRoute.values()) group.sort((a, b) =>
    a.submittedAtNs < b.submittedAtNs ? -1 : a.submittedAtNs > b.submittedAtNs ? 1 : 0);
  const bypassByRoute = new Map<string, bigint[]>();
  for (const bypass of bypasses) {
    const times = bypassByRoute.get(bypass.routeKey) ?? [];
    times.push(bypass.atNs);
    bypassByRoute.set(bypass.routeKey, times);
  }
  const used = new Set<number>();
  for (const response of responses) {
    if (response.routeKey === undefined || response.startedAtNs === undefined || response.completedAtNs === undefined) {
      faults.push('clip response lacks route or interval evidence'); continue;
    }
    const candidates = tracesWithin(byRoute.get(response.routeKey) ?? [], response.startedAtNs, response.completedAtNs);
    if (candidates.length !== 1 || used.has(candidates[0]!.unitId)) {
      faults.push('clip request lacks unique admission outcome'); continue;
    }
    const trace = candidates[0]!;
    used.add(trace.unitId);
    if ((bypassByRoute.get(response.routeKey) ?? []).some(atNs =>
      atNs >= response.startedAtNs! && atNs <= response.completedAtNs!))
      faults.push('cold clip request bypassed admission cache');
    if (response.httpStatus !== 200 || response.error) faults.push('clip HTTP failure');
    if (response.status !== 'ready' && !(response.status === 'skipped'
      && (response.reason === 'overloaded' || response.reason === 'timeout')))
      faults.push('cold clip did not produce ready, overload or timeout');
    if (response.reason === 'overloaded' && trace.outcome !== 'overloaded'
      || trace.outcome === 'overloaded' && response.reason !== 'overloaded')
      faults.push('clip overload disagrees with admission');
    if (response.reason === 'timeout' && trace.outcome !== 'timeout'
      || trace.outcome === 'timeout' && response.reason !== 'timeout')
      faults.push('clip timeout disagrees with admission');
    if (response.status === 'ready' && (trace.outcome !== 'ok' || trace.startedAtNs === undefined))
      faults.push('ready clip lacks completed compute');
    if (trace.startedAtNs !== undefined && ['timeout', 'cancelled', 'closed'].includes(trace.outcome)
      && trace.exitedAtNs === undefined) faults.push('clip interrupted compute has no actual exit');
  }
  if (used.size !== clipTraces.length || responses.length !== clipTraces.length)
    faults.push('clip admission trace count differs from HTTP attempts');
  return [...new Set(faults)];
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
  /** A fixture that must never be reported ready, e.g. a parse failure. */
  incompleteReason?: string;
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
  variant?: 'unicode' | 'malformed';
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
  /** Set when the load client deliberately disconnects after this many milliseconds. */
  plannedAbortMs?: number;
}
/** The only error a planned client disconnect may record. */
export const PLANNED_ABORT = 'planned-abort';
export function assembleProjectionTrace(events: ProjectionTraceEvent[], attempts: InterfaceAttempt[]):
  { traces: AdmissionTrace[]; attempts: InterfaceAttempt[]; faults: string[];
    processExitsVerified: boolean; clipCacheBypasses: Extract<ProjectionTraceEvent, { kind: 'clip-cache-bypass' }>[];
    processUses: Array<{ unitId: number; processId: number }> } {
  const faults: string[] = [];
  const units = new Map<number, { trace: Partial<AdmissionTrace>; disposition: 'running' | 'queued' | 'waiting' | 'overloaded';
    settled: boolean; dispatched: boolean }>();
  const joinedAttempts = attempts.map(a => ({ ...a, freshnessByPath: { ...a.freshnessByPath } }));
  const attemptsByRoute = new Map<string, InterfaceAttempt[]>();
  for (const attempt of joinedAttempts) {
    const group = attemptsByRoute.get(attempt.expected.routeKey) ?? [];
    group.push(attempt);
    attemptsByRoute.set(attempt.expected.routeKey, group);
  }
  for (const group of attemptsByRoute.values()) {
    group.sort((a, b) => a.startedAtNs < b.startedAtNs ? -1 : a.startedAtNs > b.startedAtNs ? 1 : 0);
    let coveredThrough: bigint | undefined;
    for (const attempt of group) {
      if (coveredThrough !== undefined && attempt.startedAtNs <= coveredThrough)
        faults.push('same-route HTTP attempts overlap');
      const completed = attempt.completedAtNs ?? attempt.startedAtNs;
      if (coveredThrough === undefined || completed > coveredThrough) coveredThrough = completed;
    }
  }
  const finished = new Map<number, bigint>();
  const parserRequests = new Set<number>();
  const processes = new Map<number, { startedAtNs: bigint; exitedAtNs?: bigint; unitIds: Set<number> }>();
  // A process started for, or retired by, a unit belongs to that unit's parse rather than a shared pool.
  const ownedByUnit = new Map<number, Set<number>>();
  const own = (unitId: number, processId: number): void => {
    ownedByUnit.set(unitId, (ownedByUnit.get(unitId) ?? new Set()).add(processId));
  };
  const clipCacheBypasses: Extract<ProjectionTraceEvent, { kind: 'clip-cache-bypass' }>[] = [];
  const processUses: Array<{ unitId: number; processId: number }> = [];
  for (const event of events) {
    if (event.kind === 'admission') {
      if (units.has(event.unitId)) { faults.push('duplicate admission unit'); continue; }
      units.set(event.unitId, { disposition: event.disposition, settled: false, dispatched: false,
        trace: { unitId: event.unitId, routeKey: event.routeKey, workload: event.workload,
          submittedAtNs: event.atNs,
          ...(event.disposition === 'overloaded' ? {} : { admittedAtNs: event.atNs }),
        } });
    } else if (event.kind === 'dispatch') {
      const unit = units.get(event.unitId);
      if (!unit || unit.settled || unit.dispatched || !['running', 'queued'].includes(unit.disposition)) {
        faults.push('invalid admission dispatch'); continue;
      }
      unit.dispatched = true;
      unit.trace.startedAtNs = event.atNs;
    } else if (event.kind === 'settle') {
      const unit = units.get(event.unitId);
      if (!unit || unit.settled || (unit.disposition === 'overloaded' && event.outcome !== 'overloaded')) {
        faults.push('invalid admission settlement'); continue;
      }
      const state = unit.dispatched ? 'running' : unit.disposition;
      if (event.priorState !== state) faults.push('admission settlement state mismatch');
      unit.trace.settledAtNs = event.atNs;
      unit.trace.outcome = event.outcome;
      unit.settled = true;
    } else if (event.kind === 'interface-file') {
      const group = attemptsByRoute.get(event.routeKey) ?? [];
      let low = 0, high = group.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (group[middle]!.startedAtNs <= event.atNs) low = middle + 1;
        else high = middle;
      }
      const target = group[low - 1];
      // A planned disconnect has no response body; its completed rows remain lifecycle evidence.
      const planned = target?.error === PLANNED_ABORT;
      if (!target || !planned && event.atNs > (target.completedAtNs ?? -1n)) {
        faults.push('interface-file event has no unique HTTP attempt'); continue;
      }
      if (!target.expected.files.some(f => f.path === event.path)) { faults.push('interface-file event names unexpected path'); continue; }
      if (target.freshnessByPath?.[event.path] !== undefined) { faults.push('duplicate interface-file event'); continue; }
      const row = (object(target.body)?.files as unknown[] | undefined)?.find(raw => object(raw)?.path === event.path);
      if (!planned && object(row)?.status !== event.resultStatus) { faults.push('interface-file status disagrees with HTTP row'); continue; }
      target.freshnessByPath![event.path] = event.freshness;
    } else if (event.kind === 'task-finished') {
      if (!units.has(event.unitId) || finished.has(event.unitId)) faults.push('invalid task completion');
      else finished.set(event.unitId, event.atNs);
    } else if (event.kind === 'parser-request') {
      if (!units.has(event.unitId)) faults.push('invalid parser request');
      else parserRequests.add(event.unitId);
    } else if (event.kind === 'process-start') {
      if (processes.has(event.processId)) faults.push('duplicate process start');
      else {
        processes.set(event.processId, { startedAtNs: event.atNs,
          unitIds: new Set(event.unitId === undefined ? [] : [event.unitId]) });
        if (event.unitId !== undefined) {
          own(event.unitId, event.processId);
          if (!parserRequests.has(event.unitId)) faults.push('process started without parser request');
          processUses.push({ unitId: event.unitId, processId: event.processId });
        }
      }
    } else if (event.kind === 'process-use') {
      const process = processes.get(event.processId);
      if (!process || !units.has(event.unitId) || !parserRequests.has(event.unitId)
        || process.exitedAtNs !== undefined)
        faults.push('invalid process use');
      else { process.unitIds.add(event.unitId); processUses.push({ unitId: event.unitId, processId: event.processId }); }
    } else if (event.kind === 'process-retire') {
      const process = processes.get(event.processId);
      if (!process || !units.has(event.unitId) || process.exitedAtNs !== undefined)
        faults.push('invalid process retirement');
      else { process.unitIds.add(event.unitId); own(event.unitId, event.processId); }
    } else if (event.kind === 'process-exit') {
      const process = processes.get(event.processId);
      if (!process || process.exitedAtNs !== undefined || event.atNs < process.startedAtNs)
        faults.push('orphan or duplicate process exit');
      else process.exitedAtNs = event.atNs;
    } else if (event.kind === 'process-spawn-failed') {
      faults.push('reader process failed to spawn');
    } else if (event.kind === 'clip-cache-bypass') {
      clipCacheBypasses.push(event);
    } else if (event.kind === 'phase') {
      faults.push('phase event bypassed bounded collector');
    } else {
      event satisfies never;
      faults.push('unknown trace event');
    }
  }
  const traces: AdmissionTrace[] = [];
  const linkedByUnit = new Map<number, Array<{ exitedAtNs?: bigint }>>();
  for (const process of processes.values()) for (const unitId of process.unitIds) {
    const linked = linkedByUnit.get(unitId) ?? [];
    linked.push(process);
    linkedByUnit.set(unitId, linked);
  }
  for (const unit of units.values()) {
    if (!unit.settled) { faults.push('admission unit has no settlement'); continue; }
    if (unit.disposition === 'running' && !unit.dispatched) faults.push('running admission has no dispatch');
    if (unit.dispatched && !finished.has(unit.trace.unitId!)) faults.push('dispatched task has no completion');
    const linked = linkedByUnit.get(unit.trace.unitId!) ?? [];
    if (parserRequests.has(unit.trace.unitId!) && linked.length === 0)
      faults.push('parser request has no linked process');
    if (unit.dispatched && ['timeout', 'cancelled', 'closed'].includes(String(unit.trace.outcome))) {
      const taskAt = finished.get(unit.trace.unitId!);
      if (taskAt !== undefined && (!parserRequests.has(unit.trace.unitId!) || linked.length > 0)
        && linked.every(process => process.exitedAtNs !== undefined))
        unit.trace.exitedAtNs = linked.reduce((at, process) => process.exitedAtNs! > at ? process.exitedAtNs! : at, taskAt);
      const settledAt = unit.trace.settledAtNs!;
      const owned = [...ownedByUnit.get(unit.trace.unitId!) ?? []].map(id => processes.get(id)!);
      if (unit.trace.outcome === 'cancelled' && parserRequests.has(unit.trace.unitId!) && owned.some(process =>
        process.startedAtNs <= settledAt && process.exitedAtNs !== undefined && process.exitedAtNs >= settledAt))
        unit.trace.parserCancelled = true;
    }
    traces.push(unit.trace as AdmissionTrace);
  }
  for (const process of processes.values()) {
    if (process.exitedAtNs === undefined) faults.push('reader process has no actual exit');
    for (const unitId of process.unitIds) if (!units.has(unitId)) faults.push('process references unknown admission unit');
  }
  return { traces, attempts: joinedAttempts, faults,
    processExitsVerified: [...processes.values()].every(process => process.exitedAtNs !== undefined),
    clipCacheBypasses, processUses };
}

/** Startup samples are censored when cancellation kills a process before ready. */
export function scoreProcessStartupTiming(processUses: Array<{ unitId: number; processId: number }>,
  events: ProjectionTraceEvent[], processPhases: Map<number, Set<string>>, traces: AdmissionTrace[]):
  { faults: string[]; censored: number } {
  const faults: string[] = [];
  const starts = new Map(events.filter(event => event.kind === 'process-start')
    .map(event => [event.processId, event.process] as const));
  const exits = new Map(events.filter(event => event.kind === 'process-exit')
    .map(event => [event.processId, event] as const));
  const outcomes = new Map(traces.map(trace => [trace.unitId, trace.outcome] as const));
  const settledAt = new Map(traces.map(trace => [trace.unitId, trace.settledAtNs] as const));
  const usedByProcess = new Map<number, Set<number>>();
  for (const use of processUses) {
    const units = usedByProcess.get(use.processId) ?? new Set<number>();
    units.add(use.unitId);
    usedByProcess.set(use.processId, units);
  }
  let censored = 0;
  for (const [processId, unitIds] of usedByProcess) {
    const process = starts.get(processId);
    const startup = process === 'swift-child' ? 'swift:child-startup' : process === 'ts-worker'
      ? 'typescript:worker-startup' : process === 'clip-worker' ? 'clip:worker-startup' : undefined;
    if (startup && processPhases.get(processId)?.has(startup)) continue;
    const exit = exits.get(processId);
    const interrupted = [...unitIds].every(unitId => ['timeout', 'cancelled', 'closed'].includes(outcomes.get(unitId) ?? ''));
    const killed = exit && (exit.code !== 0 || exit.signal != null)
      && [...unitIds].every(unitId => exit.atNs >= (settledAt.get(unitId) ?? exit.atNs + 1n));
    if (startup && interrupted && killed) censored++;
    else faults.push(`used process ${processId} lacks startup timing`);
  }
  return { faults, censored };
}
export interface InterfaceLoadInput {
  attempts: InterfaceAttempt[];
  /** Null for an untraced arm: classification then rests on HTTP evidence alone. */
  traces: AdmissionTrace[] | null;
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
  admittedTimeoutFraction: number | null; overloadFraction: number; usefulPerSecond: number;
  validResponses: number; explicitTimeouts: number; unexplainedIncomplete: number;
  /** HTTP cannot tell a look-ahead timeout from other incompleteness, so it bounds the rate. */
  timeoutFractionBounds: { lower: number; upper: number } | null };
const emptyCounts = (): Counts => ({ submitted: 0, rejected: 0, admitted: 0, queueTimeout: 0,
  runningTimeout: 0, cancelled: 0, hostFailure: 0, completedPages: 0, completedFiles: 0,
  usefulComparisons: 0, cacheHits: 0, unclassified: 0, admittedTimeoutFraction: null,
  overloadFraction: 0, usefulPerSecond: 0, validResponses: 0, explicitTimeouts: 0,
  unexplainedIncomplete: 0, timeoutFractionBounds: null });
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
    if (want.incompleteReason !== undefined && file.status === 'ready') faults.push(`expected incomplete file reported ready ${file.path}`);
    else if (want.incompleteReason !== undefined && file.status === 'incomplete' && file.fallback_reason !== want.incompleteReason)
      faults.push(`incomplete reason mismatch ${file.path}`);
    else if (file.status === 'ready') {
      if (!Array.isArray(file.changes) || !same(file.changes, want.changes)) faults.push(`change mismatch ${file.path}`);
    } else if (!['identical', 'incomplete', 'unavailable', 'unsupported', 'skipped'].includes(String(file.status))) {
      faults.push(`invalid file status ${file.path}`);
    }
  }
  // A complete ready page is an exhaustive claim. Interrupted pages retain only a prefix.
  if (page.status === 'ready' && object(page.page)?.complete === true) {
    for (const path of byPath.keys()) if (!seen.has(path)) faults.push(`missing file ${path}`);
    for (const raw of page.files) if (!['ready', 'identical'].includes(String(object(raw)?.status)))
      faults.push(`complete page has non-ready file ${String(object(raw)?.path)}`);
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
  classification: 'trace' | 'http';
  plannedCancels: { planned: number; abortedBeforeResponse: number; respondedBeforeAbort: number;
    cancelledRunning: Record<'typescript' | 'swift', number> };
  variants: Record<string, { requested: number; handled: number }>;
}

const before = (a: InterfaceAttempt, b: InterfaceAttempt): number =>
  a.startedAtNs < b.startedAtNs ? -1 : a.startedAtNs > b.startedAtNs ? 1 : 0;
const isOverloadPage = (page: Record<string, unknown> | null): boolean =>
  page?.status === 'skipped' && page.fallback_reason === 'overloaded';
const hasExplicitTimeout = (page: Record<string, unknown>): boolean => page.fallback_reason === 'timeout'
  || (page.files as unknown[]).some(row => object(row)?.fallback_reason === 'timeout');

/**
 * With traces, admission evidence is mandatory and every HTTP outcome must agree with it.
 * Without traces, overload, work and timeouts are classified from validated HTTP pages only;
 * freshness then rests on the corpus construction (unique content per key on a fresh reader).
 * Planned client aborts never enter load denominators, windows or useful work.
 */
export function scoreInterfaceLoad(input: InterfaceLoadInput): InterfaceLoadReport {
  const reasons: string[] = [];
  const byLanguage: Record<Language, Counts> = { typescript: emptyCounts(), tsx: emptyCounts(), swift: emptyCounts() };
  const total = emptyCounts();
  const traced = input.traces !== null;
  const interfaceTraces = (input.traces ?? []).filter(t => t.workload === 'interface');
  const byRoute = new Map<string, AdmissionTrace[]>();
  const unitIds = new Set<number>();
  for (const trace of interfaceTraces) {
    if (unitIds.has(trace.unitId)) reasons.push('duplicate admission unit ID');
    unitIds.add(trace.unitId);
    const group = byRoute.get(trace.routeKey) ?? [];
    group.push(trace);
    byRoute.set(trace.routeKey, group);
  }
  for (const group of byRoute.values()) group.sort((a, b) =>
    a.submittedAtNs < b.submittedAtNs ? -1 : a.submittedAtNs > b.submittedAtNs ? 1 : 0);
  const matched = new Map<string, AdmissionTrace>();
  const usedUnits = new Set<number>();
  const keys = new Set(input.corpusKeys);
  if (keys.size !== input.corpusKeys.length) reasons.push('cold corpus repeats a key');
  const ordered = [...input.attempts].sort(before);
  const prior = new Map<string, InterfaceAttempt>();
  const seenIds = new Set<string>();
  const plannedCancels: InterfaceLoadReport['plannedCancels'] = { planned: 0, abortedBeforeResponse: 0,
    respondedBeforeAbort: 0, cancelledRunning: { typescript: 0, swift: 0 } };
  const variants: InterfaceLoadReport['variants'] = {};
  const overloaded = new Set<string>();
  const loadBearing: InterfaceAttempt[] = [];
  let plannedTraces = 0;
  let malformedResponses = 0;
  let timeoutWithoutHttpReason = 0;
  const requireExit = (trace: AdmissionTrace): void => {
    if (trace.startedAtNs !== undefined && ['timeout', 'cancelled', 'closed'].includes(trace.outcome) && trace.exitedAtNs === undefined)
      reasons.push('cancelled compute has no actual exit');
  };
  for (const attempt of ordered) {
    const extension = attempt.expected.language === 'swift' ? '.swift'
      : attempt.expected.language === 'tsx' ? '.tsx' : '.ts';
    if (attempt.expected.files.some(file => !file.path.endsWith(extension)))
      reasons.push('page language label mixes file languages or extensions');
    if (seenIds.has(attempt.requestId)) reasons.push('duplicate request ID');
    seenIds.add(attempt.requestId);
    if (!keys.has(attempt.expected.key)) reasons.push('request key is outside cold corpus');
    const previous = prior.get(attempt.expected.key);
    if (previous && (!overloaded.has(previous.requestId)
      || previous.completedAtNs === undefined || previous.completedAtNs > attempt.startedAtNs))
      reasons.push('cold key repeated without completed uncached overload');
    prior.set(attempt.expected.key, attempt);
    const body = attempt.httpStatus === 200 ? object(attempt.body) : null;

    if (attempt.plannedAbortMs !== undefined) {
      plannedCancels.planned++;
      if (attempt.error === PLANNED_ABORT) plannedCancels.abortedBeforeResponse++;
      else if (attempt.httpStatus === 200 && !attempt.error) {
        plannedCancels.respondedBeforeAbort++;
        const faults = validateInterfacePage(attempt.body, attempt.expected);
        if (faults.length) { malformedResponses++; reasons.push(...faults); }
        else if (isOverloadPage(body)) overloaded.add(attempt.requestId);
      } else reasons.push('HTTP or host failure');
      if (!traced) continue;
      // A disconnect settles after the client gave up, so the unique cold route is the join.
      const candidates = byRoute.get(attempt.expected.routeKey) ?? [];
      if (candidates.length > 1) { reasons.push('planned abort has ambiguous admission'); continue; }
      const trace = candidates[0];
      if (!trace) continue;
      plannedTraces++;
      usedUnits.add(trace.unitId);
      requireExit(trace);
      if (trace.outcome === 'cancelled' && trace.parserCancelled === true)
        plannedCancels.cancelledRunning[attempt.expected.language === 'swift' ? 'swift' : 'typescript']++;
      continue;
    }

    loadBearing.push(attempt);
    const counts = byLanguage[attempt.expected.language];
    counts.submitted++; total.submitted++;
    const variant = attempt.expected.variant ? `${attempt.expected.variant}:${attempt.expected.language}` : undefined;
    if (variant) (variants[variant] ??= { requested: 0, handled: 0 }).requested++;
    let trace: AdmissionTrace | undefined;
    if (traced) {
      const candidates = tracesWithin(byRoute.get(attempt.expected.routeKey) ?? [],
        attempt.startedAtNs, attempt.completedAtNs ?? -1n);
      trace = candidates.length === 1 ? candidates[0] : undefined;
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
      if (trace.outcome === 'overloaded') { counts.rejected++; total.rejected++; overloaded.add(attempt.requestId); }
      else if (trace.admittedAtNs !== undefined) { counts.admitted++; total.admitted++; }
      else { counts.unclassified++; total.unclassified++; reasons.push('trace has no admission disposition'); }
      if (trace.outcome === 'timeout') {
        if (trace.startedAtNs === undefined) { counts.queueTimeout++; total.queueTimeout++; }
        else { counts.runningTimeout++; total.runningTimeout++; }
      }
      if (trace.outcome === 'cancelled') { counts.cancelled++; total.cancelled++; }
      requireExit(trace);
    }
    if (trace?.outcome === 'error' || attempt.error || attempt.httpStatus !== 200) {
      counts.hostFailure++; total.hostFailure++;
      reasons.push('HTTP or host failure');
    }
    if (attempt.httpStatus !== 200) continue;
    const faults = validateInterfacePage(attempt.body, attempt.expected);
    if (faults.length) { malformedResponses++; reasons.push(...faults); continue; }
    const page = body!;
    const rows = page.files as Record<string, unknown>[];
    if (!traced && isOverloadPage(page)) {
      counts.rejected++; total.rejected++; overloaded.add(attempt.requestId); continue;
    }
    if (trace?.outcome === 'overloaded') {
      if (!isOverloadPage(page)) reasons.push('overload trace disagrees with HTTP page');
      continue;
    }
    if (!traced) { counts.admitted++; total.admitted++; }
    const complete = object(page.page)?.complete === true;
    const explicitTimeout = hasExplicitTimeout(page);
    counts.validResponses++; total.validResponses++;
    if (explicitTimeout) { counts.explicitTimeouts++; total.explicitTimeouts++; }
    else if (!complete) { counts.unexplainedIncomplete++; total.unexplainedIncomplete++; }
    if (variant && !explicitTimeout && complete && attempt.expected.files.every(file => rows.some(row =>
      row.path === file.path && row.status === (file.incompleteReason === undefined ? 'ready' : 'incomplete'))))
      variants[variant]!.handled++;
    for (const row of rows) {
      const freshness = attempt.freshnessByPath?.[String(row.path)];
      if (traced && row.status === 'ready' && freshness === undefined)
        reasons.push('ready comparison row lacks observed freshness');
      if (freshness === 'cache-hit') reasons.push('cold comparison served cached row');
      if (row.status === 'unavailable' || row.status === 'unsupported')
        reasons.push('cold comparison source unavailable or unsupported');
    }
    if (page.status === 'ready' && complete) { counts.completedPages++; total.completedPages++; }
    for (const row of rows) if (row.status === 'ready') { counts.completedFiles++; total.completedFiles++; }
    const cacheHits = rows.filter(row => attempt.freshnessByPath?.[String(row.path)] === 'cache-hit').length;
    counts.cacheHits += cacheHits; total.cacheHits += cacheHits;
    const workFinished = trace ? trace.startedAtNs !== undefined && trace.outcome === 'ok' : complete && !explicitTimeout;
    if (workFinished) {
      const useful = rows.filter(row => row.status === 'ready' && Array.isArray(row.changes) && row.changes.length > 0
        && (!traced || attempt.freshnessByPath?.[String(row.path)] === 'fresh')).length;
      counts.usefulComparisons += useful; total.usefulComparisons += useful;
    }
    if (trace) {
      if (explicitTimeout !== (trace.outcome === 'timeout') && (explicitTimeout || complete))
        reasons.push('HTTP timeout disagrees with admission');
      if (!explicitTimeout && !complete && trace.outcome !== 'timeout') reasons.push('incomplete page lacks timeout evidence');
      // Partial rows may already be ready, but the request timed out in look-ahead.
      if (trace.outcome === 'timeout' && !explicitTimeout) timeoutWithoutHttpReason++;
      if (trace.outcome === 'timeout' && complete) reasons.push('timed-out request claims complete page');
    }
  }
  if (traced && (usedUnits.size !== interfaceTraces.length
    || loadBearing.length + plannedTraces !== interfaceTraces.length))
    reasons.push('admission trace count differs from request count');
  const duration = Number(input.lastDurableAtNs - input.firstWriteAtNs) / 1e9;
  for (const counts of [...Object.values(byLanguage), total]) {
    counts.admittedTimeoutFraction = traced && counts.admitted ? (counts.queueTimeout + counts.runningTimeout) / counts.admitted : null;
    counts.overloadFraction = counts.submitted ? counts.rejected / counts.submitted : 0;
    counts.usefulPerSecond = duration > 0 ? counts.usefulComparisons / duration : 0;
    counts.timeoutFractionBounds = counts.validResponses ? { lower: counts.explicitTimeouts / counts.validResponses,
      upper: (counts.explicitTimeouts + counts.unexplainedIncomplete) / counts.validResponses } : null;
  }
  for (const [variant, coverage] of Object.entries(variants))
    if (!coverage.handled) reasons.push(`variant ${variant} was never handled`);
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
  const intervals = loadBearing.filter(a => a.completedAtNs !== undefined);
  let covered = input.firstWriteAtNs;
  for (const attempt of intervals) {
    if (attempt.startedAtNs > covered) break;
    if (attempt.completedAtNs! > covered) covered = attempt.completedAtNs!;
  }
  const continuousRequests = covered >= input.lastDurableAtNs;
  if (!continuousRequests) reasons.push('request intervals do not continuously cover capture');
  const windowed = loadBearing.filter(a => a.completedAtNs !== undefined);
  const activityWindows: InterfaceLoadReport['activityWindows'] = [];
  if (input.lastDurableAtNs > input.firstWriteAtNs) {
    const span = input.lastDurableAtNs - input.firstWriteAtNs;
    const windows = Math.max(1, Math.floor(Number(span) / 1e9));
    for (let i = 0; i < windows; i++) {
      const start = input.firstWriteAtNs + span * BigInt(i) / BigInt(windows);
      const end = input.firstWriteAtNs + span * BigInt(i + 1) / BigInt(windows);
      activityWindows.push({
        ready: windowed.filter(a => a.startedAtNs >= start && a.completedAtNs! <= end
          && (!traced || matched.get(a.requestId)?.outcome === 'ok')
          && object(a.body)?.status === 'ready' && object(object(a.body)?.page)?.complete === true
          && (object(a.body)?.files as unknown[] | undefined)?.some(row => object(row)?.status === 'ready'
            && (!traced || a.freshnessByPath?.[String(object(row)?.path)] === 'fresh')
            && (object(row)?.changes as unknown[] | undefined)?.length)).length,
        overloaded: windowed.filter(a => a.completedAtNs! >= start && a.completedAtNs! < end && overloaded.has(a.requestId)).length,
      });
    }
  }
  if (!activityWindows.length || activityWindows.some(w => !w.ready || !w.overloaded)) reasons.push('window lacked fresh ready comparison or overload');
  return { sufficient: reasons.length === 0, reasons: [...new Set(reasons)], byLanguage, total,
    activityWindows, continuousRequests, malformedResponses, timeoutWithoutHttpReason,
    classification: traced ? 'trace' : 'http', plannedCancels, variants };
}

const REQUIRED_VARIANTS = ['malformed:typescript', 'malformed:tsx', 'malformed:swift', 'unicode:typescript', 'unicode:tsx'];
/** Evidence only a traced witness can supply: planned disconnects cancelled a live parser in each family,
 * every input variant was handled, and at least one retired TypeScript worker actually exited. */
export function witnessCoverageFaults(report: InterfaceLoadReport, events: ProjectionTraceEvent[]): string[] {
  const faults: string[] = [];
  for (const family of ['typescript', 'swift'] as const)
    if (report.plannedCancels.cancelledRunning[family] < 1) faults.push(`no ${family} planned abort cancelled running work`);
  for (const variant of REQUIRED_VARIANTS)
    if (!report.variants[variant]?.handled) faults.push(`variant ${variant} was never handled`);
  const tsWorkers = new Set(events.flatMap(event => event.kind === 'process-start' && event.process === 'ts-worker' ? [event.processId] : []));
  const retired = new Set(events.flatMap(event => event.kind === 'process-retire' && tsWorkers.has(event.processId) ? [event.processId] : []));
  if (!events.some(event => event.kind === 'process-exit' && retired.has(event.processId)))
    faults.push('no retired TypeScript worker exited');
  return faults;
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
