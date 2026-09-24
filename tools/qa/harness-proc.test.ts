import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startQaDaemon, stopProc } from './harness-proc.ts';

/** Spawn a node child that installs `onTerm` as its SIGTERM handler, then prints
 * a READY line. We only signal it after READY, so the handler is guaranteed
 * installed and the child's chosen exit code (not a race with default SIGTERM
 * termination) is what stopProc observes. */
async function spawnReady(onTerm: string): Promise<ChildProcess> {
  const script = `process.on("SIGTERM",()=>{${onTerm}}); console.log("READY"); setInterval(()=>{}, 1e9);`;
  const proc = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on('data', (b: Buffer) => { if (b.toString().includes('READY')) resolve(); });
    proc.once('error', reject);
    proc.once('exit', () => reject(new Error('child exited before READY')));
  });
  return proc;
}

describe('stopProc teardown honesty', () => {
  it('resolves on a clean SIGTERM exit (code 0)', async () => {
    const proc = await spawnReady('process.exit(0)');
    await assert.doesNotReject(() => stopProc(proc));
  });

  it('rejects when the daemon exits non-zero during stop (unclean teardown)', async () => {
    const proc = await spawnReady('process.exit(3)');
    await assert.rejects(() => stopProc(proc), /exited 3 during stop \(unclean teardown\)/);
  });

  it('rejects when the daemon must be force-killed (ignores SIGTERM)', { timeout: 20_000 }, async () => {
    // Ignores SIGTERM, so stopProc's grace window escalates to SIGKILL — a wedged
    // shutdown, which is itself a teardown failure.
    const proc = await spawnReady('/* swallow */');
    await assert.rejects(() => stopProc(proc), /terminated by signal SIGKILL during stop \(unclean teardown\)/);
  });
});

describe('startQaDaemon keep → stop → reuse', () => {
  it('reuses a root a prior --keep run left behind, despite a fresh launch nonce', { timeout: 90_000 }, async () => {
    // The real regression: each startQaDaemon spawn mints its own readiness nonce,
    // so a --reuse spawn presents an ownership id different from the one the --keep
    // spawn stamped into the root's owner marker. Post-5a86f14 this made prepareRoot
    // refuse the kept root with "a concurrent run claimed ownership first". Short tmp
    // prefix keeps the control-socket path under macOS's ~104-byte UNIX_PATH_MAX.
    const parent = await mkdtemp(join(tmpdir(), 'ss-qa-r-'));
    const root = join(parent, 'root');
    try {
      const keep = await startQaDaemon({ root, keep: true });
      const sessionA = keep.env.session_id;
      await keep.stop();

      const reuse = await startQaDaemon({ root, reuse: true });
      try {
        // Distinct nonces prove this is the cross-nonce path, not a same-id retry.
        assert.notEqual(reuse.env.run_id, keep.env.run_id);
        // The retained marker identity travels separately, so --env sandbox
        // validation can prove ownership without weakening the fresh-nonce
        // readiness handshake.
        assert.equal(reuse.env.owner_run_id, keep.env.owner_run_id);
        // --reuse starts a fresh session against the retained store.
        assert.notEqual(reuse.env.session_id, sessionA);
      } finally {
        await reuse.stop();
      }
    } finally {
      await rm(dirname(root), { recursive: true, force: true }).catch(() => {});
    }
  });
});
