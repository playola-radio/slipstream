import { basename, dirname, join, relative, sep } from 'node:path';
import { SettingsError, type ScriptKind, type Scripts } from './conductor-settings.ts';

/**
 * `slipstream workspace create|archive`: git worktree workspaces for people who
 * don't use Conductor, laid out like Conductor's (`~/slipstream/workspaces/<repo>/<name>`)
 * and running the same committed setup/archive scripts.
 */
export interface WorkspaceDeps {
  home: string;
  git: (args: string[], cwd: string) => Promise<{ code: number | null; output: string }>;
  /** Watch-only attach with --wait, starting the daemon if needed. */
  record: (dir: string) => Promise<number>;
  /** Stop recording with reason `archived`; an unrecorded folder is not an error. */
  withdraw: (dir: string) => Promise<number>;
  scripts: (dir: string) => Promise<Scripts>;
  runScript: (script: string, cwd: string, env: Record<string, string>) => Promise<number>;
  exists: (path: string) => Promise<boolean>;
  realpath: (path: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
}

export function workspacesRoot(home: string): string {
  return join(home, 'slipstream', 'workspaces');
}

const BRANCH_PREFIX = 'slipstream/';

export async function runWorkspaceCreate(repo: string, deps: WorkspaceDeps): Promise<number> {
  const top = await deps.git(['rev-parse', '--show-toplevel'], repo);
  if (top.code !== 0) {
    deps.err(`slipstream: ${repo} is not inside a git repository.`);
    return 1;
  }
  const root = top.output.trim();
  if ((await deps.git(['remote', 'get-url', 'origin'], root)).code !== 0) {
    deps.err(`slipstream: ${root} has no "origin" remote to branch from.`);
    return 1;
  }
  const fetch = await deps.git(['fetch', 'origin'], root);
  if (fetch.code !== 0) {
    deps.err(`slipstream: git fetch origin failed:\n${fetch.output.trim()}`);
    return 1;
  }
  const base = await baseBranch(root, deps);
  if (!base) {
    deps.err(`slipstream: ${root} has neither origin/develop nor a default origin branch to start from.`);
    return 1;
  }
  const parent = join(workspacesRoot(deps.home), basename(root));
  let n = 1;
  while (await deps.exists(join(parent, `workspace-${n}`))
    || (await deps.git(['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH_PREFIX}workspace-${n}`], root)).code === 0) n++;
  const branch = `${BRANCH_PREFIX}workspace-${n}`;
  const add = await deps.git(['worktree', 'add', '-b', branch, join(parent, `workspace-${n}`), base], root);
  if (add.code !== 0) {
    deps.err(`slipstream: git worktree add failed:\n${add.output.trim()}`);
    return 1;
  }
  const path = await deps.realpath(join(parent, `workspace-${n}`));
  deps.out(`created ${path} on ${branch} from ${base}`);
  const recorded = await deps.record(path);
  const setUp = await runRepoScript('setup', root, path, deps);
  deps.out(`workspace_path: ${path}`);
  return recorded === 0 && setUp ? 0 : 1;
}

export async function runWorkspaceArchive(dir: string, deps: WorkspaceDeps): Promise<number> {
  const managed = await deps.realpath(workspacesRoot(deps.home)).catch(() => null);
  const path = await deps.realpath(dir).catch(() => null);
  const parts = managed !== null && path !== null ? relative(managed, path).split(sep) : [];
  if (path === null || parts.length !== 2 || parts.includes('..') || parts.includes('')) {
    deps.err(`slipstream: workspace archive only archives folders under ${workspacesRoot(deps.home)}/<repo>/<name>.`);
    return 1;
  }
  const where = await deps.git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], path);
  const [top, gitDir, commonDir] = where.output.trim().split('\n');
  if (where.code !== 0 || top !== path || !commonDir || gitDir === commonDir) {
    deps.err(`slipstream: ${path} is not a git worktree.`);
    return 1;
  }
  const status = await deps.git(['status', '--porcelain'], path);
  if (status.code !== 0 || status.output.trim() !== '') {
    deps.err(`slipstream: ${path} has uncommitted or untracked changes; commit or remove them first:\n${status.output.trimEnd()}`);
    return 1;
  }
  const withdrawn = await deps.withdraw(path);
  if (withdrawn !== 0) return withdrawn;
  const root = dirname(commonDir);
  if (!(await runRepoScript('archive', root, path, deps))) return 1;
  const removed = await deps.git(['worktree', 'remove', path], root);
  if (removed.code !== 0) {
    deps.err(`slipstream: git worktree remove failed:\n${removed.output.trim()}`);
    return 1;
  }
  deps.out(`archived ${path}; its branch is kept`);
  return 0;
}

async function baseBranch(root: string, deps: WorkspaceDeps): Promise<string | null> {
  if ((await deps.git(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/develop'], root)).code === 0) return 'origin/develop';
  const head = await deps.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  return head.code === 0 && head.output.trim() !== '' ? head.output.trim() : null;
}

/** Runs the workspace's committed `kind` script, if any; true when it succeeded or there is none. */
async function runRepoScript(kind: ScriptKind, root: string, path: string, deps: WorkspaceDeps): Promise<boolean> {
  let scripts: Scripts;
  try { scripts = await deps.scripts(path); } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    deps.err(`slipstream: ${err.message}`);
    return false;
  }
  const script = scripts[kind];
  if (!script) return true;
  const code = await deps.runScript(script, path, { CONDUCTOR_ROOT_PATH: root, CONDUCTOR_WORKSPACE_PATH: path });
  if (code !== 0) deps.err(`slipstream: the ${kind} script exited ${code}.`);
  return code === 0;
}
