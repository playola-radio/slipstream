import { link, lstat, open, readFile, rename, unlink, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FILE_MODE } from './storage.ts';

/**
 * A session has exactly one writer. O_APPEND is not a lock, so we take an
 * explicit lockfile: startup fails if another *live* process already owns the
 * session (ambiguous ownership is a hard error, per the durability design). A
 * stale lock left by a crash is reclaimed.
 *
 * Liveness is proven by a heartbeat, not by pid alone: the owner refreshes the
 * lockfile's mtime every {@link HEARTBEAT_MS}, and a lock unrefreshed within
 * {@link STALE_MS} is presumed abandoned and reclaimed. A dead pid on this host
 * is reclaimed immediately. Ownership is identified by a per-acquisition
 * **nonce**, not the pid — two acquisitions inside one process share a pid, so a
 * pid alone cannot tell an owner from its usurper.
 *
 * The heartbeat also guards its own lock: if another process replaces it (the
 * narrow reclaim race that no pure-Node stale-break primitive can fully prevent),
 * the dispossessed owner sees a foreign nonce and calls
 * {@link AcquireOptions.onCompromised} so it can stop writing. That reaction is a
 * detection backstop, not prevention: an append already in flight when the
 * callback fires cannot be un-written. Strict single-writer against *concurrent
 * same-session* daemon starts therefore rests on the launcher running one daemon
 * per worktree; the lock closes the cases that actually occur (refuse-if-live,
 * reclaim-after-crash) and detects the rest.
 */
export interface SessionLock {
  release(): Promise<void>;
}

export interface AcquireOptions {
  /**
   * Invoked at most once if the heartbeat finds our lock replaced by another
   * process: exclusive ownership has been lost and the caller MUST stop writing.
   */
  onCompromised?: (reason: string) => void;
}

