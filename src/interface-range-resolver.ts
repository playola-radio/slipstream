/** Resolve recorded file identities for one frozen pair of session cutoffs.
 * FD4 owns blob retention, extraction, response pagination and HTTP mapping. */
import { openLogCursor, LogCorruptError, LogReadAbortedError, LogReadLimitError, type ReaderEvent } from './log-reader.ts';
import { assertSafePath } from './recovery.ts';
import type { Snapshot, UnavailableReason } from './snapshot.ts';

const BASELINED = 'slipstream.file.baselined.v1';
const CHANGED = 'slipstream.file.changed.v1';
const COMPLETED = 'slipstream.capture.baseline.completed.v1';
const GAP = 'slipstream.capture.gap.v1';
const SHA = /^[0-9a-f]{64}$/;
const SEQ = /^[1-9][0-9]*$/;
const POLICY_EXCLUSIONS = ['store-directory', '.git', 'symlinks'] as const;

export type RecordedEndpoint = {
  kind: 'recorded'; record_seq: string; field: 'snapshot' | 'before' | 'after'; snapshot: Snapshot;
  observation?: 'watcher' | 'reconciliation'; gap_ref?: string;
};
export type RangeEndpoint = RecordedEndpoint | { kind: 'unknownBoundary' };
export interface RangeFile {
  path: string;
  before: RangeEndpoint;
  after: RecordedEndpoint;
  /** Tag equality only; FD4 must recheck content blob retention before hiding a row. */
  endpointsEqual: boolean;
}
export interface RangeGap {
  seq: string;
  reason: 'coalesced' | 'baseline-unreadable' | 'watcher-error' | 'restart' | 'storage';
  scope: { kind: 'session' } | { kind: 'directory' | 'path'; path: string };
}
export interface RangeScanStats { records: number; bytes: number; elapsedMs: number }
export interface ResolveRecordedRangeOptions {
  logPath: string;
  sessionId: string;
  /** Reader-owned durable boundary, frozen before this call. */
  durableSeq: bigint;
  beforeSeq: bigint;
  afterSeq: bigint;
  pathPrefix?: string;
  afterPath?: string | null;
  scanBudget: { records: number; bytes: number };
  signal?: AbortSignal;
}
export type ResolveRecordedRangeResult =
  | { kind: 'resolved'; inventory: { scope: 'observed'; baselineCompletedSeq: string | null; unknownScopes: string[];
      policyExclusions: typeof POLICY_EXCLUSIONS };
      gaps: RangeGap[]; files: RangeFile[]; scan: RangeScanStats }
  | { kind: 'beyondDurable' }
  | { kind: 'scanLimit'; scan: RangeScanStats }
  | { kind: 'aborted'; scan: RangeScanStats };

interface FileRecord { seq: string; type: typeof BASELINED | typeof CHANGED; data: Record<string, unknown> }
interface FileState { prior?: Snapshot; before?: FileRecord; after?: FileRecord; firstAfterB?: FileRecord }

