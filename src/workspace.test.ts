import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Scripts } from './conductor-settings.ts';
import { runWorkspaceArchive, runWorkspaceCreate, type WorkspaceDeps } from './workspace.ts';

const HOME = '/h';
const ROOT = '/src/repo';
const WS = '/h/slipstream/workspaces/repo/workspace-1';
const SETUP_ENV = { CONDUCTOR_ROOT_PATH: ROOT, CONDUCTOR_WORKSPACE_PATH: WS };

type Reply = { code: number | null; output: string };

function fake(opts: {
  git?: Record<string, Reply>;
  existing?: string[];
  scripts?: Scripts;
  record?: number;
  withdraw?: number;
  script?: number;
  realpath?: (path: string) => string;
} = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: WorkspaceDeps = {
    home: HOME,
    git: async (args, cwd) => {
      const key = args.join(' ');
      calls.push(`git ${key} @${cwd}`);
      return opts.git?.[key] ?? { code: 0, output: '' };
    },
    record: async (dir) => { calls.push(`record ${dir}`); return opts.record ?? 0; },
    withdraw: async (dir) => { calls.push(`withdraw ${dir}`); return opts.withdraw ?? 0; },
    scripts: async (dir) => { calls.push(`scripts ${dir}`); return opts.scripts ?? { setup: 'make setup', archive: 'make clean' }; },
    runScript: async (script, cwd, env) => { calls.push(`run ${script} @${cwd} ${JSON.stringify(env)}`); return opts.script ?? 0; },
    exists: async (path) => (opts.existing ?? []).includes(path),
    realpath: async (path) => (opts.realpath ? opts.realpath(path) : path),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, calls, out, err };
}

const NO_BRANCH: Reply = { code: 1, output: '' };

function createGit(extra: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    'rev-parse --show-toplevel': { code: 0, output: `${ROOT}\n` },
    'remote get-url origin': { code: 0, output: 'git@github.com:o/repo.git\n' },
    'show-ref --verify --quiet refs/remotes/origin/develop': { code: 0, output: '' },
    'show-ref --verify --quiet refs/heads/slipstream/workspace-1': NO_BRANCH,
    'show-ref --verify --quiet refs/heads/slipstream/workspace-2': NO_BRANCH,
    'show-ref --verify --quiet refs/heads/slipstream/workspace-3': NO_BRANCH,
    ...extra,
  };
}

