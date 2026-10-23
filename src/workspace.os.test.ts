import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeSocket } from './daemon.ts';

type Result = { code: number; stdout: string; stderr: string };

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((done) => {
    execFile(command, args, { cwd, env, timeout: 60_000 },
      (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr }));
  });
}

describe('slipstream workspace against real git and a disposable daemon', () => {
  it('creates a workspace, runs setup, records it, then archives it and keeps the branch', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'slip-workspace-os-')));
    const store = join(dir, 'store');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: dir,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    };
    const git = async (args: string[], cwd: string) => {
      const r = await run('git', args, cwd, env);
      assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    const slipstream = (...args: string[]) => run(process.execPath, [join(process.cwd(), 'src/cli.ts'), ...args, '--store', store], process.cwd(), env);
    try {
      await git(['init', '--bare', '-b', 'develop', 'origin.git'], dir);
      const seed = join(dir, 'seed');
      await mkdir(seed);
      await git(['init', '-b', 'develop'], seed);
      await writeFile(join(seed, 'conductor.json'), JSON.stringify({
        scripts: { setup: 'echo set > setup-ran.txt; echo SETUP-DONE', archive: 'echo ARCHIVE-DONE' },
      }));
      await writeFile(join(seed, '.gitignore'), 'setup-ran.txt\n');
      await git(['add', '.'], seed);
      await git(['commit', '-m', 'seed'], seed);
      await git(['push', join(dir, 'origin.git'), 'develop'], seed);
      await git(['clone', join(dir, 'origin.git'), 'myrepo'], dir);
      const repo = join(dir, 'myrepo');
      const workspace = join(dir, 'slipstream', 'workspaces', 'myrepo', 'workspace-1');

      const created = await slipstream('workspace', 'create', repo);
      assert.equal(created.code, 0, created.stderr);
      assert.match(created.stdout, /SETUP-DONE/);
      assert.equal(created.stdout.trim().split('\n').at(-1), `workspace_path: ${workspace}`);
      await access(join(workspace, 'setup-ran.txt'));
      const recording = await slipstream('status');
      assert.match(recording.stdout, new RegExp(`${workspace}\\n  session_id: \\S+\\n  state: recording`));

      const archived = await slipstream('workspace', 'archive', workspace);
      assert.equal(archived.code, 0, archived.stderr);
      assert.match(archived.stdout, /ARCHIVE-DONE/);
      await assert.rejects(access(workspace));
      assert.notEqual((await git(['branch', '--list', 'slipstream/workspace-1'], repo)).trim(), '');
      const stopped = await slipstream('status');
      assert.match(stopped.stdout, new RegExp(`${workspace}\\n  session_id: \\S+\\n  state: stopped \\(archived\\)`));
    } finally {
      const lock = await readFile(join(store, 'owner.lock'), 'utf8').catch(() => null);
      if (lock) {
        process.kill((JSON.parse(lock) as { pid: number }).pid, 'SIGTERM');
        while (await probeSocket(join(store, 'control.sock'), 200) === 'live') await new Promise((r) => setTimeout(r, 50));
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
