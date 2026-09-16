import watcher from '@parcel/watcher';

export interface Watcher {
  close(): Promise<void>;
}

export interface WatcherOptions {
  root: string;
  /** Absolute paths / globs the native watcher should never report. */
  ignore: string[];
  /** Called with an absolute path each time the watcher reports an event. */
  onEvent(absPath: string, observedAtMs: number): void;
}

/**
 * Thin adapter over @parcel/watcher (FSEvents on macOS). It reports *that* a
 * path may have changed; it deliberately does not interpret create/update/
 * delete, because the engine re-derives the true state by reading disk and
 * comparing to the last committed snapshot.
 */
export async function createWatcher(opts: WatcherOptions): Promise<Watcher> {
  const subscription = await watcher.subscribe(
    opts.root,
    (err, events) => {
      if (err) return; // transient watcher errors surface as coverage gaps, not crashes
      const observedAtMs = Date.now();
      for (const event of events) {
        opts.onEvent(event.path, observedAtMs);
      }
    },
    { ignore: opts.ignore },
  );

  return {
    close: () => subscription.unsubscribe(),
  };
}
