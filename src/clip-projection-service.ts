/**
 * Main-thread orchestrator for the clip projection. It turns a change's
 * before/after snapshots into a {@link ClipProjection}, computed on demand from
 * the immutable blobs and cached disposably (no log, no persistence). It layers
 * four concerns on top of the pure core:
 *
 *  - Content-addressed LRU cache: keyed by (before tag, after tag,
 *    projection_version) so identical blobs across changes reuse one result,
 *    bounded by entry count AND estimated bytes. change_seq is response-only and
 *    is stamped on the way out, never part of the key.
 *  - Bounded admission: at most `concurrency` computes run at once behind a
 *    bounded queue; excess is returned immediately as `skipped`/`overloaded`
 *    (never a silent stall), so a burst of cold-cache requests cannot starve
 *    capture. The CPU itself runs off the shared event loop in a worker.
 *  - In-flight coalescing: identical concurrent requests share one compute.
 *  - Revalidate-on-hit: a cache hit is dropped if a referenced blob is gone
 *    (GC'd), so a stale result never masquerades as available.
 *
 * Availability, overload, and timeout dispositions are NOT pure functions of
 * content, so they are never cached.
 */
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { blobPath } from './store-reader.ts';
import {
  CLIP_PROJECTION_VERSION,
  type ClipProjection,
  type ProjectOptions,
} from './clip-projection.ts';
import { computeClipProjection, type ClipJob, type ClipSnapshot } from './clip-blob-reader.ts';
import { createClipWorkerPool, type ClipCompute } from './clip-worker-pool.ts';

export interface ClipRequest {
  changeSeq: string;
  before: ClipSnapshot;
  after: ClipSnapshot;
}

export interface ClipProjectionService {
  get(req: ClipRequest): Promise<ClipProjection>;
  close(): Promise<void>;
}

export interface ClipServiceOptions {
  storeDir: string;
  /** Compute seam. Defaults to a worker-thread pool of `concurrency` workers. */
  compute?: ClipCompute;
  /** Blob-presence probe for revalidate-on-hit. Defaults to a filesystem check. */
  hasBlob?: (sha256: string) => Promise<boolean>;
  concurrency?: number;
  queueLimit?: number;
  cacheEntries?: number;
  cacheBytes?: number;
  deadlineMs?: number;
  projectOptions?: Omit<ProjectOptions, 'changeSeq'>;
}

const DEFAULTS = {
  concurrency: 1,
  queueLimit: 8,
  cacheEntries: 512,
  cacheBytes: 4 * 1024 * 1024,
  deadlineMs: 100,
};

/** Reasons that are transient or availability-dependent — never cached. */
const UNCACHEABLE_REASONS = new Set(['overloaded', 'timeout', 'worker-error']);

const DEADLINE = Symbol('deadline');

function sideTag(s: ClipSnapshot): string {
  if (s.kind === 'content') return `content:${s.sha256}`;
  if (s.kind === 'absent') return 'absent';
  return `unavailable:${s.reason}`;
}

function cacheKey(req: ClipRequest): string {
  return `${sideTag(req.before)}|${sideTag(req.after)}|${CLIP_PROJECTION_VERSION}`;
}

function contentShas(req: ClipRequest): string[] {
  const out: string[] = [];
  if (req.before.kind === 'content') out.push(req.before.sha256);
  if (req.after.kind === 'content') out.push(req.after.sha256);
  return out;
}

function transient(changeSeq: string, reason: string): ClipProjection {
  return {
    change_seq: changeSeq,
    projection_version: CLIP_PROJECTION_VERSION,
    status: 'skipped',
    fallback_reason: reason,
    clips: [],
  };
}

function cacheable(value: ClipProjection): boolean {
  if (value.status === 'unavailable') return false;
  return !(value.fallback_reason !== undefined && UNCACHEABLE_REASONS.has(value.fallback_reason));
}

interface CacheEntry { value: ClipProjection; bytes: number }

