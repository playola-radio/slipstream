/**
 * The daemon's one transcript discovery loop. Every capture that reads
 * transcripts registers here instead of running its own loop, so a cycle
 * enumerates the Codex sessions tree once and each Claude project directory once,
 * however many captures there are, and reads each transcript header once.
 *
 * Only discovery is shared. Each registration keeps its own watcher per harness —
 * its readers, offsets, backpressure, and coverage state — and the per-root
 * eligibility, evidence, and coverage rules are the ones a lone scan applies.
 * Sharing removes the multiplication; it does not make a truncated scan complete,
 * and the cadence is unchanged: the next cycle starts `pollIntervalMs` after the
 * previous one finishes.
 *
 * A failure in one harness's discovery or one capture's read is routed to
 * `onError` and never stops the others: enrichment degrades, never wedges.
 */
import type { HarnessName } from '../event.ts';
import { discoverRoots, type DiscoveryIO, type DiscoveryResult } from './discovery.ts';
import type { EvidenceSink, TranscriptFileIO } from './file-reader.ts';
import { nodeDiscoveryIO, nodeTranscriptFileIO } from './fs-io.ts';
import { createTranscriptWatcher, type CoveragePublish, type TranscriptWatcher } from './watcher.ts';

/** How long after one discovery cycle finishes the next one starts. */
export const DEFAULT_TRANSCRIPT_POLL_MS = 2000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface TranscriptSchedulerOptions {
  /** The harnesses declared `configured`; an unconfigured source is never read. */
  harnesses: readonly HarnessName[];
  homes: Record<HarnessName, string>;
  codexScanLimit: number;
  pollIntervalMs?: number;
  discoveryIO?: DiscoveryIO;
  fileIO?: TranscriptFileIO;
  setTimer?: (delayMs: number, fn: () => void) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onError?: (err: unknown) => void;
}

/** One capture's transcript reading: where its evidence and coverage go. */
export interface TranscriptRegistration {
  root: string;
  sink: EvidenceSink;
  publish: CoveragePublish;
}

export interface TranscriptScheduler {
  /** Read this capture's transcripts from the next cycle on (at once if idle).
   * Returns its unregister: no read for it starts afterwards, and it resolves once
   * any read already in flight for it has finished. Idempotent. */
  register(registration: TranscriptRegistration): () => Promise<void>;
  /** Run one shared cycle now, after any in-flight one (deterministic test seam). */
  tick(): Promise<void>;
}

interface Entry {
  root: string;
  watchers: Map<HarnessName, TranscriptWatcher>;
  active: boolean;
  inflight: Set<Promise<void>>;
}

export function createTranscriptScheduler(opts: TranscriptSchedulerOptions): TranscriptScheduler {
  const discoveryIO = opts.discoveryIO ?? nodeDiscoveryIO;
  const fileIO = opts.fileIO ?? nodeTranscriptFileIO;
  const intervalMs = opts.pollIntervalMs ?? DEFAULT_TRANSCRIPT_POLL_MS;
  const setTimer =
    opts.setTimer ??
    ((ms, fn): TimerHandle => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
  const clearTimer = opts.clearTimer ?? ((h): void => clearTimeout(h));
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // An error reporter that throws must not stop the loop.
    }
  };

  const entries = new Set<Entry>();
  let chain: Promise<void> = Promise.resolve();
  let timer: TimerHandle | undefined;
  let looping = false;

  const dispatch = (entry: Entry, harness: HarnessName, found: DiscoveryResult): Promise<void> | undefined => {
    if (!entry.active) return undefined;
    const work = entry.watchers.get(harness)!.apply(found).catch(report);
    entry.inflight.add(work);
    return work.finally(() => entry.inflight.delete(work));
  };

  const cycle = async (): Promise<void> => {
    for (const harness of opts.harnesses) {
      const due = [...entries];
      if (due.length === 0) return;
      let found: Map<string, DiscoveryResult>;
      try {
        found = await discoverRoots(
          harness,
          discoveryIO,
          opts.homes[harness],
          due.map((e) => e.root),
          opts.codexScanLimit,
        );
      } catch (err) {
        report(err);
        continue;
      }
      await Promise.all(due.map((e) => dispatch(e, harness, found.get(e.root)!)));
    }
  };

  const tick = (): Promise<void> => {
    const run = chain.then(cycle);
    chain = run;
    return run;
  };

  const loop = (): void => {
    timer = undefined;
    looping = true;
    void tick().finally(() => {
      looping = false;
      if (entries.size > 0 && timer === undefined) timer = setTimer(intervalMs, loop);
    });
  };

  const register = ({ root, sink, publish }: TranscriptRegistration): (() => Promise<void>) => {
    const entry: Entry = {
      root,
      watchers: new Map(
        opts.harnesses.map((harness) => [
          harness,
          createTranscriptWatcher({
            harness,
            home: opts.homes[harness],
            root,
            codexScanLimit: opts.codexScanLimit,
            discoveryIO,
            fileIO,
            sink,
            publish,
          }),
        ]),
      ),
      active: true,
      inflight: new Set(),
    };
    entries.add(entry);
    if (timer === undefined && !looping) loop();
    let unregistered: Promise<void> | undefined;
    return () =>
      (unregistered ??= (async () => {
        entry.active = false;
        entries.delete(entry);
        if (entries.size === 0 && timer !== undefined) {
          clearTimer(timer);
          timer = undefined;
        }
        await Promise.all([...entry.inflight]);
      })());
  };

  return { register, tick };
}
