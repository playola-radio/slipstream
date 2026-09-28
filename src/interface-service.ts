/** Reader-owned, disposable interface.v2 range projection. No events or index. */
import { webcrypto } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { blobPath } from './store-reader.ts';
import { resolveRecordedRange, type RangeEndpoint, type RangeFile, type RangeGap } from './interface-range-resolver.ts';
import { compareV2, type V2Change } from './interface-v2-core.ts';
import { extractSwiftSides, SwiftExtractCancelled, SwiftExtractTimeout } from './swift-interface.ts';
import { createTypeScriptPool } from './interface-ts-pool.ts';
import type { StructuredChange } from './interface-v2-comparison.ts';
import type { ProjectionAdmission } from './projection-admission.ts';
import type { ProjectionTraceObserver } from './projection-trace.ts';

const FILES_PER_PAGE = 16;
const SIDE_BYTES = 1024 * 1024;
const PAGE_BLOB_BYTES = 8 * 1024 * 1024;
const FILE_RESULT_BYTES = 512 * 1024;
const METADATA_BYTES = 64 * 1024;
const SCAN = { records: 100_000, bytes: 16 * 1024 * 1024 };
const ANALYSIS = { shared_types: 'notAnalyzed', effects: 'notAnalyzed', behavior: 'notAnalyzed' } as const;

type Coverage = { state: 'complete' | 'absent' | 'incomplete' | 'unavailable' | 'unsupported' | 'notEvaluated'; reason?: string };
export interface InterfaceFileResult {
  path: string;
  before: RangeEndpoint;
  after: RangeFile['after'];
  language: string | null;
  language_version: string | null;
  status: 'identical' | 'ready' | 'incomplete' | 'unavailable' | 'unsupported' | 'skipped';
  fallback_reason?: string;
  coverage: { before: Coverage; after: Coverage };
  changes: (StructuredChange | V2Change)[];
}
interface Inventory {
  scope: 'observed'; baseline_completed_seq: string | null; unknown_scopes: string[];
  unknown_scopes_complete: boolean; policy_exclusions: readonly string[];
}
export interface InterfacePage {
  projection_version: 'interface.v2'; session_id: string;
  range: { before_seq: string; after_seq: string };
  status: 'ready' | 'partial' | 'skipped'; fallback_reason?: 'overloaded' | 'timeout' | 'cancelled' | 'scan-limit';
  inventory: Inventory | null; analysis: typeof ANALYSIS; gaps: RangeGap[] | null;
  gaps_complete: boolean; files: InterfaceFileResult[];
  page: { complete: boolean; next_after_path: string | null };
}
export interface InterfaceRequest {
  sessionId: string; logPath: string; durableSeq: bigint; beforeSeq: bigint; afterSeq: bigint;
  pathPrefix: string; afterPath: string | null; includeIdentical: boolean; limit: number;
  signal?: AbortSignal;
  /** Test-only raw HTTP request target used to join trace events. */
  traceRouteKey?: string;
}
export interface InterfaceServiceOptions {
  storeDir: string;
  admission: ProjectionAdmission;
  projectionTrace?: ProjectionTraceObserver;
  /** Internal benchmark seam; absent uses shared admission D. */
  admissionDeadlineMs?: number;
  scanBudget?: typeof SCAN;
  fileResultBytes?: number;
  metadataBytes?: number;
  pageBlobBytes?: number;
  /** Test harness interrupt seam; production does not set this. */
  onFileStart?: (path: string) => void;
  /** Test harness seam after a recorded content-retention probe. */
  onRetentionCheck?: (path: string, phase: 'scan' | 'lookahead') => void | Promise<void>;
  /** Test seam for isolated child failures; production uses extractSwiftSides. */
  extractSwift?: typeof extractSwiftSides;
}

const languageFor = (path: string): { name: 'typescript' | 'swift'; version: string; grammar?: 'typescript' | 'tsx' } | null =>
  path.endsWith('.ts') ? { name: 'typescript', version: 'typescript.v2', grammar: 'typescript' }
    : path.endsWith('.tsx') ? { name: 'typescript', version: 'typescript.v2', grammar: 'tsx' }
      : path.endsWith('.swift') ? { name: 'swift', version: 'swift.v1' } : null;