function corrupt(message: string): never { throw new LogCorruptError(`interface range: ${message}`); }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function snapshot(value: unknown, seq: string): Snapshot {
  if (!object(value)) corrupt(`bad snapshot at ${seq}`);
  if (value.kind === 'absent') return { kind: 'absent' };
  if (value.kind === 'content' && typeof value.sha256 === 'string' && SHA.test(value.sha256)
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0) {
    return { kind: 'content', sha256: value.sha256, size: value.size };
  }
  if (value.kind === 'unavailable' && typeof value.reason === 'string'
    && ['oversize', 'unreadable', 'unstable', 'io-error', 'baseline-unknown'].includes(value.reason)) {
    return { kind: 'unavailable', reason: value.reason as UnavailableReason };
  }
  return corrupt(`bad snapshot at ${seq}`);
}
function sameRecordedState(a: Snapshot, b: Snapshot): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'content' && b.kind === 'content') return a.sha256 === b.sha256 && a.size === b.size;
  if (a.kind === 'unavailable' && b.kind === 'unavailable') return a.reason === b.reason;
  return true;
}
function endpoint(record: FileRecord, field: 'snapshot' | 'before' | 'after'): RecordedEndpoint {
  const result: RecordedEndpoint = {
    kind: 'recorded', record_seq: record.seq, field, snapshot: snapshot(record.data[field], record.seq),
  };
  if (record.type === CHANGED) {
    result.observation = record.data.observation as 'watcher' | 'reconciliation';
    if (record.data.gap_ref !== undefined) result.gap_ref = record.data.gap_ref as string;
  }
  return result;
}
function stateEndpoint(record: FileRecord): RecordedEndpoint {
  return endpoint(record, record.type === BASELINED ? 'snapshot' : 'after');
}
function endpointsEqual(before: RangeEndpoint, after: RecordedEndpoint): boolean {
  if (before.kind !== 'recorded') return false;
  if (before.snapshot.kind === 'absent' && after.snapshot.kind === 'absent') return true;
  return before.snapshot.kind === 'content' && after.snapshot.kind === 'content'
    && before.snapshot.sha256 === after.snapshot.sha256;
}
function checkPath(value: unknown, seq: string): string {
  if (typeof value !== 'string' || value.includes('\0')) corrupt(`bad path at ${seq}`);
  try { assertSafePath(value, `record ${seq}`); }
  catch { corrupt(`unsafe path at ${seq}`); }
  return value;
}
function checkGap(data: Record<string, unknown>, seq: string): RangeGap {
  if (!['coalesced', 'baseline-unreadable', 'watcher-error', 'restart', 'storage'].includes(data.reason as string)
    || !object(data.scope)) corrupt(`bad gap at ${seq}`);
  const scope = data.scope;
  if (scope.kind === 'session') return { seq, reason: data.reason as RangeGap['reason'], scope: { kind: 'session' } };
  if ((scope.kind !== 'directory' && scope.kind !== 'path') || typeof scope.path !== 'string'
    || scope.path.includes('\0')) corrupt(`bad gap scope at ${seq}`);
  if (scope.path !== '') checkPath(scope.path, seq);
  return { seq, reason: data.reason as RangeGap['reason'], scope: { kind: scope.kind, path: scope.path } };
}

