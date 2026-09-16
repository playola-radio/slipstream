import { sep } from 'node:path';
import type { Log } from './log.ts';
import type { Reader } from './reader.ts';
import { snapshotsEqual, type Snapshot } from './snapshot.ts';

export interface EngineOptions {
  reader: Reader;
  log: Log;
}

export interface Engine {
  /** Record a path's starting state without emitting a change (baseline). */
  setBaseline(path: string, snapshot: Snapshot): void;
  /**
   * Mark a directory whose baseline could not be enumerated. Descendants with
   * no observed baseline get an honest `unavailable/baseline-unknown` before
   * state instead of a fabricated `absent`.
   */
  markBaselineUnknown(relDir: string): void;
  /** Signal that a path may have changed, observed at `observedAtMs`. */
  notify(path: string, observedAtMs: number): void;
  /** Resolve once all queued processing (and its appends) have settled. */
  drain(): Promise<void>;
}

/**
 * Per-path serialized capture. Each path compares the freshly-read snapshot
 * against the *last committed* snapshot — never against whatever is on disk
 * when the read runs — so racing writes cannot corrupt the recorded `before`.
 * Notifies arriving while a path is being processed coalesce into a single
 * follow-up cycle; a state skipped that way is surfaced as a capture gap.
 */
export function createEngine({ reader, log }: EngineOptions): Engine {
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
    baselineUnknown.add(relDir);
  };

  // The prior state of a path we never baselined is honestly unknown when its
  // directory could not be scanned; elsewhere, no baseline means it did not
  // exist yet.
  const priorFor = (path: string): Snapshot => {
    for (const prefix of baselineUnknown) {
      if (prefix === '' || path === prefix || path.startsWith(prefix + sep)) {
        return { kind: 'unavailable', reason: 'baseline-unknown' };
      }
    }
    return { kind: 'absent' };
  };

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
    const before = committed.get(path) ?? priorFor(path);
    if (snapshotsEqual(before, after)) {
      // Nothing to record — but if we coalesced, an intermediate state may have
      // existed and been lost. Surface that honestly rather than silently.
      if (wasCoalesced) {
        await log.append({ type: 'capture.gap', path, reason: 'coalesced', observed_at_ms: observedAtMs });
      }
      return;
    }
    await log.append({ type: 'file.changed', path, before, after, observed_at_ms: observedAtMs, coalesced: wasCoalesced });
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

  return { setBaseline, markBaselineUnknown, notify, drain };
}
