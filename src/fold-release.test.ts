import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO_ROOT,
  FOLD_ENTRY,
  FORBIDDEN_IN_CLOSURE,
  discoverImportClosure,
  checkFingerprintGate,
  computeFingerprint,
  loadManifest,
  FoldReleaseError,
} from './fold-release.ts';

/** A minimal working tree holding just what the release gate reads: the fold's
 * import closure, the v1 corpus, and the manifest. */
async function stageTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'slip-fold-'));
  await mkdir(join(root, 'src'), { recursive: true });
  const deps = discoverImportClosure(REPO_ROOT);
  for (const rel of deps) await cp(join(REPO_ROOT, rel), join(root, rel));
  await cp(join(REPO_ROOT, 'contracts/display-fold/v1'), join(root, 'contracts/display-fold/v1'), { recursive: true });
  return root;
}

describe('fold-release closure discovery', () => {
  it('is exactly the four pure display files and excludes attribution scoring', () => {
    const deps = discoverImportClosure(REPO_ROOT);
    assert.deepEqual(deps, ['src/attribution.ts', 'src/display-fold.ts', 'src/event.ts', 'src/snapshot.ts']);
    assert.ok(!deps.includes(FORBIDDEN_IN_CLOSURE));
  });

  it('rejects a dynamic import in a closure file', async () => {
    const root = await stageTree();
    try {
      const p = join(root, FOLD_ENTRY);
      const src = await readFile(p, 'utf8');
      await writeFile(p, `const late = () => import('./snapshot.ts');\n${src}`);
      assert.throws(() => discoverImportClosure(root), FoldReleaseError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a bare (non-relative) import in a closure file', async () => {
    const root = await stageTree();
    try {
      const p = join(root, FOLD_ENTRY);
      const src = await readFile(p, 'utf8');
      await writeFile(p, `import { createHash } from 'node:crypto';\nvoid createHash;\n${src}`);
      assert.throws(() => discoverImportClosure(root), FoldReleaseError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('fold-release fingerprint gate', () => {
  it('passes against the committed manifest', () => {
    assert.deepEqual(checkFingerprintGate(REPO_ROOT), []);
  });

  it('the released fingerprint matches the recomputed one', () => {
    const m = loadManifest(REPO_ROOT);
    const deps = discoverImportClosure(REPO_ROOT);
    assert.equal(computeFingerprint(REPO_ROOT, deps), m.implementation_fingerprint);
  });

  it('fails on a changed byte in a listed dependency', async () => {
    const root = await stageTree();
    try {
      await cp(join(REPO_ROOT, 'contracts/display-fold/v1/manifest.json'), join(root, 'contracts/display-fold/v1/manifest.json'));
      const p = join(root, 'src/snapshot.ts');
      await writeFile(p, `${await readFile(p, 'utf8')}\n// drift\n`);
      const failures = checkFingerprintGate(root);
      assert.ok(failures.some((f) => /fingerprint changed/.test(f)), failures.join('\n'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when the closure gains an import the manifest does not list', async () => {
    const root = await stageTree();
    try {
      await cp(join(REPO_ROOT, 'contracts/display-fold/v1/manifest.json'), join(root, 'contracts/display-fold/v1/manifest.json'));
      await writeFile(join(root, 'src/extra.ts'), 'export const extra = 1;\n');
      const p = join(root, FOLD_ENTRY);
      await writeFile(p, `import { extra } from './extra.ts';\nvoid extra;\n${await readFile(p, 'utf8')}`);
      const failures = checkFingerprintGate(root);
      assert.ok(failures.some((f) => /not listed in the manifest/.test(f) && /extra\.ts/.test(f)), failures.join('\n'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails and names the case when a corpus expected.json changes', async () => {
    const root = await stageTree();
    try {
      await cp(join(REPO_ROOT, 'contracts/display-fold/v1/manifest.json'), join(root, 'contracts/display-fold/v1/manifest.json'));
      const p = join(root, 'contracts/display-fold/v1/empty/expected.json');
      await writeFile(p, `${await readFile(p, 'utf8')} `);
      const failures = checkFingerprintGate(root);
      assert.ok(failures.some((f) => /'empty'/.test(f) && /expected\.json changed/.test(f)), failures.join('\n'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
