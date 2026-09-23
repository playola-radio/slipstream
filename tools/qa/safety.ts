/**
 * Safety rails for the QA harness. The harness creates, writes into, and later
 * DELETES a root directory, so before it touches anything it must prove the
 * target is a harness-owned sandbox and not the operator's real Slipstream store.
 *
 * Two independent guards, mirroring the daemon's own posture:
 *  - a canonical-path overlap check against the real default store
 *    (`~/.slipstream`), so `--root ~/.slipstream` (or any path overlapping it)
 *    is refused and never touched; and
 *  - an ownership marker file plus a control-socket liveness probe, so the
 *    harness never reuses a root whose daemon is still live or whose ownership
 *    is ambiguous, and never deletes a root it did not create.
 */
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { defaultDaemonStore } from '../../src/daemon-location.ts';
import { FILE_MODE } from '../../src/storage.ts';

export const OWNER_MARKER_NAME = '.slipstream-qa-owner.json';
export const OWNER_FORMAT = 'slipstream-qa-owner.v1';

export interface OwnerMarker {
  format: string;
  run_id: string;
  created_at_ms: number;
  pid: number;
}

/** A path-segment-aware "is `child` strictly inside `parent`". A shared string
 * prefix (`.slipstream-qa` vs `.slipstream`) is NOT containment: `relative`
 * yields a `..`-leading path for a sibling, so only a genuine descendant passes. */
export function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Two paths overlap when they are equal or one contains the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || isUnder(a, b) || isUnder(b, a);
}

/** Resolve `p` to an absolute path with every symlink in its EXISTING prefix
 * resolved, keeping any not-yet-created trailing segments verbatim. A QA root
 * usually does not exist yet, so a plain `realpath` would throw; canonicalizing
 * the existing prefix still defeats a symlink planted along the way. */
export async function canonicalize(p: string): Promise<string> {
  const abs = resolve(p);
  const remainder: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await realpath(cur);
      return remainder.length ? join(real, ...remainder) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached the root without an existing prefix
      remainder.unshift(basename(cur));
      cur = parent;
    }
  }
}

export interface RefuseReason { code: string; message: string }

/** Refuse a QA root that overlaps the operator's real default store. Compares
 * canonical paths so a symlinked root cannot smuggle its way onto `~/.slipstream`. */
export async function checkRootAgainstRealStore(
  root: string,
  realStore: string = defaultDaemonStore(),
): Promise<RefuseReason | null> {
  const cr = await canonicalize(root);
  const cs = await canonicalize(realStore);
  if (pathsOverlap(cr, cs)) {
    return {
      code: 'REFUSED_REAL_STORE',
      message: `refusing QA root ${root}: it overlaps the real daemon store ${realStore}`,
    };
  }
  return null;
}

/** Write the harness ownership marker atomically, owner-only. Its presence is
 * the sole license to later delete the root. */
export async function writeOwnerMarker(root: string, runId: string): Promise<void> {
  const marker: OwnerMarker = {
    format: OWNER_FORMAT,
    run_id: runId,
    created_at_ms: Date.now(),
    pid: process.pid,
  };
  const path = join(root, OWNER_MARKER_NAME);
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, 'wx', FILE_MODE);
  try {
    await handle.writeFile(Buffer.from(JSON.stringify(marker), 'utf8'));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

/** Read and validate the ownership marker. Any missing/foreign/malformed file
 * reads as "not owned" (null), never a throw. */
export async function readOwnerMarker(root: string): Promise<OwnerMarker | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, OWNER_MARKER_NAME), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (m.format !== OWNER_FORMAT || typeof m.run_id !== 'string'
    || typeof m.created_at_ms !== 'number' || typeof m.pid !== 'number') {
    return null;
  }
  return { format: OWNER_FORMAT, run_id: m.run_id, created_at_ms: m.created_at_ms, pid: m.pid };
}

/** The verdict of `probe`: whether a daemon is live in the root's store. `none`
 * means no control socket at all. */
export type DaemonLiveness = 'live' | 'stale' | 'ambiguous' | 'none';

export type RootVerdict =
  | { ok: true; existed: boolean; owned: boolean }
  | { ok: false; code: string; message: string };

async function isEmptyDir(dir: string): Promise<boolean> {
  const entries = await readdir(dir);
  return entries.length === 0;
}

/**
 * Decide whether the harness may use `root`.
 *
 * Fresh mode (default) requires the root to be absent or empty. Reuse mode
 * requires a harness-owned root (valid ownership marker). Either way, a root
 * whose store still answers on its control socket (or answers ambiguously) is
 * refused so a second invocation can never disrupt a live daemon.
 */
export async function evaluateRoot(
  root: string,
  opts: { reuse: boolean; probe: (storeDir: string) => Promise<DaemonLiveness> },
): Promise<RootVerdict> {
  let st;
  try {
    st = await lstat(root);
  } catch {
    // Absent root.
    if (opts.reuse) {
      return { ok: false, code: 'ROOT_NOT_OWNED', message: `--reuse requires an existing harness-owned root; ${root} does not exist` };
    }
    return { ok: true, existed: false, owned: false };
  }

  if (!st.isDirectory()) {
    return { ok: false, code: 'ROOT_NOT_DIRECTORY', message: `${root} exists and is not a directory` };
  }

  const owned = (await readOwnerMarker(root)) !== null;

  // A daemon still live (or ambiguously live) in this root's store is never
  // disturbed — this is what makes a second concurrent invocation fail safely.
  const liveness = await opts.probe(join(root, 'store'));
  if (liveness === 'live' || liveness === 'ambiguous') {
    return { ok: false, code: 'ROOT_DAEMON_LIVE', message: `a daemon is still running in ${root}; refusing to reuse it` };
  }

  if (opts.reuse) {
    if (!owned) {
      return { ok: false, code: 'ROOT_NOT_OWNED', message: `--reuse refuses ${root}: no harness ownership marker (ambiguous ownership)` };
    }
    return { ok: true, existed: true, owned: true };
  }

  // Fresh mode: an empty directory is fine; anything with contents is not.
  if (await isEmptyDir(root)) return { ok: true, existed: true, owned };
  return { ok: false, code: 'ROOT_NOT_FRESH', message: `${root} already exists and is not empty; use --reuse or choose a fresh --root` };
}

/** Create the sandbox layout under an approved root: the marker, the store dir,
 * and the worktree dir. Idempotent for `--reuse` (dirs may already exist). */
export async function prepareRoot(root: string, runId: string): Promise<{ store: string; worktree: string }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await readOwnerMarker(root)) === null) await writeOwnerMarker(root, runId);
  const store = join(root, 'store');
  const worktree = join(root, 'worktree');
  await mkdir(store, { recursive: true, mode: 0o700 });
  await mkdir(worktree, { recursive: true, mode: 0o700 });
  return { store, worktree };
}