export class SessionOwnedError extends Error {
  constructor(pid: number) {
    super(`session is already owned by a live process (pid ${pid})`);
    this.name = 'SessionOwnedError';
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process (stale). EPERM: exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockContent {
  pid?: number;
  nonce?: string;
}

/** Parse a lock file. Tolerant of a foreign/legacy bare-integer pid. */
function parseLock(text: string): LockContent {
  try {
    const obj = JSON.parse(text) as { pid?: unknown; nonce?: unknown };
    if (obj && typeof obj === 'object') {
      const pid =
        typeof obj.pid === 'number' && Number.isInteger(obj.pid) && obj.pid > 0 ? obj.pid : undefined;
      const nonce = typeof obj.nonce === 'string' && obj.nonce.length > 0 ? obj.nonce : undefined;
      return { pid, nonce };
    }
  } catch {
    // not JSON: fall through to a bare-pid read
  }
  const pid = Number.parseInt(text, 10);
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : undefined };
}

/**
 * Publish `content` at `lockPath` atomically: write+fsync a temp file, then
 * hardlink it into place. `link` fails EEXIST if the lock is held, and — unlike
 * open()+write — the visible lock is never observed empty, so no racing process
 * can mistake a half-created lock for a stale one. Returns false on EEXIST.
 */
async function publish(lockPath: string, content: string): Promise<boolean> {
  const tmp = `${lockPath}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', FILE_MODE);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Refresh cadence and the staleness horizon it must stay comfortably under. */
const HEARTBEAT_MS = 2_000;
/**
 * A lock unrefreshed for this long is abandoned. Six heartbeats of slack keeps a
 * live owner from being declared stale by a GC/scheduling pause, while still
 * reclaiming a hung owner promptly enough for a supervisor restart.
 */
const STALE_MS = 12_000;
const MAX_ACQUIRE_ATTEMPTS = 8;

export async function acquireSessionLock(
  sessionDir: string,
  options: AcquireOptions = {},
): Promise<SessionLock> {
  const lockPath = join(sessionDir, 'owner.lock');
  const myNonce = randomUUID();
  const content = JSON.stringify({ pid: process.pid, nonce: myNonce });

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    if (await publish(lockPath, content)) return makeLock(lockPath, myNonce, content, options.onCompromised);

    let st;
    try {
      st = await lstat(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // vanished; retry
      throw err;
    }
    const cur = parseLock(await readFile(lockPath, 'utf8').catch(() => ''));
    const stale = Date.now() - st.mtimeMs > STALE_MS;
    if (cur.pid !== undefined && isAlive(cur.pid) && !stale) throw new SessionOwnedError(cur.pid);

    // Reclaim only a provably-abandoned lock: a dead pid on this host, or one no
    // heartbeat has refreshed within STALE_MS. A fresh, unparseable lock is
    // foreign — fail closed (exhaust attempts) rather than delete it.
    const reclaimable = (cur.pid !== undefined && !isAlive(cur.pid)) || stale;
    if (!reclaimable) continue;

    // Break it without an ABA hole in the common (no live owner) case: rename it
    // aside — atomic, single-winner — then confirm the file we grabbed is exactly
    // the one we observed (same inode AND mtime; a refresh or a concurrent
    // republish changes one of them). If it changed under us, a live owner has
    // reclaimed it since our stat: restore it without overwriting a newer holder.
    // A live owner whose lock we transiently vacate re-asserts it via its own
    // heartbeat, so this path never permanently unseats a healthy owner.
    const grabbed = `${lockPath}.reclaiming.${randomUUID()}`;
    try {
      await rename(lockPath, grabbed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // lost the race; retry
      throw err;
    }
    let gst;
    try {
      gst = await lstat(grabbed);
    } catch {
      await unlink(grabbed).catch(() => {});
      continue;
    }
    if (gst.ino === st.ino && gst.mtimeMs === st.mtimeMs) {
      await unlink(grabbed).catch(() => {}); // exactly the observed stale lock: discard it
    } else {
      await link(grabbed, lockPath).catch(() => {}); // changed under us: put it back (no overwrite)
      await unlink(grabbed).catch(() => {});
    }
  }

  throw new Error('could not acquire session lock after repeated stale-lock reclaims');
}

function makeLock(
  lockPath: string,
  myNonce: string,
  content: string,
  onCompromised: ((reason: string) => void) | undefined,
): SessionLock {
  let done = false; // released or compromised: the heartbeat must stop acting
  let beating = false; // a beat is in flight; ticks do not overlap
  let inFlight: Promise<void> = Promise.resolve(); // the in-flight beat, so release can await it

  const surrender = (reason: string): void => {
    if (done) return;
    done = true;
    clearInterval(timer);
    onCompromised?.(reason);
  };

  const beat = async (): Promise<void> => {
    if (done) return;
    let text: string;
    try {
      text = await readFile(lockPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return; // transient; retry next tick
      // Our path is momentarily vacant: a reclaimer renamed it aside, or it was
      // removed. Re-assert ownership rather than surrender on a blip. If another
      // process now holds it, our re-publish fails EEXIST and we check its nonce.
      try {
        if (await publish(lockPath, content)) return; // re-established our lock
        text = await readFile(lockPath, 'utf8');
      } catch {
        return; // transient; retry next tick
      }
    }
    if (parseLock(text).nonce !== myNonce) {
      return surrender('lock was taken over by another process');
    }
    const now = Date.now() / 1000;
    await utimes(lockPath, now, now).catch(() => {}); // transient; the next tick retries
  };

  const timer = setInterval(() => {
    if (beating || done) return;
    beating = true;
    inFlight = beat().finally(() => { beating = false; });
  }, HEARTBEAT_MS);
  timer.unref?.();

  return {
    release: async () => {
      done = true;
      clearInterval(timer);
      // Await any in-flight heartbeat first: one whose read is mid-flight could
      // otherwise re-publish the lock (ENOENT re-assert) *after* we unlink it,
      // leaving an orphan holding our exiting pid. Letting it finish means the
      // nonce check below still owns whatever it left behind.
      await inFlight.catch(() => {});
      // Remove the lock only if it still carries OUR nonce — never delete a
      // successor's lock if we were quietly dispossessed before release.
      const cur = parseLock(await readFile(lockPath, 'utf8').catch(() => ''));
      if (cur.nonce === myNonce) await unlink(lockPath).catch(() => {});
    },
  };
}
