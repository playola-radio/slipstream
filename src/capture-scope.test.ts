import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectCaptureScope, gitCaptureScope, GitError, type CaptureScope } from './capture-scope.ts';
import { buildPublicEnvelope, type CaptureScopeInput } from './public-events.ts';
import { loadSchema, validate } from './schema.ts';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function withRepo(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'slip-git-')));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A repo whose excludes file git cannot read: git warns but still exits 0/1. */
async function withUnreadableExcludes(fn: (scope: Extract<CaptureScope, { policy: 'git' }>) => Promise<void>): Promise<void> {
  await withRepo(async (root) => {
    const excludes = join(root, '..', `${root.split('/').pop()}-excludes`);
    await writeFile(excludes, '*.log\n');
    await chmod(excludes, 0o000);
    try {
      git(root, 'config', 'core.excludesFile', excludes);
      await put(root, 'a.log');
      await fn(asGit(await detectCaptureScope(root)));
    } finally {
      await rm(excludes, { force: true });
    }
  });
}

async function put(root: string, rel: string, body = 'x'): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true });
  await writeFile(join(root, rel), body);
}

function asGit(scope: CaptureScope): Extract<CaptureScope, { policy: 'git' }> {
  assert.equal(scope.policy, 'git');
  return scope as Extract<CaptureScope, { policy: 'git' }>;
}