const tag = (endpoint: RangeEndpoint): string => endpoint.kind === 'unknownBoundary' ? 'unknownBoundary'
  : endpoint.snapshot.kind === 'content' ? `content:${endpoint.snapshot.sha256}:${endpoint.snapshot.size}`
    : endpoint.snapshot.kind === 'absent' ? 'absent' : `unavailable:${endpoint.snapshot.reason}`;
const sideFallback = (endpoint: RangeEndpoint): Coverage => {
  if (endpoint.kind === 'unknownBoundary') return { state: 'unavailable', reason: 'unknown-boundary' };
  if (endpoint.snapshot.kind === 'absent') return { state: 'absent' };
  if (endpoint.snapshot.kind === 'unavailable') return { state: 'unavailable', reason: endpoint.snapshot.reason };
  return { state: 'notEvaluated' };
};
const statusReason = (coverage: InterfaceFileResult['coverage'], language: string | null,
  compareReason?: string, tooLarge = false): Pick<InterfaceFileResult, 'status' | 'fallback_reason'> => {
  for (const side of ['before', 'after'] as const) if (coverage[side].state === 'incomplete')
    return { status: 'incomplete', fallback_reason: `${side}-${coverage[side].reason}` };
  if (compareReason) return { status: 'incomplete', fallback_reason: compareReason };
  for (const side of ['before', 'after'] as const) if (coverage[side].state === 'unavailable')
    return { status: 'unavailable', fallback_reason: `${side}-${coverage[side].reason}` };
  if (language === null) return { status: 'unsupported', fallback_reason: 'unsupported-language' };
  if (tooLarge) return { status: 'skipped', fallback_reason: 'too-large' };
  return { status: 'ready' };
};

