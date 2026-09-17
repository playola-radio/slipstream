import watcher from '@parcel/watcher';

/**
 * The operating-system boundary — scoped deliberately to **filesystem
 * observation**. This is the one surface whose behavior diverges by platform
 * (FSEvents watches a subtree recursively; inotify installs per-directory
 * watches at subscribe time and does not re-add them when permissions change),
 * so it is the one surface worth a seam. Everything else Slipstream does to the
 * filesystem — reading, enumerating, appending the log — is portable and stays
 * real in tests. Do not let unrelated OS calls accumulate here.
 *
 * A `Platform` reports *that* a path may have changed; it deliberately does not
 * interpret create/update/delete, and it promises neither one observation per
 * write nor delivery of every metadata change. The engine re-derives true state
 * by reading disk and comparing against the last committed snapshot.
 */
export interface Platform {
  watch(opts: WatchOptions): Promise<Subscription>;
}

export interface Subscription {
  close(): Promise<void>;
}

export interface WatchOptions {
  root: string;
  /** Absolute paths / globs the observation source should never report. */
  ignore: string[];
  /** Called with an absolute path each time a change is observed. */
  onObservation(absPath: string, observedAtMs: number): void;
  /**
   * Called when the observation source reports an error. Delivery may have
   * lapsed, so the session surfaces this as an honest coverage gap rather than
   * letting it vanish. Never a crash.
   */
  onError(err: Error): void;
}

/** The real boundary: `@parcel/watcher` (FSEvents on macOS). */
export function createPlatform(): Platform {
  return {
    watch: async (opts) => {
      const subscription = await watcher.subscribe(
        opts.root,
        (err, events) => {
          if (err) {
            opts.onError(err); // surfaced as a coverage gap, never a crash
            return;
          }
          const observedAtMs = Date.now();
          for (const event of events) {
            opts.onObservation(event.path, observedAtMs);
          }
        },
        { ignore: opts.ignore },
      );

      return {
        close: () => subscription.unsubscribe(),
      };
    },
  };
}
