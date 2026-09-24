import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, discoverImportClosure } from '../src/fold-release.ts';
import {
  parseFoldReleaseArgs,
  runFoldRelease,
  checkImmutability,
  FoldReleaseArgError,
  FOLD_RELEASE_EXIT,
  DEFAULT_BASE,
  type RunFoldReleaseIO,
} from './fold-release-check.ts';

/** Collect a run's single stdout JSON line + exit code. */
function run(argv: string[], cwd = REPO_ROOT): { code: number; json: unknown; err: string[] } {
  let out = '';
  const err: string[] = [];
  const io: RunFoldReleaseIO = { argv, cwd, stdout: (l) => { out += l; }, stderr: (l) => err.push(l) };
  const code = runFoldRelease(io);
  return { code, json: out ? JSON.parse(out) : null, err };
}

/** A temp copy of just what the gates read, with the manifest. Not a git repo. */
async function stageTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'slip-foldrel-'));
  await mkdir(join(root, 'src'), { recursive: true });
  for (const rel of discoverImportClosure(REPO_ROOT)) await cp(join(REPO_ROOT, rel), join(root, rel));
  await cp(join(REPO_ROOT, 'contracts/display-fold/v1'), join(root, 'contracts/display-fold/v1'), { recursive: true });
  return root;
}

describe('fold-release arg parsing', () => {
  it('defaults root to cwd and base to the integration branch', () => {
    assert.deepEqual(parseFoldReleaseArgs([], '/x'), { root: '/x', base: DEFAULT_BASE });
  });
  it('rejects an unknown flag', () => {
    assert.throws(() => parseFoldReleaseArgs(['--nope'], '/x'), FoldReleaseArgError);
  });
  it('rejects a flag missing its value', () => {
    assert.throws(() => parseFoldReleaseArgs(['--base'], '/x'), FoldReleaseArgError);
  });
  it('rejects a flag whose value is another option', () => {
    assert.throws(() => parseFoldReleaseArgs(['--root', '--base'], '/x'), FoldReleaseArgError);
  });
});

describe('fold-release against the real repo', () => {
  it('passes both gates on the committed tree', () => {
    const { code, json } = run([]);
    assert.equal(code, FOLD_RELEASE_EXIT.PASS);
    const r = json as { fingerprint: { passed: boolean }; immutability: { checked: boolean; violations?: string[] } };
    assert.equal(r.fingerprint.passed, true);
    assert.equal(r.immutability.checked, true);
    assert.deepEqual(r.immutability.violations, []);
  });

  it('exits 2 when the base ref does not resolve', () => {
    const { code, json } = run(['--base', 'no-such-ref-xyz']);
    assert.equal(code, FOLD_RELEASE_EXIT.USAGE);
    assert.equal((json as { immutability: { checked: boolean } }).immutability.checked, false);
  });

  it('reports the committed corpus as immutable vs the base branch', () => {
    const imm = checkImmutability(REPO_ROOT, DEFAULT_BASE);
    assert.equal(imm.checked, true);
    if (imm.checked) assert.deepEqual(imm.violations, []);
  });
});

describe('fold-release over a temp copy (no git)', () => {
  it('passes gate 3 and reports immutability not-applicable on a clean copy', async () => {
    const root = await stageTree();
    try {
      const { code, json } = run(['--root', root]);
      assert.equal(code, FOLD_RELEASE_EXIT.PASS);
      assert.equal((json as { immutability: { checked: boolean } }).immutability.checked, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exits 1 and names the case when a corpus fixture is altered', async () => {
    const root = await stageTree();
    try {
      const p = join(root, 'contracts/display-fold/v1/empty/expected.json');
      await writeFile(p, `${await readFile(p, 'utf8')} `);
      const { code, json } = run(['--root', root]);
      assert.equal(code, FOLD_RELEASE_EXIT.FAIL);
      const failures = (json as { fingerprint: { failures: string[] } }).fingerprint.failures;
      assert.ok(failures.some((f) => /'empty'/.test(f)), failures.join('\n'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('fold-release immutability against committed history', () => {
  function git(root: string, args: string[]): string {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }
  async function stageGitTree(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'slip-foldgit-'));
    await mkdir(join(root, 'src'), { recursive: true });
    for (const rel of discoverImportClosure(REPO_ROOT)) await cp(join(REPO_ROOT, rel), join(root, rel));
    await cp(join(REPO_ROOT, 'contracts/display-fold/v1'), join(root, 'contracts/display-fold/v1'), { recursive: true });
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'test']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base']);
    return root;
  }

  it('flags a committed modification even after the working tree is reverted to base', async () => {
    const root = await stageGitTree();
    try {
      const base = git(root, ['rev-parse', 'HEAD']);
      const manifest = join(root, 'contracts/display-fold/v1/manifest.json');
      const original = await readFile(manifest, 'utf8');
      await writeFile(manifest, `${original}\n`); // committed change to a released file
      git(root, ['commit', '-qam', 'tamper']);
      await writeFile(manifest, original); // hide it in the working tree
      const imm = checkImmutability(root, base);
      assert.equal(imm.checked, true);
      if (imm.checked) assert.ok(imm.violations.some((v) => /manifest\.json: modified/.test(v)), imm.violations.join('\n'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes when HEAD and the working tree leave released files untouched', async () => {
    const root = await stageGitTree();
    try {
      const base = git(root, ['rev-parse', 'HEAD']);
      await writeFile(join(root, 'contracts/display-fold/v2-notes.txt'), 'a new file is an allowed addition\n');
      const imm = checkImmutability(root, base);
      assert.equal(imm.checked, true);
      if (imm.checked) assert.deepEqual(imm.violations, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
