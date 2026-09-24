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
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
 * yields a `..`-leading path for a sibling. We test containment by SEGMENT, not
 * by a naive `startsWith('..')` — a legitimate child named `..qa` yields the
 * relative path `..qa`, which is a descendant, not an ascent. */
export function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '' || isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + sep);
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

/** Claim the harness ownership marker atomically, owner-only: first-writer-wins.
 * Its presence is the sole license to later delete the root. Returns `false`
 * without touching the existing marker if a concurrent claimant already won —
 * `link()` either creates the destination or fails, so two racing invocations
 * can never have one silently clobber the other's marker (unlike `rename`,
 * which always succeeds and would let the second claimant overwrite the
 * first's ownership out from under it). */
export async function writeOwnerMarker(root: string, runId: string): Promise<boolean> {
  const marker: OwnerMarker = {
    format: OWNER_FORMAT,
    run_id: runId,
    created_at_ms: Date.now(),
    pid: process.pid,
  };
  const path = join(root, OWNER_MARKER_NAME);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', FILE_MODE);
  try {
    await handle.writeFile(Buffer.from(JSON.stringify(marker), 'utf8'));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
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
  | { ok: true }
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
    return { ok: true };
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
    return { ok: true };
  }

  // Fresh mode: an empty directory is fine; anything with contents is not.
  if (await isEmptyDir(root)) return { ok: true };
  return { ok: false, code: 'ROOT_NOT_FRESH', message: `${root} already exists and is not empty; use --reuse or choose a fresh --root` };
}

/** Refuse a layout directory that is a symlink. `mkdir(..., {recursive:true})`
 * silently follows a pre-planted `store`/`worktree` symlink, so writes (and later
 * a recursive delete) could escape the sandbox into whatever it points at. A real
 * directory is required; a symlink is a refusal, never a follow. */
async function assertRealDir(path: string): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return; // absent — mkdir will create a real directory
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing QA layout dir ${path}: it is a symlink; writes must not escape the sandbox`);
  }
  if (!st.isDirectory()) {
    throw new Error(`refusing QA layout dir ${path}: it exists and is not a directory`);
  }
}

/** Validate an ALREADY-created sandbox worktree (the `--env` case, where the
 * daemon made the layout and qa-check only connects to it). Unlike `assertRealDir`,
 * which tolerates an absent path because `mkdir` will create it, here the worktree
 * must already EXIST and be a real directory: acceptance checks write and delete
 * inside it, so a symlink would let those escape the sandbox, and an ownership
 * marker on the parent root does not vouch for the worktree entry itself. Returns a
 * reason string when refused, or null when the worktree is a safe real directory. */
export async function checkExistingRealDir(path: string): Promise<string | null> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return `${path} does not exist; refusing to run against a missing worktree`;
  }
  if (st.isSymbolicLink()) {
    return `${path} is a symlink; refusing to run — writes must not escape the sandbox`;
  }
  if (!st.isDirectory()) {
    return `${path} exists and is not a directory`;
  }
  return null;
}

/** Create the sandbox layout under an approved root: the marker, the store dir,
 * and the worktree dir. Idempotent for `--reuse` (dirs may already exist). The
 * store and worktree must be real directories — a symlinked one is refused so
 * neither a write nor the later cleanup can escape the sandbox.
 *
 * Claiming the marker is unconditional and atomic (`writeOwnerMarker`'s
 * first-writer-wins `link`), never a check-then-act: two concurrent callers
 * racing on the same fresh root must not both believe they own it. A losing
 * claim is tolerated in exactly two cases:
 *  - the winning marker is already ours (a retry under the same `runId`); or
 *  - `opts.reuse` is set and a valid marker exists — an explicit `--reuse` of a
 *    root a prior run kept. The `runId` here is only a per-spawn launch nonce, so
 *    it legitimately differs from the id the keep run stamped; we adopt the kept
 *    root and leave its marker untouched (`evaluateRoot` already refused a live or
 *    ambiguous daemon before we got here, so the keep run is provably gone).
 * Any other lost claim — a foreign marker on a FRESH run — means a second run
 * genuinely raced us, and we refuse rather than write into or later delete a root
 * we do not own. */
export async function prepareRoot(
  root: string,
  runId: string,
  opts: { reuse?: boolean } = {},
): Promise<{ store: string; worktree: string }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const claimed = await writeOwnerMarker(root, runId);
  if (!claimed) {
    const marker = await readOwnerMarker(root);
    const tolerated = marker !== null && (opts.reuse === true || marker.run_id === runId);
    if (!tolerated) {
      throw new Error(`refusing QA root ${root}: a concurrent run claimed ownership first`);
    }
  }
  const store = join(root, 'store');
  const worktree = join(root, 'worktree');
  await assertRealDir(store);
  await assertRealDir(worktree);
  await mkdir(store, { recursive: true, mode: 0o700 });
  await mkdir(worktree, { recursive: true, mode: 0o700 });
  return { store, worktree };
}

/** Whether the harness may delete `root`: only when it still carries THIS run's
 * ownership marker. A missing marker, or one written by another run (a root that
 * was replaced or re-claimed since we created it), refuses deletion — the harness
 * never deletes a directory it does not currently own. */
export async function mayDeleteRoot(root: string, runId: string): Promise<boolean> {
  const marker = await readOwnerMarker(root);
  return marker !== null && marker.run_id === runId;
}