type ReadSide = { coverage: Coverage; bytes: Uint8Array | null; tooLarge: boolean; readBytes: number };
type FileProgress = { coverage?: InterfaceFileResult['coverage']; tooLarge: boolean; identical: boolean };
async function readSide(storeDir: string, endpoint: RangeEndpoint, limit: number): Promise<ReadSide> {
  const forced = sideFallback(endpoint);
  if (endpoint.kind === 'unknownBoundary' || endpoint.snapshot.kind !== 'content')
    return { coverage: forced, bytes: null, tooLarge: false, readBytes: 0 };
  let handle;
  try { handle = await open(blobPath(storeDir, endpoint.snapshot.sha256), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return { coverage: { state: 'unavailable', reason: 'blob-missing' }, bytes: null, tooLarge: false, readBytes: 0 };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { coverage: { state: 'unavailable', reason: 'blob-missing' }, bytes: null, tooLarge: false, readBytes: 0 };
    if (stat.size > limit || endpoint.snapshot.size > limit)
      return { coverage: { state: 'notEvaluated' }, bytes: null, tooLarge: true, readBytes: 0 };
    const bytes = await handle.readFile();
    const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
    if (bytes.length !== endpoint.snapshot.size || digest !== endpoint.snapshot.sha256)
      throw new Error('content-addressed blob does not match recorded snapshot');
    return { coverage: { state: 'notEvaluated' }, bytes, tooLarge: false, readBytes: bytes.length };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { coverage: { state: 'unavailable', reason: 'blob-missing' }, bytes: null, tooLarge: false, readBytes: 0 };
    throw error;
  } finally { await handle.close(); }
}

async function retainedContent(storeDir: string, endpoint: RangeEndpoint): Promise<boolean> {
  if (endpoint.kind !== 'recorded' || endpoint.snapshot.kind !== 'content') return true;
  let handle;
  try { handle = await open(blobPath(storeDir, endpoint.snapshot.sha256), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return false;
    throw error;
  }
  try { return (await handle.stat()).isFile(); }
  finally { await handle.close(); }
}

function boundedMetadata(source: { inventory: { scope: 'observed'; baselineCompletedSeq: string | null;
  unknownScopes: string[]; policyExclusions: readonly string[] }; gaps: RangeGap[] }, max: number) {
  // Both arrays' brackets and commas are part of their serialized budget.
  let used = 4;
  let gapsComplete = true;
  let scopesComplete = true;
  const gaps: RangeGap[] = [];
  const scopes: string[] = [];
  for (const gap of source.gaps) {
    const size = Buffer.byteLength(JSON.stringify(gap)) + (gaps.length ? 1 : 0);
    if (used + size > max) { gapsComplete = false; break; }
    gaps.push(gap); used += size;
  }
  for (const scope of source.inventory.unknownScopes) {
    const size = Buffer.byteLength(JSON.stringify(scope)) + (scopes.length ? 1 : 0);
    if (used + size > max) { scopesComplete = false; break; }
    scopes.push(scope); used += size;
  }
  const inventory: Inventory = { scope: 'observed', baseline_completed_seq: source.inventory.baselineCompletedSeq,
    unknown_scopes: scopes, unknown_scopes_complete: scopesComplete,
    policy_exclusions: source.inventory.policyExclusions };
  return { inventory, gaps, gapsComplete };
}

export function createInterfaceService(options: InterfaceServiceOptions) {
  const pool = createTypeScriptPool();
  const cache = new Map<string, { value: Pick<InterfaceFileResult, 'status' | 'fallback_reason' | 'coverage' | 'changes'>; bytes: number }>();
  let cachedBytes = 0;
  let closed = false;
  const active = new Set<Promise<unknown>>();
  const cacheSet = (key: string, value: InterfaceFileResult) => {
    if (!['ready', 'incomplete', 'unsupported'].includes(value.status)) return;
    const entry = { value: { status: value.status, fallback_reason: value.fallback_reason,
      coverage: value.coverage, changes: value.changes }, bytes: Buffer.byteLength(JSON.stringify(value)) };
    if (entry.bytes > 16 * 1024 * 1024) return;
    const prior = cache.get(key);
    if (prior) cachedBytes -= prior.bytes;
    cache.delete(key);
    cache.set(key, entry);
    cachedBytes += entry.bytes;
    while (cache.size > 128 || cachedBytes > 16 * 1024 * 1024) {
      const oldest = cache.keys().next().value;
      if (!oldest) break;
      cachedBytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
  };
  const cacheGet = (key: string) => {
    const found = cache.get(key);
    if (!found) return undefined;
    cache.delete(key); cache.set(key, found);
    return found.value;
  };

  async function compareFile(file: RangeFile, signal: AbortSignal, equalAndRetained: boolean,
    progress: FileProgress): Promise<{ result: InterfaceFileResult; blobBytes: number;
      freshness: 'fresh' | 'cache-hit' | 'none' }> {
    const language = languageFor(file.path);
    const base: InterfaceFileResult = { path: file.path, before: file.before, after: file.after,
      language: language?.name ?? null, language_version: language?.version ?? null,
      status: 'ready', coverage: { before: sideFallback(file.before), after: sideFallback(file.after) }, changes: [] };
    progress.coverage = base.coverage;
    if (equalAndRetained) {
      progress.identical = true;
      base.status = 'identical';
      return { result: base, blobBytes: 0, freshness: 'none' };
    }
    const [before, after] = await Promise.all([
      readSide(options.storeDir, file.before, SIDE_BYTES).then(side => {
        base.coverage.before = side.coverage;
        progress.tooLarge ||= side.tooLarge;
        return side;
      }),
      readSide(options.storeDir, file.after, SIDE_BYTES).then(side => {
        base.coverage.after = side.coverage;
        progress.tooLarge ||= side.tooLarge;
        return side;
      }),
    ]);
    if (!language) {
      if (base.coverage.before.state === 'notEvaluated') base.coverage.before = { state: 'unsupported' };
      if (base.coverage.after.state === 'notEvaluated') base.coverage.after = { state: 'unsupported' };
    }
    const blobBytes = before.readBytes + after.readBytes;
    if (signal.aborted) throw new Error('interface page cancelled');
    const key = `${tag(file.before)}|${tag(file.after)}|${language?.name ?? 'unsupported'}|${language?.version ?? 'none'}|${language?.grammar ?? 'none'}|interface.v2`;
    if (!before.tooLarge && !after.tooLarge && before.coverage.state !== 'unavailable' && after.coverage.state !== 'unavailable') {
      const hit = cacheGet(key);
      if (hit) return { result: { ...base, ...hit }, blobBytes, freshness: 'cache-hit' };
    }
    let freshness: 'fresh' | 'none' = 'none';
    let compareReason: string | undefined;
    let changes: InterfaceFileResult['changes'] = [];
    if (language?.name === 'typescript' && !before.tooLarge && !after.tooLarge &&
      (before.bytes !== null || after.bytes !== null)) {
      const task = pool.run({ language: language.grammar!, before: before.bytes, after: after.bytes,
        limits: { inputBytes: SIDE_BYTES, declarations: 4096, syntaxVisits: 100_000 } });
      signal.addEventListener('abort', task.cancel, { once: true });
      try {
        const result = await task.promise;
        freshness = result.comparison?.status === 'ready' ? 'fresh' : 'none';
        if (before.bytes !== null) base.coverage.before = result.before.status === 'incomplete'
          ? { state: 'incomplete', reason: result.before.reason }
          : result.before.status === 'tooLarge' ? { state: 'notEvaluated' } : { state: 'complete' };
        if (after.bytes !== null) base.coverage.after = result.after.status === 'incomplete'
          ? { state: 'incomplete', reason: result.after.reason }
          : result.after.status === 'tooLarge' ? { state: 'notEvaluated' } : { state: 'complete' };
        before.tooLarge ||= result.before.status === 'tooLarge';
        after.tooLarge ||= result.after.status === 'tooLarge';
        progress.tooLarge ||= before.tooLarge || after.tooLarge;
        if (result.comparison?.status === 'incomplete') compareReason = result.comparison.fallback_reason;
        else if (result.comparison?.status === 'ready') changes = result.comparison.changes;
      } finally { signal.removeEventListener('abort', task.cancel); }
    } else if (language?.name === 'swift' && !before.tooLarge && !after.tooLarge &&
      (before.bytes !== null || after.bytes !== null)) {
      const sides = [before.bytes !== null ? { id: 'before', bytes: before.bytes } : null,
        after.bytes !== null ? { id: 'after', bytes: after.bytes } : null].filter((v): v is { id: string; bytes: Uint8Array } => v !== null);
      const results = await (options.extractSwift ?? extractSwiftSides)(sides, { signal,
        limits: { inputBytes: SIDE_BYTES, declarations: 4096, syntaxVisits: 100_000 } });
      if (results.size !== sides.length) throw new Error('Swift extractor returned unexpected side count');
      for (const side of sides) if (!results.has(side.id)) throw new Error(`Swift extractor omitted ${side.id} side`);
      for (const side of sides) {
        const extracted = results.get(side.id)!;
        if (extracted.status === 'complete') {
          if (!Array.isArray(extracted.declarations)) throw new Error('Swift extractor omitted declarations');
        } else if (extracted.status === 'incomplete') {
          if (extracted.reason !== 'parse-error' && extracted.reason !== 'unsupported-construct')
            throw new Error('Swift extractor returned unknown incomplete reason');
        } else if (extracted.status === 'tooLarge') {
          if (!['inputBytes', 'declarations', 'syntaxVisits'].includes(extracted.limit))
            throw new Error('Swift extractor returned unknown limit');
        } else throw new Error('Swift extractor returned unknown status');
      }
      for (const side of ['before', 'after'] as const) {
        const extracted = results.get(side);
        if (extracted?.status === 'complete') base.coverage[side] = { state: 'complete' };
        else if (extracted?.status === 'incomplete') base.coverage[side] = { state: 'incomplete', reason: extracted.reason };
      }
      const left = results.get('before'), right = results.get('after');
      if (left?.status === 'tooLarge' || right?.status === 'tooLarge') {
        before.tooLarge ||= left?.status === 'tooLarge';
        after.tooLarge ||= right?.status === 'tooLarge';
        progress.tooLarge = true;
      } else if ((left === undefined || left.status === 'complete') && (right === undefined || right.status === 'complete')) {
        const result = compareV2(left?.status === 'complete' ? left.declarations : [],
          right?.status === 'complete' ? right.declarations : []);
        freshness = result.status === 'ready' ? 'fresh' : 'none';
        if (result.status === 'incomplete') compareReason = result.reason;
        else changes = result.changes;
      }
    }
    if (signal.aborted) throw new Error('interface page cancelled');
    const disposition = statusReason(base.coverage, base.language, compareReason, before.tooLarge || after.tooLarge);
    Object.assign(base, disposition);
    base.changes = base.status === 'ready' ? changes : [];
    cacheSet(key, base);
    return { result: base, blobBytes, freshness };
  }

  const envelope = (req: InterfaceRequest): InterfacePage => ({
    projection_version: 'interface.v2', session_id: req.sessionId,
    range: { before_seq: req.beforeSeq.toString(), after_seq: req.afterSeq.toString() },
    status: 'ready', inventory: null, analysis: ANALYSIS, gaps: null, gaps_complete: false,
    files: [], page: { complete: false, next_after_path: req.afterPath },
  });

  async function get(req: InterfaceRequest): Promise<InterfacePage> {
    if (closed) return { ...envelope(req), status: 'skipped', fallback_reason: 'cancelled' };
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    if (req.signal?.aborted) abort.abort();
    const page = envelope(req);
    let resolved = false;
    let current: RangeFile | undefined;
    let currentProgress: FileProgress | undefined;
    let sealed = false;
    let failure: unknown;
    const interruptPage = (reason: 'timeout' | 'cancelled') => {
      if (!resolved || page.files.length === 0 && !current) {
        page.status = 'skipped'; page.fallback_reason = reason;
        page.page = { complete: false, next_after_path: req.afterPath };
        return page;
      }
      if (current) {
        const language = languageFor(current.path);
        const progress = currentProgress;
        const coverage = progress?.coverage ? {
          before: { ...progress.coverage.before }, after: { ...progress.coverage.after },
        } : { before: sideFallback(current.before), after: sideFallback(current.after) };
        const disposition = progress?.identical ? { status: 'identical' as const }
          : statusReason(coverage, language?.name ?? null, undefined, progress?.tooLarge);
        page.files.push({ path: current.path, before: current.before, after: current.after,
          language: language?.name ?? null, language_version: language?.version ?? null,
          status: disposition.status === 'ready' ? 'skipped' : disposition.status,
          fallback_reason: disposition.status === 'ready' ? reason : disposition.fallback_reason,
          coverage, changes: [] });
      }
      page.status = current || page.files.some(file => file.status !== 'ready' && file.status !== 'identical') ? 'partial' : 'ready';
      page.page = { complete: false, next_after_path: page.files.at(-1)?.path ?? req.afterPath };
      return page;
    };
    const run = async (): Promise<InterfacePage> => {
      try {
      const result = await resolveRecordedRange({ logPath: req.logPath, sessionId: req.sessionId,
        durableSeq: req.durableSeq, beforeSeq: req.beforeSeq, afterSeq: req.afterSeq,
        pathPrefix: req.pathPrefix, afterPath: req.afterPath,
        scanBudget: options.scanBudget ?? SCAN, signal: abort.signal });
      if (sealed) return page;
      if (result.kind === 'beyondDurable') throw new Error('range exceeded frozen durable boundary');
      if (result.kind === 'scanLimit') {
        page.status = 'skipped'; page.fallback_reason = 'scan-limit'; return page;
      }
      if (result.kind === 'aborted') return interruptPage('cancelled');
      resolved = true;
      const metadata = boundedMetadata(result, options.metadataBytes ?? METADATA_BYTES);
      page.inventory = metadata.inventory;
      page.gaps = metadata.gaps;
      page.gaps_complete = metadata.gapsComplete;
      let blobBytes = 0;
      let fileBytes = 0;
      let examined = req.afterPath;
      for (const file of result.files) {
        if (sealed || abort.signal.aborted) return sealed ? page : interruptPage('cancelled');
        if (page.files.length >= Math.min(req.limit, FILES_PER_PAGE)) break;
        const equalAndRetained = file.endpointsEqual && await retainedContent(options.storeDir, file.before);
        if (file.endpointsEqual) {
          const check = options.onRetentionCheck?.(file.path, 'scan');
          if (check) await check;
        }
        if (sealed || abort.signal.aborted) return sealed ? page : interruptPage('cancelled');
        if (equalAndRetained && !req.includeIdentical) { examined = file.path; continue; }
        const upcoming = equalAndRetained ? 0
          : (file.before.kind === 'recorded' && file.before.snapshot.kind === 'content' ? file.before.snapshot.size : 0)
            + (file.after.snapshot.kind === 'content' ? file.after.snapshot.size : 0);
        if (page.files.length > 0 && blobBytes + upcoming > (options.pageBlobBytes ?? PAGE_BLOB_BYTES)) break;
        current = file;
        currentProgress = { tooLarge: false, identical: false };
        options.onFileStart?.(file.path);
        const compared = await compareFile(file, abort.signal, equalAndRetained, currentProgress);
        if (sealed || abort.signal.aborted) return sealed ? page : interruptPage('cancelled');
        current = undefined;
        currentProgress = undefined;
        examined = file.path;
        blobBytes += compared.blobBytes;
        if (compared.result.status === 'identical' && !req.includeIdentical) continue;
        const budget = options.fileResultBytes ?? FILE_RESULT_BYTES;
        let row = compared.result;
        let size = Buffer.byteLength(JSON.stringify(row));
        if (page.files.length > 0 && fileBytes + size > budget) {
          examined = page.files.at(-1)!.path;
          break;
        }
        if (page.files.length === 0 && row.status === 'ready' && size > budget) {
          row = { ...row, status: 'skipped', fallback_reason: 'too-large', changes: [],
            coverage: {
              before: row.coverage.before.state === 'complete' ? { state: 'notEvaluated' } : row.coverage.before,
              after: row.coverage.after.state === 'complete' ? { state: 'notEvaluated' } : row.coverage.after,
            } };
          size = Buffer.byteLength(JSON.stringify(row));
        }
        page.files.push(row);
        if (options.projectionTrace && req.traceRouteKey !== undefined) {
          try {
            const returned = options.projectionTrace({ kind: 'interface-file', routeKey: req.traceRouteKey,
              path: row.path, atNs: process.hrtime.bigint(), freshness: compared.freshness, resultStatus: row.status }) as unknown;
            if (returned instanceof Promise) void returned.catch(() => {});
          }
          catch { /* observation cannot affect projection */ }
        }
        fileBytes += size;
      }
      if (sealed || abort.signal.aborted) return sealed ? page : interruptPage('cancelled');
      let remaining = false;
      for (const file of result.files) {
        if (file.path <= (examined ?? '')) continue;
        if (!file.endpointsEqual || req.includeIdentical) {
          remaining = true; break;
        }
        const retained = await retainedContent(options.storeDir, file.before);
        const check = options.onRetentionCheck?.(file.path, 'lookahead');
        if (check) await check;
        if (sealed || abort.signal.aborted) return sealed ? page : interruptPage('cancelled');
        if (!retained) { remaining = true; break; }
      }
      page.page = { complete: !remaining, next_after_path: remaining ? examined : null };
      page.status = page.files.some(file => file.status !== 'ready' && file.status !== 'identical') ? 'partial' : 'ready';
      return page;
      } catch (error) {
        if (sealed) return page;
        if (error instanceof SwiftExtractTimeout) return interruptPage('timeout');
        if (abort.signal.aborted || error instanceof SwiftExtractCancelled) return interruptPage('cancelled');
        throw error;
      }
    };
    // The runner begins only after admission grants the local interface slot.
    // Progress remains outside admission's value, so a timeout retains finished rows.
    const outcome = await options.admission.admit<InterfacePage>({ workload: 'interface', localConcurrency: 1,
      deadlineMs: options.admissionDeadlineMs, signal: req.signal, traceRouteKey: req.traceRouteKey,
      run: () => {
        const task = run().catch(error => { failure = error; throw error; });
        active.add(task);
        void task.finally(() => active.delete(task)).catch(() => {});
        return { promise: task, cancel: () => { sealed = true; abort.abort(); } };
      } });
    req.signal?.removeEventListener('abort', onAbort);
    if (outcome.kind === 'ok') return outcome.value;
    sealed = true;
    abort.abort();
    if (outcome.kind === 'error') throw failure instanceof Error ? failure : new Error('interface projection failed');
    if (outcome.kind === 'overloaded') {
      page.status = 'skipped'; page.fallback_reason = 'overloaded';
      return page;
    }
    const reason = outcome.kind === 'timeout' ? 'timeout' : 'cancelled';
    return interruptPage(reason);
  }

  const close = async () => {
    closed = true;
    await pool.close();
    await Promise.allSettled(active);
  };
  return { get, close };
}