describe('runWorkspaceCreate', () => {
  it('creates workspace-1 from origin/develop, records it, then runs setup', async () => {
    const f = fake({ git: createGit() });
    assert.equal(await runWorkspaceCreate('/src/repo', f.deps), 0);
    assert.deepEqual(f.calls, [
      'git rev-parse --show-toplevel @/src/repo',
      `git remote get-url origin @${ROOT}`,
      `git fetch origin @${ROOT}`,
      `git show-ref --verify --quiet refs/remotes/origin/develop @${ROOT}`,
      `git show-ref --verify --quiet refs/heads/slipstream/workspace-1 @${ROOT}`,
      `git worktree add -b slipstream/workspace-1 ${WS} origin/develop @${ROOT}`,
      `record ${WS}`,
      `scripts ${WS}`,
      `run make setup @${WS} ${JSON.stringify(SETUP_ENV)}`,
    ]);
    assert.equal(f.out.at(-1), `workspace_path: ${WS}`);
  });

  it('falls back to origin/HEAD when there is no origin/develop', async () => {
    const f = fake({ git: createGit({
      'show-ref --verify --quiet refs/remotes/origin/develop': NO_BRANCH,
      'symbolic-ref --short refs/remotes/origin/HEAD': { code: 0, output: 'origin/main\n' },
    }) });
    assert.equal(await runWorkspaceCreate(ROOT, f.deps), 0);
    assert.ok(f.calls.includes(`git worktree add -b slipstream/workspace-1 ${WS} origin/main @${ROOT}`), f.calls.join('\n'));
  });

  it('creates nothing when the repo has no origin', async () => {
    const f = fake({ git: createGit({ 'remote get-url origin': { code: 2, output: "error: No such remote 'origin'\n" } }) });
    assert.equal(await runWorkspaceCreate(ROOT, f.deps), 1);
    assert.match(f.err.join('\n'), /no "origin" remote/);
    assert.ok(!f.calls.some((c) => c.startsWith('git worktree add')));
    assert.ok(!f.out.some((l) => l.startsWith('workspace_path:')));
  });

  it('creates nothing when origin has neither develop nor a default branch', async () => {
    const f = fake({ git: createGit({
      'show-ref --verify --quiet refs/remotes/origin/develop': NO_BRANCH,
      'symbolic-ref --short refs/remotes/origin/HEAD': { code: 128, output: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n' },
    }) });
    assert.equal(await runWorkspaceCreate(ROOT, f.deps), 1);
    assert.match(f.err.join('\n'), /origin\/develop/);
    assert.ok(!f.calls.some((c) => c.startsWith('git worktree add')));
    assert.ok(!f.out.some((l) => l.startsWith('workspace_path:')));
  });

  it('creates nothing when the folder is not in a git repo', async () => {
    const f = fake({ git: { 'rev-parse --show-toplevel': { code: 128, output: 'fatal: not a git repository\n' } } });
    assert.equal(await runWorkspaceCreate('/tmp/plain', f.deps), 1);
    assert.match(f.err.join('\n'), /not inside a git repository/);
    assert.deepEqual(f.calls, ['git rev-parse --show-toplevel @/tmp/plain']);
  });

  it('picks the next free number when the folder or the branch is taken', async () => {
    const f = fake({
      git: createGit({ 'show-ref --verify --quiet refs/heads/slipstream/workspace-2': { code: 0, output: '' } }),
      existing: [WS],
    });
    assert.equal(await runWorkspaceCreate(ROOT, f.deps), 0);
    assert.ok(f.calls.includes(
      `git worktree add -b slipstream/workspace-3 /h/slipstream/workspaces/repo/workspace-3 origin/develop @${ROOT}`), f.calls.join('\n'));
  });

  it('a subfolder of a repo uses the repo top level', async () => {
    const f = fake({ git: createGit() });
    assert.equal(await runWorkspaceCreate('/src/repo/packages/app', f.deps), 0);
    assert.equal(f.calls[0], 'git rev-parse --show-toplevel @/src/repo/packages/app');
    assert.ok(f.calls.includes(`git worktree add -b slipstream/workspace-1 ${WS} origin/develop @${ROOT}`), f.calls.join('\n'));
  });

  it('setup still runs when recording fails, and the exit says so', async () => {
    const f = fake({ git: createGit(), record: 1 });
    assert.equal(await runWorkspaceCreate(ROOT, f.deps), 1);
    assert.ok(f.calls.some((c) => c.startsWith('run make setup')));
    assert.equal(f.out.at(-1), `workspace_path: ${WS}`);
  });

  it('a failing setup keeps the workspace and reports failure', async () => {
    const f = fake({ git: createGit(), script: 2 });
    assert.equal(await runWorkspaceCreate(ROOT, f.deps), 1);
    assert.match(f.err.join('\n'), /setup script exited 2/);
    assert.equal(f.out.at(-1), `workspace_path: ${WS}`);
    assert.ok(!f.calls.some((c) => c.includes('worktree remove')));
  });

  it('no setup script means success', async () => {
    const f = fake({ git: createGit(), scripts: {} });
    assert.equal(await runWorkspaceCreate(ROOT, f.deps), 0);
    assert.ok(!f.calls.some((c) => c.startsWith('run ')));
    assert.equal(f.out.at(-1), `workspace_path: ${WS}`);
  });
});

const REV_PARSE = 'rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir';
const ARCHIVE_ENV = { CONDUCTOR_ROOT_PATH: ROOT, CONDUCTOR_WORKSPACE_PATH: WS };

function archiveGit(extra: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    [REV_PARSE]: { code: 0, output: `${WS}\n${ROOT}/.git/worktrees/workspace-1\n${ROOT}/.git\n` },
    'status --porcelain': { code: 0, output: '' },
    ...extra,
  };
}

