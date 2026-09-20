/**
 * Drives one {@link createTranscriptWatcher} per configured harness on a polling
 * tick. It owns only scheduling: each watcher holds its own reader offsets and
 * the ingestor's dedup makes re-reads idempotent, so a tick is always safe to
 * repeat. A per-harness tick failure is routed to `onError` and never stops the
 * other harness — enrichment must degrade, never wedge (CLAUDE.md).
 */
import type { HarnessName } from '../event.ts';
import type { DiscoveryIO } from './discovery.ts';
import type { EvidenceSink, TranscriptFileIO } from './file-reader.ts';
import { createTranscriptWatcher, type CoveragePublish } from './watcher.ts';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface CoverageRunnerOptions {
  /** The harnesses declared `configured`; an unconfigured source is never read. */
  harnesses: readonly HarnessName[];
  homes: Record<HarnessName, string>;
  codexScanLimit: number;
  root: string;
  sink: EvidenceSink;
  publish: CoveragePublish;
  discoveryIO: DiscoveryIO;
  fileIO: TranscriptFileIO;
  intervalMs: number;
  setTimer?: (delayMs: number, fn: () => void) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onError?: (err: unknown) => void;
}

export interface CoverageRunner {
  /** Run one poll pass across every harness (deterministic seam for tests). */
  tick(): Promise<void>;
  /** Fire an immediate tick, then self-reschedule every `intervalMs`. */
  start(): void;
  /** Stop scheduling and await any in-flight tick. Idempotent. */
  stop(): Promise<void>;
}

export function createCoverageRunner(opts: CoverageRunnerOptions): CoverageRunner {
  const watchers = opts.harnesses.map((harness) =>
    createTranscriptWatcher({
      harness,
      home: opts.homes[harness],
      root: opts.root,
      codexScanLimit: opts.codexScanLimit,
      discoveryIO: opts.discoveryIO,
      fileIO: opts.fileIO,
      sink: opts.sink,
      publish: opts.publish,
    }),
  );
  const setTimer =
    opts.setTimer ??
    ((ms, fn): TimerHandle => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
  const clearTimer = opts.clearTimer ?? ((h): void => clearTimeout(h));

  let stopped = false;
  let timer: TimerHandle | undefined;
  let inflight: Promise<void> | undefined;

  const tick = async (): Promise<void> => {
    for (const w of watchers) {
      try {
        await w.tick();
      } catch (err) {
        opts.onError?.(err);
      }
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimer(opts.intervalMs, run);
  };

  const run = (): void => {
    if (stopped) return;
    timer = undefined;
    inflight = tick().finally(() => {
      inflight = undefined;
      schedule();
    });
  };

  const start = (): void => {
    if (stopped || timer !== undefined || inflight !== undefined) return;
    run();
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    if (inflight) await inflight.catch(() => {});
  };

  return { tick, start, stop };
}
