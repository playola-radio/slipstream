/**
 * Spawn `qa-daemon` as a child process for the acceptance runner and for the
 * lifecycle/safety acceptance checks (which must observe a real second process,
 * not an in-process shortcut). Two shapes:
 *  - {@link startQaDaemon}: spawn and wait until it publishes a ready qa-env.json,
 *    returning a handle whose `stop()` signals it and awaits exit.
 *  - {@link runQaDaemonToExit}: spawn and wait for it to exit on its own — used to
 *    observe a refused invocation's non-zero exit and stderr.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readQaEnv, sleep, type QaEnv } from '../qa-support.ts';

const QA_DAEMON_PATH = fileURLToPath(new URL('../qa-daemon.ts', import.meta.url));

function argsFor(opts: { root: string; scenario?: string; reuse?: boolean; keep?: boolean }): string[] {
  const argv = [QA_DAEMON_PATH, '--root', opts.root];
  if (opts.scenario) argv.push('--scenario', opts.scenario);
  if (opts.reuse) argv.push('--reuse');
  if (opts.keep) argv.push('--keep');
  return argv;
}

export interface QaDaemonHandle {
  env: QaEnv;
  root: string;
  proc: ChildProcess;
  /** SIGTERM the daemon and await its exit. */
  stop(): Promise<void>;
}

/** Spawn a qa-daemon and resolve once it publishes a ready qa-env.json. Rejects if
 * the process exits before becoming ready (surfacing its stderr). */
export async function startQaDaemon(opts: {
  root: string;
  scenario?: string;
  reuse?: boolean;
  keep?: boolean;
  deadlineMs?: number;
}): Promise<QaDaemonHandle> {
  const deadlineMs = opts.deadlineMs ?? 30_000;
  const proc = spawn(process.execPath, argsFor(opts), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
  const state: { exited: { code: number | null; signal: NodeJS.Signals | null } | null } = { exited: null };
  proc.on('exit', (code, signal) => { state.exited = { code, signal }; });

  const envPath = join(opts.root, 'qa-env.json');
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (state.exited !== null) {
      throw new Error(`qa-daemon exited early (code ${state.exited.code}, signal ${state.exited.signal}) before ready:\n${stderr}`);
    }
    try {
      const env = await readQaEnv(envPath);
      if (env.state === 'ready') return { env, root: opts.root, proc, stop: () => stopProc(proc) };
    } catch {
      // env not written yet
    }
    if (Date.now() >= deadline) {
      await stopProc(proc);
      throw new Error(`qa-daemon did not become ready within ${deadlineMs}ms:\n${stderr}`);
    }
    await sleep(100);
  }
}

export interface QaDaemonAttempt { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/** Spawn a qa-daemon and wait for it to exit on its own. Used for the refused
 * second-invocation check: a safety refusal exits non-zero without lingering. */
export async function runQaDaemonToExit(opts: {
  root: string;
  scenario?: string;
  reuse?: boolean;
  keep?: boolean;
  deadlineMs?: number;
}): Promise<QaDaemonAttempt> {
  const deadlineMs = opts.deadlineMs ?? 15_000;
  const proc = spawn(process.execPath, argsFor(opts), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
  proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
  return new Promise<QaDaemonAttempt>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`qa-daemon did not exit within ${deadlineMs}ms; expected a refusal to exit promptly:\n${stderr}`));
    }, deadlineMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function stopProc(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    proc.once('exit', () => resolvePromise());
    proc.kill('SIGTERM');
  });
}