/** A bounded scan of the public log through A. No live worktree or Git access. */
export async function resolveRecordedRange(options: ResolveRecordedRangeOptions): Promise<ResolveRecordedRangeResult> {
  const { logPath, sessionId, durableSeq, beforeSeq, afterSeq, scanBudget, signal } = options;
  if (beforeSeq < 0n || afterSeq < beforeSeq || durableSeq < 0n) throw new RangeError('invalid cutoffs');
  if (afterSeq > durableSeq) return { kind: 'beyondDurable' };
  if (!Number.isSafeInteger(scanBudget.records) || scanBudget.records < 0
    || !Number.isSafeInteger(scanBudget.bytes) || scanBudget.bytes < 0) throw new RangeError('invalid scan budget');
  const started = performance.now();
  let records = 0;
  let bytes = 0;
  const scan = (): RangeScanStats => ({ records, bytes, elapsedMs: performance.now() - started });
  if (signal?.aborted) return { kind: 'aborted', scan: scan() };
  if (afterSeq === 0n) return {
    kind: 'resolved', inventory: { scope: 'observed', baselineCompletedSeq: null, unknownScopes: [], policyExclusions: POLICY_EXCLUSIONS },
    gaps: [], files: [], scan: scan(),
  };
  const states = new Map<string, FileState>();
  const gaps: RangeGap[] = [];
  let baselineCompletedSeq: string | null = null;
  let unknownScopes: string[] = [];
  let lastSeq = 0n;
  const cursor = await openLogCursor(logPath, 0n);
  try {
    while (lastSeq < afterSeq) {
      if (signal?.aborted) return { kind: 'aborted', scan: scan() };
      if (records >= scanBudget.records || bytes >= scanBudget.bytes) return { kind: 'scanLimit', scan: scan() };
      let batch: ReaderEvent[];
      try {
        batch = await cursor.readThrough(afterSeq, {
          maxRecords: scanBudget.records - records,
          maxBytes: scanBudget.bytes - bytes,
          signal,
        });
      } catch (error) {
        if (error instanceof LogReadAbortedError) return { kind: 'aborted', scan: scan() };
        if (error instanceof LogReadLimitError) return { kind: 'scanLimit', scan: scan() };
        throw error;
      }
      if (batch.length === 0) corrupt(`disk short of durable boundary ${afterSeq}`);
      for (const record of batch) {
        if (signal?.aborted) return { kind: 'aborted', scan: scan() };
        records += 1;
        bytes += Buffer.byteLength(record.raw, 'utf8') + 1;
        if (records > scanBudget.records || bytes > scanBudget.bytes) return { kind: 'scanLimit', scan: scan() };
        lastSeq = record.seq;
        consume(record);
      }
    }
  } finally { await cursor.close(); }

  function consume(record: ReaderEvent): void {
    const seq = record.seq.toString();
    const data = record.data;
    if (data.session_id !== sessionId) corrupt(`session mismatch at ${seq}`);
    if (record.type === BASELINED || record.type === CHANGED) {
      const path = checkPath(data.path, seq);
      const state = states.get(path) ?? {};
      if (record.type === BASELINED) {
        const tag = snapshot(data.snapshot, seq);
        state.prior = tag;
      } else {
        const before = snapshot(data.before, seq);
        const after = snapshot(data.after, seq);
        if (data.observation !== 'watcher' && data.observation !== 'reconciliation') corrupt(`bad observation at ${seq}`);
        if (data.gap_ref !== undefined && (typeof data.gap_ref !== 'string' || !SEQ.test(data.gap_ref))) corrupt(`bad gap_ref at ${seq}`);
        if (state.prior !== undefined && !sameRecordedState(state.prior, before)) corrupt(`contradictory predecessor at ${seq}: ${path}`);
        state.prior = after;
      }
      const fileRecord: FileRecord = { seq, type: record.type, data };
      state.after = fileRecord;
      if (record.seq <= beforeSeq) state.before = fileRecord;
      else if (state.firstAfterB === undefined) state.firstAfterB = fileRecord;
      states.set(path, state);
    } else if (record.type === COMPLETED && baselineCompletedSeq === null) {
      if (!Array.isArray(data.unknown_scopes) || data.unknown_scopes.some((scope) => {
        if (typeof scope !== 'string' || scope.includes('\0')) return true;
        if (scope === '') return false;
        try { assertSafePath(scope, `record ${seq}`); return false; }
        catch { return true; }
      })) corrupt(`bad unknown scopes at ${seq}`);
      baselineCompletedSeq = seq;
      unknownScopes = [...data.unknown_scopes].sort();
    } else if (record.type === GAP) {
      gaps.push(checkGap(data, seq));
    }
  }

  const files: RangeFile[] = [];
  for (const [path, state] of states) {
    if (options.pathPrefix !== undefined && !path.startsWith(options.pathPrefix)) continue;
    if (options.afterPath !== undefined && options.afterPath !== null && path <= options.afterPath) continue;
    if (state.after === undefined) continue;
    const after = stateEndpoint(state.after);
    const before: RangeEndpoint = state.before !== undefined ? stateEndpoint(state.before)
      : baselineCompletedSeq !== null && BigInt(baselineCompletedSeq) <= beforeSeq && state.firstAfterB?.type === CHANGED
        ? endpoint(state.firstAfterB, 'before') : { kind: 'unknownBoundary' };
    files.push({ path, before, after, endpointsEqual: endpointsEqual(before, after) });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { kind: 'resolved', inventory: { scope: 'observed', baselineCompletedSeq, unknownScopes,
    policyExclusions: POLICY_EXCLUSIONS }, gaps, files, scan: scan() };
}
