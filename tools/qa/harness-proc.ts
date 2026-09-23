/**
 * Spawn `qa-daemon` as a child process for the acceptance runner and for the
 * lifecycle/safety acceptance checks (which must observe a real second process,
 * not an in-process shortcut). Two shapes:
 *  - {@link startQaDaemon}: spawn and wait until it publishes a ready qa-env.json
 *    STAMPED WITH THIS LAUNCH'S NONCE, returning a handle whose `stop()` signals it
 *    and awaits exit under a bounded TERM→KILL escalation.
 *  - {@link runQaDaemonToExit}: spawn and wait for it to exit on its own — used to
 *    observe a refused invocation's non-zero exit and stderr.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readQaEnv, sleep, type QaEnv } from '../qa-support.ts';

const QA_DAEMON_PATH = fileURLToPath(new URL('../qa-daemon.ts', import.meta.url));

/** How long a `stop()` waits for a graceful SIGTERM exit before escalating to
 * SIGKILL, so a wedged child can never hang the acceptance run indefinitely. */
const STOP_GRACE_MS = 10_000;

function argsFor(opts: { root: string; scenario?: string; reuse?: boolean; keep?: boolean; runId?: string }): string[] {
  const argv = [QA_DAEMON_PATH, '--root', opts.root];
  if (opts.runId) argv.push('--run-id', opts.runId);
  if (opts.scenario) argv.push('--scenario', opts.scenario);
  if (opts.reuse) argv.push('--reuse');
  if (opts.keep) argv.push('--keep');
  return argv;
}

export interface QaDaemonHandle {
  env: QaEnv;
  /** SIGTERM the daemon and await its exit, escalating to SIGKILL after a grace. */
  stop(): Promise<void>;
}

/** Spawn a qa-daemon and resolve once it publishes a ready qa-env.json whose
 * `run_id` matches the nonce we launched it with. Requiring the nonce means a
 * stale `state: "ready"` env left by a dead predecessor (e.g. one SIGKILLed under
 * `--reuse`) can never be mistaken for this child's readiness. Rejects if the
 * process errors or exits before becoming ready (surfacing its stderr). */
export async function startQaDaemon(opts: {
  root: string;
  scenario?: string;
  reuse?: boolean;
  keep?: boolean;
}): Promise<QaDaemonHandle> {
  const deadlineMs = 30_000;
  const runId = randomUUID();
  const proc = spawn(process.execPath, argsFor({ ...opts, runId }), { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
  const state: { exited: { code: number | null; signal: NodeJS.Signals | null } | null; spawnError: Error | null } =
    { exited: null, spawnError: null };
  proc.on('exit', (code, signal) => { state.exited = { code, signal }; });
  proc.on('error', (err) => { state.spawnError = err; });

  const envPath = join(opts.root, 'qa-env.json');
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (state.spawnError !== null) throw new Error(`qa-daemon failed to spawn: ${state.spawnError.message}`);
    if (state.exited !== null) {
      throw new Error(`qa-daemon exited early (code ${state.exited.code}, signal ${state.exited.signal}) before ready:\n${stderr}`);
    }
    try {
      const env = await readQaEnv(envPath);
      // The nonce match is what proves this env belongs to the child we launched.
      if (env.state === 'ready' && env.run_id === runId) return { env, stop: () => stopProc(proc) };
    } catch {
      // env not written yet, or still carries a predecessor's run_id
    }
    if (Date.now() >= deadline) {
      await stopProc(proc);
      throw new Error(`qa-daemon did not become ready within ${deadlineMs}ms:\n${stderr}`);
    }
    await sleep(100);
  }
}

export interface QaDaemonAttempt { code: number | null; signal: NodeJS.Signals | null; stderr: string }

/** Spawn a qa-daemon and wait for it to exit on its own. Used for the refused
 * second-invocation / refuse-real-store checks: a safety refusal exits non-zero
 * without lingering. */
export async function runQaDaemonToExit(opts: { root: string }): Promise<QaDaemonAttempt> {
  const deadlineMs = 15_000;
  const proc = spawn(process.execPath, argsFor({ root: opts.root }), { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
  return new Promise<QaDaemonAttempt>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`qa-daemon did not exit within ${deadlineMs}ms; expected a refusal to exit promptly:\n${stderr}`));
    }, deadlineMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`qa-daemon failed to spawn: ${err.message}`));
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stderr });
    });
  });
}

/** SIGTERM the child and await its exit; if it does not exit within the grace
 * window, SIGKILL it and await again. A wedged daemon never hangs the caller. */
function stopProc(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    const onExit = (): void => { clearTimeout(timer); resolvePromise(); };
    const timer = setTimeout(() => { proc.kill('SIGKILL'); }, STOP_GRACE_MS);
    proc.once('exit', onExit);
    proc.kill('SIGTERM');
  });
}
