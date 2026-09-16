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

  const setBaseline = (path: string, snapshot: Snapshot): void => {
    committed.set(path, snapshot);
  };

  const notify = (path: string, observedAtMs: number): void => {
    const prior = pending.get(path);
    pending.set(path, prior === undefined ? observedAtMs : Math.min(prior, observedAtMs));
    if (processing.has(path)) {
      coalesced.add(path); // a notify landed while this path was being read
      return;
    }
    processing.add(path);
    const task = processLoop(path).finally(() => inflight.delete(task));
    inflight.add(task);
  };

  const handleOnce = async (path: string, observedAtMs: number, wasCoalesced: boolean): Promise<void> => {
    const after = await reader.read(path);
    const before = committed.get(path) ?? { kind: 'absent' };
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

  return { setBaseline, notify, drain };
}