describe('runWorkspaceArchive', () => {
  it('archives a clean workspace: stop recording, archive script, remove, keep branch', async () => {
    const f = fake({ git: archiveGit() });
    assert.equal(await runWorkspaceArchive(WS, f.deps), 0);
    assert.deepEqual(f.calls, [
      `git ${REV_PARSE} @${WS}`,
      `git status --porcelain @${WS}`,
      `withdraw ${WS}`,
      `scripts ${WS}`,
      `run make clean @${WS} ${JSON.stringify(ARCHIVE_ENV)}`,
      `git worktree remove ${WS} @${ROOT}`,
    ]);
  });

  it('refuses a folder outside ~/slipstream/workspaces', async () => {
    const outside = '/Users/x/conductor/workspaces/repo/ws';
    const f = fake({ git: archiveGit() });
    assert.equal(await runWorkspaceArchive(outside, f.deps), 1);
    assert.match(f.err.join('\n'), /only archives folders under \/h\/slipstream\/workspaces/);
    assert.deepEqual(f.calls, []);
  });

  it('refuses a sibling folder that only shares the prefix', async () => {
    const f = fake({ git: archiveGit() });
    assert.equal(await runWorkspaceArchive('/h/slipstream/workspaces-old/repo/ws', f.deps), 1);
    assert.deepEqual(f.calls, []);
  });

  it('refuses a folder that is not a linked worktree', async () => {
    const f = fake({ git: archiveGit({ [REV_PARSE]: { code: 0, output: `${WS}\n${WS}/.git\n${WS}/.git\n` } }) });
    assert.equal(await runWorkspaceArchive(WS, f.deps), 1);
    assert.match(f.err.join('\n'), /not a git worktree/);
    assert.ok(!f.calls.some((c) => c.startsWith('withdraw')));
  });

  it('refuses a subfolder of a workspace', async () => {
    const f = fake({ git: archiveGit() });
    assert.equal(await runWorkspaceArchive(`${WS}/src`, f.deps), 1);
    assert.deepEqual(f.calls, []);
  });

  it('refuses uncommitted or untracked changes before touching anything', async () => {
    const f = fake({ git: archiveGit({ 'status --porcelain': { code: 0, output: '?? new.txt\n' } }) });
    assert.equal(await runWorkspaceArchive(WS, f.deps), 1);
    assert.match(f.err.join('\n'), /uncommitted or untracked changes/);
    assert.match(f.err.join('\n'), /new\.txt/);
    assert.ok(!f.calls.some((c) => c.startsWith('withdraw') || c.startsWith('run ')));
  });

  it('a failing archive script keeps the worktree', async () => {
    const f = fake({ git: archiveGit(), script: 1 });
    assert.equal(await runWorkspaceArchive(WS, f.deps), 1);
    assert.match(f.err.join('\n'), /archive script exited 1/);
    assert.ok(!f.calls.some((c) => c.includes('worktree remove')));
  });

  it('a failed remove is reported and archive can run again', async () => {
    const f = fake({ git: archiveGit({ [`worktree remove ${WS}`]: { code: 128, output: 'fatal: cannot remove\n' } }) });
    assert.equal(await runWorkspaceArchive(WS, f.deps), 1);
    assert.match(f.err.join('\n'), /fatal: cannot remove/);
  });

  it('a failed withdraw stops before the script runs', async () => {
    const f = fake({ git: archiveGit(), withdraw: 3 });
    assert.equal(await runWorkspaceArchive(WS, f.deps), 3);
    assert.ok(!f.calls.some((c) => c.startsWith('run ') || c.includes('worktree remove')));
  });
});
