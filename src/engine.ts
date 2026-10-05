import { sep } from 'node:path';
import type { Log } from './log.ts';
import type { Reader } from './reader.ts';
import { snapshotsEqual, type Snapshot } from './snapshot.ts';

export interface EngineOptions {
  reader: Reader;
  /** The engine only appends; it neither tracks durability nor closes the log. */
  log: Pick<Log, 'append'>;
  /** Epoch-ms clock read the instant snapshot acquisition completes, to close the
   * observed interval. Injected for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

export interface Engine {
  /** Record a path's starting state without emitting a change (baseline). */
  setBaseline(path: string, snapshot: Snapshot): void;
  /**
   * Mark a path (usually a directory) whose prior state capture does not know:
   * its baseline could not be enumerated, or capture skipped it as out of
   * scope. It and its descendants with no recorded snapshot get an honest
   * `unavailable/baseline-unknown` before state instead of a fabricated `absent`.
   */
  markBaselineUnknown(relDir: string): void;
  /** Whether capture holds a snapshot for `path` (baselined or changed). */
  isRecorded(path: string): boolean;
  /** Signal that a path may have changed, observed at `observedAtMs`. */
  notify(path: string, observedAtMs: number): void;
  /** Resolve once all queued processing (and its appends) have settled. */
  drain(): Promise<void>;
  /** Discard notification metadata after `drain()` when durable recovery will
   * rebuild committed baselines from the log and filesystem. */
  resetNotifications(): void;
}

/** Whether `path` equals or sits under one of `scopes` (`''` covers every path).
 * Walks the path's ancestors, so the cost is its depth, not the scope count. */
export function isUnderUnknownScope(path: string, scopes: ReadonlySet<string>): boolean {
  if (scopes.has('')) return true;
  for (let p = path; ; ) {
    if (scopes.has(p)) return true;
    const i = p.lastIndexOf(sep);
    if (i < 0) return false;
    p = p.slice(0, i);
  }
}

/** Add an unknown scope only when no existing ancestor already covers it. When a
 * new ancestor arrives, its now-redundant descendants are discarded. */
export function addUnknownScope(scope: string, scopes: Set<string>): boolean {
  if (isUnderUnknownScope(scope, scopes)) return false;
  for (const existing of scopes) {
    if (scope === '' || existing.startsWith(`${scope}${sep}`)) scopes.delete(existing);
  }
  scopes.add(scope);
  return true;
}

/**
 * Per-path serialized capture. Each path compares the freshly-read snapshot
 * against the *last committed* snapshot — never against whatever is on disk
 * when the read runs — so racing writes cannot corrupt the recorded `before`.
 * Notifies arriving while a path is being processed coalesce into a single
 * follow-up cycle; a state skipped that way is surfaced as a capture gap.
 */
export function createEngine({ reader, log, now = Date.now }: EngineOptions): Engine {
  const committed = new Map<string, Snapshot>();
  const pending = new Map<string, number>(); // path -> earliest observed_at_ms
  const coalesced = new Set<string>();
  const processing = new Set<string>();
  const inflight = new Set<Promise<void>>();
  const baselineUnknown = new Set<string>(); // dirs whose baseline scan failed

  const setBaseline = (path: string, snapshot: Snapshot): void => {
    committed.set(path, snapshot);
  };

  const markBaselineUnknown = (relDir: string): void => {
    addUnknownScope(relDir, baselineUnknown);
  };

  const isRecorded = (path: string): boolean => committed.has(path);

  // The prior state of a path we never baselined is honestly unknown when its
  // directory could not be scanned; elsewhere, no baseline means it did not
  // exist yet.
  const priorFor = (path: string): Snapshot =>
    isUnderUnknownScope(path, baselineUnknown) ? { kind: 'unavailable', reason: 'baseline-unknown' } : { kind: 'absent' };

  const notify = (path: string, observedAtMs: number): void => {
    const prior = pending.get(path);
    pending.set(path, prior === undefined ? observedAtMs : Math.min(prior, observedAtMs));
    if (processing.has(path)) {
      coalesced.add(path); // a notify landed while this path was being read
      return;
    }
    processing.add(path);
    // A processing failure (e.g. the log poisoned itself after a write error)
    // must be surfaced, never left as an unhandled rejection that crashes the
    // watcher. The log's own failure is the durable signal; this is the console.
    const task = processLoop(path)
      .catch((err: unknown) => {
        console.error(`slipstream: capture processing error for ${path}: ${(err as Error).message}`);
      })
      .finally(() => inflight.delete(task));
    inflight.add(task);
  };

  const handleOnce = async (path: string, observedAtMs: number, wasCoalesced: boolean): Promise<void> => {
    const after = await reader.read(path);
    // Close the observation interval the instant acquisition finishes. A regressed
    // clock (end < start) is recorded truthfully, never clamped into a fabricated
    // interval — interpretation handles the inversion, capture does not lie.
    const endMs = now();
    const before = committed.get(path) ?? priorFor(path);
    if (snapshotsEqual(before, after)) {
      // Nothing to record — but if we coalesced, an intermediate state may have
      // existed and been lost. Surface that honestly rather than silently.
      if (wasCoalesced) {
        await log.append({
          type: 'slipstream.capture.gap.v1',
          occurred_at_ms: observedAtMs,
          data: { scope: { kind: 'path', path }, reason: 'coalesced' },
        });
      }
      return;
    }
    await log.append({
      type: 'slipstream.file.changed.v1',
      occurred_at_ms: observedAtMs,
      data: {
        path,
        before,
        after,
        observation: 'watcher',
        coalesced: wasCoalesced,
        observed_interval_ms: { start_ms: observedAtMs, end_ms: endMs },
      },
    });
    committed.set(path, after);
  };

  const processLoop = async (path: string): Promise<void> => {
    try {
      // No `await` may sit between the emptiness check and processing.delete
      // below, or a concurrent notify could be dropped. Both are synchronous.
      for (;;) {
        const observedAtMs = pending.get(path);
        if (observedAtMs === undefined) break;
        pending.delete(path);
        const wasCoalesced = coalesced.delete(path);
        await handleOnce(path, observedAtMs, wasCoalesced);
      }
    } finally {
      processing.delete(path);
    }
  };

  const drain = async (): Promise<void> => {
    while (inflight.size > 0) {
      await Promise.all([...inflight]);
    }
  };

  const resetNotifications = (): void => {
    pending.clear();
    coalesced.clear();
  };

  return { setBaseline, markBaselineUnknown, isRecorded, notify, drain, resetNotifications };
}
