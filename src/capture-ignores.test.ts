import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadCaptureIgnores, compileCaptureIgnores, parseCaptureIgnores } from './capture-ignores.ts';

const exec = promisify(execFile);
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'slip-ignore-'));
  try {
    await exec('git', ['init', '-q', root]);
    await exec('git', ['-C', root, 'config', 'core.excludesFile', '/dev/null']);
    await exec('git', ['-C', root, 'config', 'core.ignoreCase', 'false']);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function put(root: string, path: string, text = 'content') {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

describe('capture ignore policy', () => {
  it('does not read or publish external Git exclude files', async () => {
    await fixture(async (root) => {
      await put(root, 'private-excludes', 'PRIVATE_GLOBAL_CONTENT\n*.log\n');
      await exec('git', ['-C', root, 'config', 'core.excludesFile', join(root, 'private-excludes')]);
      await put(root, '.git/info/exclude', 'PRIVATE_INFO_CONTENT\n*.png\n');
      const policy = await loadCaptureIgnores(root);
      assert.ok(!JSON.stringify(policy).includes('PRIVATE_'));
      const ignores = compileCaptureIgnores(policy);
      assert.equal(ignores('debug.log'), false);
      assert.equal(ignores('shot.png'), false);
    });
  });

  it('preserves tracked files after case-only changes in a case-insensitive repository', async () => {
    await fixture(async (root) => {
      await exec('git', ['-C', root, 'config', 'core.ignoreCase', 'true']);
      await put(root, '.gitignore', 'Build/\n');
      await put(root, 'Build/Keep.ts');
      await exec('git', ['-C', root, 'add', '-f', 'Build/Keep.ts']);
      const ignores = compileCaptureIgnores(await loadCaptureIgnores(root));
      assert.equal(ignores('build', true), false);
      assert.equal(ignores('build/keep.ts'), false);
      assert.equal(ignores('build/other.ts'), true);
    });
  });

  it('matches Git across nested rules, directory pruning, negation and escaped names', async () => {
    await fixture(async (root) => {
      await put(root, '.gitignore', '*.log\n!keep.log\nbuild/\n!build/keep.txt\nx/y/\nsub/.gitignore\n');
      await put(root, 'x/.gitignore', '!y/\n');
      await put(root, 'sub/.gitignore', '*.tmp\n!keep.tmp\n/root.txt\n\\#literal\n\\!literal\nspace\\ \n   \ncache/   \n');
      await put(root, 'weird[dir]/.gitignore', '*.tmp\n');
      const paths = ['a.log', 'nested/a.log', 'keep.log', 'build/keep.txt', 'build/other.ts',
        'x/y/file.ts', 'sub/a.tmp', 'sub/keep.tmp', 'sub/root.txt', 'sub/deep/root.txt',
        'sub/#literal', 'sub/!literal', 'sub/space ', 'sub/deep/cache/a.ts', 'weird[dir]/a.tmp', 'weirdd/a.tmp', 'a.png'];
      for (const path of paths) await put(root, path);
      const policy = await loadCaptureIgnores(root);
      const ignores = compileCaptureIgnores(policy);
      const gitIgnored = new Set((await exec('git', ['-C', root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).stdout.split('\0'));
      for (const path of paths) assert.equal(ignores(path), gitIgnored.has(path), path);
      assert.equal(ignores('build', true), true);
      assert.equal(ignores('x/y', true), false);
      assert.equal(ignores('a.png'), false, 'images are not globally excluded');
    });
  });

  it('keeps tracked exceptions and their directories but lets .slipstreamignore exclude tracked files', async () => {
    await fixture(async (root) => {
      await put(root, '.gitignore', 'build/\n*.png\n');
      await put(root, 'build/keep.ts');
      await put(root, 'tracked.png');
      await exec('git', ['-C', root, 'add', '-f', 'build/keep.ts', 'tracked.png']);
      let ignores = compileCaptureIgnores(await loadCaptureIgnores(root));
      assert.equal(ignores('build', true), false);
      assert.equal(ignores('build/keep.ts'), false);
      assert.equal(ignores('build/no.ts'), true);
      assert.equal(ignores('tracked.png'), false);
      await put(root, '.slipstreamignore', '*.png\n');
      ignores = compileCaptureIgnores(await loadCaptureIgnores(root));
      assert.equal(ignores('tracked.png'), true);
      assert.equal(ignores('build/keep.ts'), false);
    });
  });

  it('reads ancestor rules for a subdirectory and repository rules in a linked worktree', async () => {
    await fixture(async (root) => {
      await put(root, '.gitignore', '/sub/generated/\n');
      await put(root, 'sub/generated/a.ts');
      await put(root, 'sub/app.ts');
      const sub = compileCaptureIgnores(await loadCaptureIgnores(join(root, 'sub')));
      assert.equal(sub('generated/a.ts'), true);
      assert.equal(sub('app.ts'), false);
      await exec('git', ['-C', root, 'add', '.']);
      await exec('git', ['-C', root, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'fixture']);
      const linked = join(root, 'linked');
      await exec('git', ['-C', root, 'worktree', 'add', '-q', '--detach', linked]);
      await put(linked, '.gitignore', '*.noise\n');
      assert.equal(compileCaptureIgnores(await loadCaptureIgnores(linked))('run.noise'), true);
    });
  });

  it('loads an ignored .gitignore but never opens rules under excluded directories', async () => {
    await fixture(async (root) => {
      await put(root, '.gitignore', 'sub/.gitignore\n.gstack/\n');
      await put(root, 'sub/.gitignore', '*.tmp\n');
      await mkdir(join(root, '.gstack'));
      await symlink('/does-not-exist', join(root, '.gstack/.gitignore'));
      const ignores = compileCaptureIgnores(await loadCaptureIgnores(root));
      assert.equal(ignores('sub/a.tmp'), true);
      assert.equal(ignores('.gstack/run.ts'), true);
    });
  });

  it('uses only .slipstreamignore outside Git and preserves negations', async () => {
    await fixture(async (root) => {
      await rm(join(root, '.git'), { recursive: true });
      await put(root, '.slipstreamignore', '*.log\n!keep.log\n.gstack/\n');
      const policy = await loadCaptureIgnores(root);
      assert.equal(policy.git, null);
      const ignores = compileCaptureIgnores(policy);
      assert.equal(ignores('debug.log'), true);
      assert.equal(ignores('keep.log'), false);
      assert.equal(ignores('.gstack', true), true);
      assert.equal(ignores('.gstack'), false, 'a directory-only rule must not exclude a regular file');
    });
  });

  it('does not apply a nested repository rule using the outer index', async () => {
    await fixture(async (root) => {
      await mkdir(join(root, 'nested'));
      await exec('git', ['init', '-q', join(root, 'nested')]);
      await put(root, 'nested/.gitignore', '*.ts\n');
      await put(root, 'nested/keep.ts');
      await exec('git', ['-C', join(root, 'nested'), 'add', '-f', 'keep.ts']);
      const ignores = compileCaptureIgnores(await loadCaptureIgnores(root));
      assert.equal(ignores('nested/keep.ts'), false);
    });
  });

  it('rejects broken Git metadata, symlink rule files and oversized policies explicitly', async () => {
    await fixture(async (root) => {
      await symlink('/does-not-exist', join(root, '.slipstreamignore'));
      await assert.rejects(loadCaptureIgnores(root), /ignore/i);
      await rm(join(root, '.slipstreamignore'));
      await put(root, '.slipstreamignore', 'x'.repeat(512 * 1024 + 1));
      await assert.rejects(loadCaptureIgnores(root), /large|limit|budget/i);
      await rm(join(root, '.slipstreamignore'));
      await rm(join(root, '.git'), { recursive: true });
      await put(root, '.git', 'gitdir: /does-not-exist');
      await assert.rejects(loadCaptureIgnores(root), /git/i);
    });
  });

  it('rejects unsupported versions and unsafe saved paths', () => {
    assert.throws(() => parseCaptureIgnores({ version: 2, git: null, slipstreamignore: null }), /version|policy/i);
    assert.throws(() => parseCaptureIgnores({ version: 1, git: { root_prefix: '../', ignore_case: false, sources: [], tracked_exceptions: [] }, slipstreamignore: null }), /path|policy/i);
  });
});
