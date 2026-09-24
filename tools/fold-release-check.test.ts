import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
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
