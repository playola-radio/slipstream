import { spawn } from 'node:child_process';

/** How long one git invocation may run before it counts as a failure. */
export const GIT_TIMEOUT_MS = 10_000;

/**
 * Which paths capture follows. Slipstream shows what is going to be merged, so
 * inside a git work tree a path git ignores (and does not track) is out of
 * scope. Git itself decides — the ignore rules are never re-implemented here.
 */
export type CaptureScope =
  | { policy: 'filesystem' }
  | {
      policy: 'git';
      /** The subset of `paths` (root-relative) git would not merge. Tracked
       * paths are never ignored. Rejects rather than guess on any git failure. */
      ignored(paths: readonly string[]): Promise<Set<string>>;
      /** Every untracked ignored entry under the root, directories collapsed
       * to one entry (no trailing slash). */
      ignoredEntries(): Promise<string[]>;
    };

export type DetectCaptureScope = (root: string) => Promise<CaptureScope>;

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(root: string, args: string[], input?: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout also kills helpers git started (an
    // fsmonitor hook) that would otherwise hold the pipes open past the deadline.
    const child = spawn('git', ['-C', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // Not spawn's own `timeout`: its timer outlives a failed spawn.
    const timer = setTimeout(() => {
      settle(() => reject(new GitError(`git ${args[0]} timed out after ${timeoutMs}ms`)));
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.stdin.on('error', () => {}); // a git that exits early closes stdin; the exit code reports it
    child.on('error', (e) => {
      settle(() => reject(new GitError(`git ${args[0]} could not run: ${e.message}`)));
    });
    child.on('close', (code, signal) => {
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code === null) {
        settle(() => reject(new GitError(`git ${args[0]} was killed (${signal ?? 'unknown signal'})${stderr ? `: ${stderr}` : ''}`)));
        return;
      }
      settle(() => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr }));
    });
    child.stdin.end(input ?? '');
  });
}

const splitNul = (s: string): string[] => s.split('\0').filter((p) => p.length > 0);

/** Git reports an ignore file it could not read only as a warning and still
 * exits successfully, so its answer may be missing rules. Never trust it. */
function rejectWarnings(command: string, r: GitResult): void {
  if (r.stderr) throw new GitError(`git ${command} warned: ${r.stderr}`);
}

export function gitCaptureScope(root: string, timeoutMs = GIT_TIMEOUT_MS): CaptureScope {
  return {
    policy: 'git',
    ignored: async (paths) => {
      if (paths.length === 0) return new Set();
      const r = await runGit(root, ['check-ignore', '-z', '--stdin'], paths.map((p) => `${p}\0`).join(''), timeoutMs);
      // 0: some paths ignored, 1: none ignored. Anything else is a failure, and
      // partial output from a failed run is never trusted.
      if (r.code !== 0 && r.code !== 1) throw new GitError(`git check-ignore exited ${r.code}: ${r.stderr}`);
      rejectWarnings('check-ignore', r);
      return new Set(splitNul(r.stdout));
    },
    ignoredEntries: async () => {
      const r = await runGit(
        root,
        ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
        undefined,
        timeoutMs,
      );
      if (r.code !== 0) throw new GitError(`git ls-files exited ${r.code}: ${r.stderr}`);
      rejectWarnings('ls-files', r);
      return splitNul(r.stdout).map((p) => (p.endsWith('/') ? p.slice(0, -1) : p));
    },
  };
}

/**
 * A root outside any git work tree captures everything (the pre-git behavior).
 * A root inside one is filtered by git. Any other git failure — git missing,
 * a repository git refuses to read — rejects: capture never silently widens
 * to ignored files because git could not be asked.
 */
export async function detectCaptureScope(root: string): Promise<CaptureScope> {
  const r = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (r.code === 0 && r.stdout.trim() === 'true') return gitCaptureScope(root);
  if (r.code === 0 && r.stdout.trim() === 'false') return { policy: 'filesystem' };
  // Only git's search-found-nothing message. `not a git repository: '<dir>'`
  // means an explicit GIT_DIR git cannot open, which is a failure.
  if (r.code === 128 && /not a git repository \(or any/i.test(r.stderr)) return { policy: 'filesystem' };
  throw new GitError(`cannot tell whether ${root} is a git work tree: git rev-parse exited ${r.code}: ${r.stderr}`);
}
