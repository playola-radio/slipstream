import { isAbsolute, join, relative } from 'node:path';
import type { Platform, Subscription, WatchOptions } from '../platform.ts';

/**
 * The single, centralized fake of the filesystem-observation boundary. Every
 * non-boundary test drives observations through this rather than hand-rolling
 * its own watcher stub — one fake, owned next to the real `Platform`, kept
 * honest by the shared contract in `platform-contract.ts`.
 *
 * Deliberately, it does NOT translate filesystem mutations into observations.
 * Tests mutate real temp files, then call `observe(path)` to deliver the
 * notification explicitly. Auto-observing every write would encode "one
 * notification per write" — the exact fidelity the real watcher cannot promise
 * (FSEvents coalesces; a metadata-only change may be suppressed) — and would let
 * a test certify a capture the OS would never deliver.
 */
export interface FakePlatform extends Platform {
  /** Deliver an observation for `path` (relative to the watched root, or
   *  absolute). Dropped if it falls inside an ignored subtree, matching the real
   *  boundary. No-op after `close()`. */
  observe(path: string, observedAtMs?: number): void;
  /** Deliver an observation-source error; the session surfaces it as a gap. */
  failWith(err: Error): void;
  readonly watching: boolean;
  readonly closed: boolean;
}

/** `abs` is ignored when it equals or sits under any (absolute, directory) ignore entry. */
function isIgnored(abs: string, ignore: readonly string[]): boolean {
  return ignore.some((entry) => {
    const rel = relative(entry, abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

export function createFakePlatform(): FakePlatform {
  let opts: WatchOptions | undefined;
  let closed = false;

  const watch = async (o: WatchOptions): Promise<Subscription> => {
    opts = o;
    closed = false;
    return {
      close: async () => {
        closed = true;
      },
    };
  };

  const observe = (path: string, observedAtMs: number = Date.now()): void => {
    if (!opts) throw new Error('FakePlatform.observe called before watch()');
    if (closed) return;
    const abs = isAbsolute(path) ? path : join(opts.root, path);
    if (isIgnored(abs, opts.ignore)) return;
    opts.onObservation(abs, observedAtMs);
  };

  const failWith = (err: Error): void => {
    if (!opts) throw new Error('FakePlatform.failWith called before watch()');
    if (closed) return;
    opts.onError(err);
  };

  return {
    watch,
    observe,
    failWith,
    get watching() {
      return opts !== undefined && !closed;
    },
    get closed() {
      return closed;
    },
  };
}
