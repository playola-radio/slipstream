/**
 * Main-thread orchestrator for the clip projection. It turns a change's
 * before/after snapshots into a {@link ClipProjection}, computed on demand from
 * the immutable blobs and cached disposably (no log, no persistence). It layers
 * four concerns on top of the pure core:
 *
 *  - Content-addressed LRU cache: keyed by (before tag, after tag,
 *    projection_version, language) so identical inputs across changes reuse one result,
 *    bounded by entry count AND estimated bytes. change_seq is response-only and
 *    is stamped on the way out, never part of the key.
 *  - Bounded admission via the shared projection budget: at most `concurrency`
 *    computes run at once behind a bounded queue; excess is returned immediately
 *    as `skipped`/`overloaded` (never a silent stall), so a burst of cold-cache
 *    requests cannot starve capture. The deadline is measured from admission
 *    (queue wait included). Coalescing and the deadline live in the budget so
 *    the same bound covers a future interface-projection workload too. The CPU
 *    itself runs off the shared event loop in a worker.
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
} from './clip-projection.ts';
import { type ClipSnapshot } from './clip-blob-reader.ts';
import { createClipWorkerPool, type ClipCompute } from './clip-worker-pool.ts';
import { createProjectionAdmission } from './projection-admission.ts';
import type { ClipLanguage } from './clip-language.ts';

export interface ClipRequest {
  changeSeq: string;
  language?: ClipLanguage;
  before: ClipSnapshot;
  after: ClipSnapshot;
}

export interface ClipProjectionService {
  get(req: ClipRequest): Promise<ClipProjection>;
  close(): Promise<void>;
}

export interface ClipServiceOptions {
  storeDir: string;
  /** Compute seam. Defaults to a single clip-projection worker thread. */
  compute?: ClipCompute;
  /** Blob-presence probe for revalidate-on-hit. Defaults to a filesystem check. */
  hasBlob?: (sha256: string) => Promise<boolean>;
  queueLimit?: number;
  cacheEntries?: number;
  cacheBytes?: number;
  deadlineMs?: number;
}

// B1 runs exactly one clip worker (CPU stays off the capture path); concurrency
// is a fixed design constant, not a knob.
const CONCURRENCY = 1;

const DEFAULTS = {
  queueLimit: 8,
  cacheEntries: 512,
  cacheBytes: 4 * 1024 * 1024,
  deadlineMs: 100,
};

/** Reasons that are transient or availability-dependent — never cached. */
const UNCACHEABLE_REASONS = new Set(['overloaded', 'timeout', 'worker-error']);

function sideTag(s: ClipSnapshot): string {
  if (s.kind === 'content') return `content:${s.sha256}`;
  if (s.kind === 'absent') return 'absent';
  return `unavailable:${s.reason}`;
}

function cacheKey(req: ClipRequest): string {
  return `${sideTag(req.before)}|${sideTag(req.after)}|${CLIP_PROJECTION_VERSION}|${req.language ?? 'unsupported'}`;
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
  if (value.fallback_reason !== undefined && UNCACHEABLE_REASONS.has(value.fallback_reason)) return false;
  // A per-side `unavailable` method reflects blob presence at compute time, not
  // content, so a later restore must recompute rather than serve the stale
  // "before-missing" disposition. Revalidate-on-hit can't catch this: the
  // snapshot still names a content sha whose blob is now back.
  for (const clip of value.clips) {
    if (clip.before.method === 'unavailable' || clip.after.method === 'unavailable') return false;
  }
  return true;
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

export function createClipProjectionService(opts: ClipServiceOptions): ClipProjectionService {
  const queueLimit = opts.queueLimit ?? DEFAULTS.queueLimit;
  const deadlineMs = opts.deadlineMs ?? DEFAULTS.deadlineMs;
  const pool = opts.compute ? null : createClipWorkerPool();
  const compute: ClipCompute = opts.compute ?? pool!.run;
  const hasBlob = opts.hasBlob ?? ((sha256: string) =>
    access(blobPath(opts.storeDir, sha256), constants.F_OK).then(() => true, () => false));
  const cache = new LruCache(
    opts.cacheEntries ?? DEFAULTS.cacheEntries,
    opts.cacheBytes ?? DEFAULTS.cacheBytes,
  );
  // Concurrency, queue, coalesced-waiter bound, and the admission-time deadline
  // live in the shared budget. Clip's own budget uses C = CONCURRENCY (1) and
  // W = Q = queueLimit, so the outstanding ceiling stays C + queueLimit exactly
  // (coalesced waiters counted), reproducing the prior `maxPending` bound. The
  // budget is workload-agnostic so a future interface service can share one
  // instance; wiring that shared instance is a later step (see ADMISSION.md).
  const budget = createProjectionAdmission({
    C: CONCURRENCY,
    Q: queueLimit,
    W: queueLimit,
    D: deadlineMs,
  });
  let closed = false;

  const stamp = (value: ClipProjection, changeSeq: string): ClipProjection =>
    ({ ...value, change_seq: changeSeq });

  const blobsPresent = async (req: ClipRequest): Promise<boolean> => {
    for (const sha of contentShas(req)) if (!(await hasBlob(sha))) return false;
    return true;
  };

  const get = async (req: ClipRequest): Promise<ClipProjection> => {
    if (closed) return transient(req.changeSeq, 'worker-error');
    const key = cacheKey(req);

    const hit = cache.get(key);
    if (hit) {
      if (await blobsPresent(req)) return stamp(hit, req.changeSeq);
      cache.delete(key); // referenced blob GC'd — never serve a stale hit
    }

    const outcome = await budget.admit<ClipProjection>({
      workload: 'clip',
      localConcurrency: CONCURRENCY,
      key,
      run: () => compute({
        storeDir: opts.storeDir,
        before: req.before,
        after: req.after,
        opts: { changeSeq: req.changeSeq, language: req.language },
      }),
    });

    switch (outcome.kind) {
      case 'ok':
        // Availability, overload, and timeout dispositions are never cached.
        if (cacheable(outcome.value)) cache.set(key, outcome.value);
        return stamp(outcome.value, req.changeSeq);
      case 'timeout':
        return transient(req.changeSeq, 'timeout');
      case 'overloaded':
        return transient(req.changeSeq, 'overloaded');
      // A closed budget or a failed compute both surface as worker-error, the
      // reason the service has always used for "no result from the worker".
      default:
        return transient(req.changeSeq, 'worker-error');
    }
  };

  const close = async (): Promise<void> => {
    closed = true;
    // Settle everything admitted to this service's budget, then terminate the
    // worker. (The budget here is private to this service; closing it never
    // affects another workload.)
    await budget.close();
    await pool?.close();
  };

  return { get, close };
}
