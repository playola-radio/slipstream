import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireSessionLock, SessionOwnedError } from './lock.ts';
import { withTempDir } from './test/helpers.ts';

// A pid far above any platform's pid_max: guaranteed not to name a live process.
const DEAD_PID = 2147483647;

/** The pid recorded in a lock file (content is JSON: `{pid, nonce}`). */
async function lockPid(path: string): Promise<number> {
  return (JSON.parse(await readFile(path, 'utf8')) as { pid: number }).pid;
}

describe('lock', () => {
  it('writes an owner lockfile holding this process pid, owner-only', async () => {
    await withTempDir(async (dir) => {
      const lock = await acquireSessionLock(dir);
      try {
        const lockPath = join(dir, 'owner.lock');
        assert.equal(await lockPid(lockPath), process.pid);
        assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
      } finally {
        await lock.release();
      }
    });
  });

  it('refuses a session already held by a live process', async () => {
    await withTempDir(async (dir) => {
      const lock = await acquireSessionLock(dir);
      try {
        await assert.rejects(acquireSessionLock(dir), SessionOwnedError);
      } finally {
        await lock.release();
      }
    });
  });

  it('reclaims a stale lock left by a dead process', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'owner.lock'), String(DEAD_PID));
      const lock = await acquireSessionLock(dir);
      try {
        assert.equal(await lockPid(join(dir, 'owner.lock')), process.pid);
      } finally {
        await lock.release();
      }
    });
  });

  it('is not wedged by a reclaim artifact left behind when a reclaimer crashed', async () => {
    await withTempDir(async (dir) => {
      // A stale lock plus a leftover reclaim file (as a crash mid-reclaim would
      // leave) must not block a fresh start: reclaim uses uniquely-named,
      // ignorable artifacts, never a persistent mutex that outlives its holder.
      await writeFile(join(dir, 'owner.lock'), String(DEAD_PID));
      await writeFile(join(dir, `owner.lock.reclaiming.${'0'.repeat(8)}`), String(DEAD_PID));
      const lock = await acquireSessionLock(dir);
      try {
        assert.equal(await lockPid(join(dir, 'owner.lock')), process.pid);
      } finally {
        await lock.release();
      }
    });
  });

  it('lets a released session be re-acquired', async () => {
    await withTempDir(async (dir) => {
      const first = await acquireSessionLock(dir);
      await first.release();
      const second = await acquireSessionLock(dir);
      await second.release();
    });
  });

  it('reports compromise and spares the successor lock when taken over', async () => {
    await withTempDir(async (dir) => {
      let reason: string | undefined;
      const lock = await acquireSessionLock(dir, { onCompromised: (r) => (reason = r) });
      // A concurrent reclaimer republishes owner.lock under a different pid. The
      // heartbeat must notice our pid is gone and report the loss — a live owner
      // must never keep writing to a log it no longer owns. This is the backstop
      // for the reclaim race that no pure-Node stale-break primitive can prevent.
      await writeFile(join(dir, 'owner.lock'), String(DEAD_PID));
      const deadline = Date.now() + 8000;
      while (reason === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.match(String(reason), /taken over/);
      // release() after compromise must not delete the successor's lock.
      await lock.release();
      assert.equal((await readFile(join(dir, 'owner.lock'), 'utf8')).trim(), String(DEAD_PID));
    });
  });
});
