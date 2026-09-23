import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { stopProc } from './harness-proc.ts';

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