/** Insertion-ordered LRU bounded by entry count and estimated bytes. */
class LruCache {
  private readonly map = new Map<string, CacheEntry>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  constructor(maxEntries: number, maxBytes: number) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get(key: string): ClipProjection | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry); // move to most-recently-used
    return entry.value;
  }

  set(key: string, value: ClipProjection): void {
    const existing = this.map.get(key);
    if (existing) { this.bytes -= existing.bytes; this.map.delete(key); }
    const bytes = JSON.stringify(value).length;
    this.map.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.map.get(oldest)!.bytes;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (entry) { this.bytes -= entry.bytes; this.map.delete(key); }
  }
}

interface Task { key: string; job: ClipJob; settle: (v: ClipProjection) => void }

export function createClipProjectionService(opts: ClipServiceOptions): ClipProjectionService {
  const concurrency = opts.concurrency ?? DEFAULTS.concurrency;
  const queueLimit = opts.queueLimit ?? DEFAULTS.queueLimit;
  const deadlineMs = opts.deadlineMs ?? DEFAULTS.deadlineMs;
  const pool = opts.compute ? null : createClipWorkerPool(concurrency);
  const compute: ClipCompute = opts.compute ?? pool!.run;
  const hasBlob = opts.hasBlob ?? ((sha256: string) =>
    access(blobPath(opts.storeDir, sha256), constants.F_OK).then(() => true, () => false));
  const cache = new LruCache(
    opts.cacheEntries ?? DEFAULTS.cacheEntries,
    opts.cacheBytes ?? DEFAULTS.cacheBytes,
  );
  const inFlight = new Map<string, Promise<ClipProjection>>();

  let active = 0;
  const queue: Task[] = [];

  const stamp = (value: ClipProjection, changeSeq: string): ClipProjection =>
    ({ ...value, change_seq: changeSeq });

  const raceDeadline = (p: Promise<ClipProjection>): Promise<ClipProjection | typeof DEADLINE> => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), deadlineMs);
      timer.unref(); // a pending deadline must never hold the process open
    });
    return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
  };

  const runTask = (task: Task): void => {
    active++;
    const handle = compute(task.job);
    raceDeadline(handle.promise)
      .then((outcome) => {
        const value = outcome === DEADLINE
          ? (handle.cancel(), transient(task.job.opts.changeSeq, 'timeout'))
          : outcome;
        if (cacheable(value)) cache.set(task.key, value);
        task.settle(value);
      })
      .catch(() => task.settle(transient(task.job.opts.changeSeq, 'worker-error')))
      .finally(() => {
        active--;
        const next = queue.shift();
        if (next) runTask(next);
      });
  };

  const blobsPresent = async (req: ClipRequest): Promise<boolean> => {
    for (const sha of contentShas(req)) if (!(await hasBlob(sha))) return false;
    return true;
  };

  const get = async (req: ClipRequest): Promise<ClipProjection> => {
    const key = cacheKey(req);

    const hit = cache.get(key);
    if (hit) {
      if (await blobsPresent(req)) return stamp(hit, req.changeSeq);
      cache.delete(key); // referenced blob GC'd — never serve a stale hit
    }

    const flight = inFlight.get(key);
    if (flight) return stamp(await flight, req.changeSeq);

    // Admit before scheduling. Excess is skipped immediately, never queued
    // unboundedly, so a burst cannot stall behind the worker.
    if (active >= concurrency && queue.length >= queueLimit) {
      return transient(req.changeSeq, 'overloaded');
    }

    const job: ClipJob = {
      storeDir: opts.storeDir,
      before: req.before,
      after: req.after,
      opts: { ...opts.projectOptions, changeSeq: req.changeSeq },
    };
    const p = new Promise<ClipProjection>((resolve) => {
      const task: Task = { key, job, settle: resolve };
      if (active < concurrency) runTask(task); else queue.push(task);
    });
    inFlight.set(key, p);
    void p.finally(() => inFlight.delete(key));
    return stamp(await p, req.changeSeq);
  };

  const close = async (): Promise<void> => { await pool?.close(); };

  return { get, close };
}

export { computeClipProjection };