describe('capture scope', () => {
  describe('detection', () => {
    it('uses the filesystem policy outside any git work tree', async () => {
      const root = await mkdtemp(join(tmpdir(), 'slip-nogit-'));
      try {
        assert.equal((await detectCaptureScope(root)).policy, 'filesystem');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('uses the git policy inside a work tree, including a subdirectory', async () => {
      await withRepo(async (root) => {
        await mkdir(join(root, 'sub'));
        assert.equal((await detectCaptureScope(root)).policy, 'git');
        assert.equal((await detectCaptureScope(join(root, 'sub'))).policy, 'git');
      });
    });

    it('uses the git policy in a linked worktree whose .git is a file', async () => {
      await withRepo(async (root) => {
        await put(root, 'a.ts');
        git(root, 'add', '.');
        git(root, 'commit', '-qm', 'init');
        const linked = join(root, '..', `${root.split('/').pop()}-linked`);
        git(root, 'worktree', 'add', '-q', linked);
        try {
          await writeFile(join(linked, '.gitignore'), '*.log\n');
          await put(linked, 'x.log');
          const scope = asGit(await detectCaptureScope(linked));
          assert.deepEqual(await scope.ignored(['x.log', 'a.ts']), new Set(['x.log']));
        } finally {
          await rm(linked, { recursive: true, force: true });
        }
      });
    });

    it('rejects a repository git cannot open rather than capturing everything', async () => {
      const root = await mkdtemp(join(tmpdir(), 'slip-nogit-'));
      const gitDir = process.env.GIT_DIR;
      process.env.GIT_DIR = join(root, 'missing');
      try {
        await assert.rejects(detectCaptureScope(root), GitError);
      } finally {
        if (gitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = gitDir;
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects when git cannot be run at all', async () => {
      const root = await mkdtemp(join(tmpdir(), 'slip-nogit-'));
      const path = process.env.PATH;
      process.env.PATH = '';
      try {
        await assert.rejects(detectCaptureScope(root), GitError);
      } finally {
        process.env.PATH = path;
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('ignored', () => {
    it('follows nested rules, negation, and info/exclude', async () => {
      await withRepo(async (root) => {
        await writeFile(join(root, '.gitignore'), '*.log\n!keep.log\n');
        await put(root, 'pkg/.gitignore', 'dist/\n');
        await put(root, '.git/info/exclude', 'scratch.md\n');
        const scope = asGit(await detectCaptureScope(root));
        const paths = ['a.log', 'keep.log', 'pkg/dist/out.js', 'dist/out.js', 'scratch.md', 'src/a.ts'];
        for (const p of paths) await put(root, p);
        assert.deepEqual(await scope.ignored(paths), new Set(['a.log', 'pkg/dist/out.js', 'scratch.md']));
      });
    });

    it('never ignores a tracked file, even one matching a rule or force-added', async () => {
      await withRepo(async (root) => {
        await put(root, 'tracked.log');
        await put(root, 'forced.log');
        git(root, 'add', 'tracked.log');
        await writeFile(join(root, '.gitignore'), '*.log\n');
        git(root, 'add', '-f', 'forced.log');
        await put(root, 'other.log');
        const scope = asGit(await detectCaptureScope(root));
        assert.deepEqual(await scope.ignored(['tracked.log', 'forced.log', 'other.log']), new Set(['other.log']));
      });
    });

    it('round-trips filenames with spaces, newlines, and non-ASCII bytes', async () => {
      await withRepo(async (root) => {
        await writeFile(join(root, '.gitignore'), '*.tmp\n');
        const odd = ['a b.tmp', 'line\nbreak.tmp', 'café.tmp', 'kept file.ts'];
        for (const p of odd) await put(root, p);
        const scope = asGit(await detectCaptureScope(root));
        assert.deepEqual(await scope.ignored(odd), new Set(odd.slice(0, 3)));
      });
    });

    it('does not treat a nested repository as ignored', async () => {
      await withRepo(async (root) => {
        await put(root, 'vendor/lib/a.ts');
        git(join(root, 'vendor', 'lib'), 'init', '-q');
        const scope = asGit(await detectCaptureScope(root));
        assert.deepEqual(await scope.ignored(['vendor/lib/a.ts']), new Set());
      });
    });

    it('returns an empty set without running git for an empty batch', async () => {
      const scope = asGit(gitCaptureScope('/nonexistent/never/used'));
      assert.deepEqual(await scope.ignored([]), new Set());
    });

    it('rejects on a fatal git exit instead of returning partial output', async () => {
      const root = await mkdtemp(join(tmpdir(), 'slip-nogit-'));
      try {
        const scope = asGit(gitCaptureScope(root));
        await assert.rejects(scope.ignored(['a.ts']), /exited 128/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects when git warns that it could not read an ignore rule', async () => {
      await withUnreadableExcludes(async (scope) => {
        await assert.rejects(scope.ignored(['a.log']), /unable to access/);
      });
    });

    it('rejects when git outlives its timeout', async () => {
      await withRepo(async (root) => {
        const scope = asGit(gitCaptureScope(root, 1));
        await assert.rejects(scope.ignored(['a.ts']), /timed out/);
      });
    });

    it('rejects at its deadline even when a process git started keeps running', async () => {
      await withRepo(async (root) => {
        git(root, 'config', 'core.fsmonitor', 'sleep 5; echo token');
        const scope = asGit(gitCaptureScope(root, 200));
        const started = Date.now();
        await assert.rejects(scope.ignored(['a.ts']), /timed out/);
        assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
      });
    });
  });

  describe('ignoredEntries', () => {
    it('collapses ignored directories and keeps tracked descendants out', async () => {
      await withRepo(async (root) => {
        await writeFile(join(root, '.gitignore'), 'node_modules/\n*.log\nbuild/\n');
        await put(root, 'node_modules/a/index.js');
        await put(root, 'node_modules/b/index.js');
        await put(root, 'src/x.log');
        await put(root, 'build/kept.txt');
        git(root, 'add', '-f', 'build/kept.txt');
        await put(root, 'build/out.js');
        await put(root, 'src/a.ts');
        const scope = asGit(await detectCaptureScope(root));
        assert.deepEqual(new Set(await scope.ignoredEntries()), new Set(['node_modules', 'src/x.log', 'build/out.js']));
      });
    });

    it('rejects when git warns that it could not read an ignore rule', async () => {
      await withUnreadableExcludes(async (scope) => {
        await assert.rejects(scope.ignoredEntries(), /unable to access/);
      });
    });

    it('rejects on a fatal git exit', async () => {
      const root = await mkdtemp(join(tmpdir(), 'slip-nogit-'));
      try {
        await assert.rejects(asGit(gitCaptureScope(root)).ignoredEntries(), /exited 128/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('slipstream.capture.scope.v1 schema', () => {
    const scopeEvent = (data: unknown) =>
      buildPublicEnvelope({ type: 'slipstream.capture.scope.v1', occurred_at_ms: 1, data } as CaptureScopeInput, 7n, SESSION);

    it('accepts each valid policy and status combination', async () => {
      const schema = await loadSchema('slipstream.capture.scope.v1');
      for (const data of [
        { policy: 'git', status: 'active' },
        { policy: 'git', status: 'unavailable' },
        { policy: 'filesystem', status: 'active' },
      ]) {
        const event = scopeEvent(data);
        assert.equal(event.data.session_id, SESSION);
        assert.equal('subject' in event, false);
        assert.deepEqual(validate(schema, event), [], JSON.stringify(data));
      }
    });

    it('rejects combinations that would misstate the scope', async () => {
      const schema = await loadSchema('slipstream.capture.scope.v1');
      for (const data of [
        { policy: 'filesystem', status: 'unavailable' },
        { policy: 'git' },
        { policy: 'slipignore', status: 'active' },
      ]) {
        assert.ok(validate(schema, scopeEvent(data)).length > 0, JSON.stringify(data));
      }
    });
  });
});
