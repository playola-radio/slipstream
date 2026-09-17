import { isAbsolute, join, relative, sep } from 'node:path';
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
 *
 * It mirrors two properties of the real boundary so a test cannot rely on an
 * observation the OS would never deliver: a path resolving outside the watched
 * root is dropped, and a path inside an ignored subtree is dropped. `ignore`
 * entries are matched as literal directory paths, which is all `session.ts` ever
 * passes (the store dir and `.git`); the real adapter also accepts globs, but
 * none are used, so the fake does not model them.
 */
export interface FakePlatform extends Platform {
  /** Deliver an observation for `path` (relative to the watched root). Resolved
   *  to an absolute path under root, matching the real boundary's output.
   *  Dropped if it resolves outside root or inside an ignored subtree. No-op
   *  after `close()`. */
  observe(path: string, observedAtMs?: number): void;
  /** Deliver an observation-source error; the session surfaces it as a gap. */
  failWith(err: Error): void;
}

/** A relative path escapes its base only via a leading `..` segment (or when it
 * comes back absolute); a filename that merely starts with `..`, like
 * `..notes.ts`, stays inside. Mirrors `escapesBase` in session.ts. */
function escapesBase(rel: string): boolean {
  return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
}

/** `abs` is ignored when it equals or sits under any (absolute, directory) ignore entry. */
function isIgnored(abs: string, ignore: readonly string[]): boolean {
  return ignore.some((entry) => {
    const rel = relative(entry, abs);
    return rel === '' || !escapesBase(rel);
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
    const abs = join(opts.root, path);
    const rel = relative(opts.root, abs);
    if (rel === '' || escapesBase(rel)) return; // the real watcher never reports outside root
    if (isIgnored(abs, opts.ignore)) return;
    opts.onObservation(abs, observedAtMs);
  };

  const failWith = (err: Error): void => {
    if (!opts) throw new Error('FakePlatform.failWith called before watch()');
    if (closed) return;
    opts.onError(err);
  };

  return { watch, observe, failWith };
}
