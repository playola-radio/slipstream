import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isUnder,
  pathsOverlap,
  canonicalize,
  checkRootAgainstRealStore,
  OWNER_MARKER_NAME,
  OWNER_FORMAT,
  writeOwnerMarker,
  readOwnerMarker,
  evaluateRoot,
  prepareRoot,
  mayDeleteRoot,
} from './safety.ts';

describe('safety', () => {
  let base: string;
  before(async () => { base = await mkdtemp(join(tmpdir(), 'slipstream-qa-safety-')); });
  after(async () => { await rm(base, { recursive: true, force: true }); });

  describe('isUnder / pathsOverlap', () => {
    it('treats a real subpath as under, but a sibling prefix as not', () => {
      assert.equal(isUnder('/home/u/.slipstream/store', '/home/u/.slipstream'), true);
      // The QA default root is a *sibling* whose name shares a prefix — must NOT be under.
      assert.equal(isUnder('/home/u/.slipstream-qa', '/home/u/.slipstream'), false);
      assert.equal(isUnder('/home/u/.slipstream', '/home/u/.slipstream'), false);
    });

    it('treats a child whose name starts with ".." as under (not a sibling)', () => {
      // Regression: a literal `..qa` child was excluded by a naive startsWith('..'),
      // letting `--root ~/.slipstream/..qa` bypass the real-store overlap guard.
      assert.equal(isUnder('/home/u/.slipstream/..qa', '/home/u/.slipstream'), true);
      assert.equal(isUnder('/home/u/.slipstream/..', '/home/u/.slipstream'), false);
      assert.equal(pathsOverlap('/home/u/.slipstream/..qa', '/home/u/.slipstream'), true);
    });

    it('detects overlap in either direction, including equality', () => {
      assert.equal(pathsOverlap('/a/b', '/a/b'), true);
      assert.equal(pathsOverlap('/a/b/c', '/a/b'), true);
      assert.equal(pathsOverlap('/a/b', '/a/b/c'), true);
      assert.equal(pathsOverlap('/a/b', '/a/c'), false);
      assert.equal(pathsOverlap('/a/.slipstream-qa', '/a/.slipstream'), false);
    });
  });

  describe('canonicalize', () => {
    it('resolves symlinks in an existing prefix and keeps the non-existent remainder', async () => {
      const real = join(base, 'real');
      await mkdir(real);
      const link = join(base, 'link');
      await symlink(real, link);
      const got = await canonicalize(join(link, 'store', 'x'));
      assert.equal(got, join(await realpath(real), 'store', 'x'));
    });
  });

  describe('checkRootAgainstRealStore', () => {
    const realStore = '/home/u/.slipstream';
    it('refuses the real store itself', async () => {
      const r = await checkRootAgainstRealStore('/home/u/.slipstream', realStore);
      assert.ok(r && r.code === 'REFUSED_REAL_STORE');
    });
    it('refuses a path under the real store', async () => {
      const r = await checkRootAgainstRealStore('/home/u/.slipstream/inner', realStore);
      assert.ok(r && r.code === 'REFUSED_REAL_STORE');
    });
    it('refuses a path that contains the real store', async () => {
      const r = await checkRootAgainstRealStore('/home/u', realStore);
      assert.ok(r && r.code === 'REFUSED_REAL_STORE');
    });
    it('allows the sibling default QA root', async () => {
      const r = await checkRootAgainstRealStore('/home/u/.slipstream-qa/local', realStore);
      assert.equal(r, null);
    });
  });

  describe('owner marker', () => {
    it('writes an owner-only marker and reads it back', async () => {
      const root = join(base, 'owned');
      await mkdir(root);
      await writeOwnerMarker(root, 'run-123');
      const marker = await readOwnerMarker(root);
      assert.ok(marker);
      assert.equal(marker.format, OWNER_FORMAT);
      assert.equal(marker.run_id, 'run-123');
      const raw = JSON.parse(await readFile(join(root, OWNER_MARKER_NAME), 'utf8'));
      assert.equal(raw.format, OWNER_FORMAT);
    });
    it('returns null for a missing marker and for a foreign file', async () => {
      const root = join(base, 'unowned');
      await mkdir(root);
      assert.equal(await readOwnerMarker(root), null);
      await writeFile(join(root, OWNER_MARKER_NAME), 'not json');
      assert.equal(await readOwnerMarker(root), null);
    });

    it('is first-writer-wins: a second concurrent claim never overwrites the first', async () => {
      const root = join(base, 'race');
      await mkdir(root);
      const first = await writeOwnerMarker(root, 'run-first');
      assert.equal(first, true);
      const second = await writeOwnerMarker(root, 'run-second');
      assert.equal(second, false);
      // The original claimant's marker must survive untouched.
      const marker = await readOwnerMarker(root);
      assert.equal(marker?.run_id, 'run-first');
    });
  });

  describe('evaluateRoot', () => {
    const noDaemon = async () => 'none' as const;

    it('accepts a non-existent root in fresh mode', async () => {
      const root = join(base, 'fresh-new');
      const v = await evaluateRoot(root, { reuse: false, probe: noDaemon });
      assert.ok(v.ok);
    });

    it('refuses an existing non-empty root in fresh mode', async () => {
      const root = join(base, 'fresh-dirty');
      await mkdir(root);
      await writeFile(join(root, 'junk'), 'x');
      const v = await evaluateRoot(root, { reuse: false, probe: noDaemon });
      assert.ok(!v.ok);
      assert.equal(v.code, 'ROOT_NOT_FRESH');
    });

    it('accepts an existing empty root in fresh mode', async () => {
      const root = join(base, 'fresh-empty');
      await mkdir(root);
      const v = await evaluateRoot(root, { reuse: false, probe: noDaemon });
      assert.ok(v.ok);
    });

    it('reuse refuses a non-existent root', async () => {
      const v = await evaluateRoot(join(base, 'reuse-missing'), { reuse: true, probe: noDaemon });
      assert.ok(!v.ok);
      assert.equal(v.code, 'ROOT_NOT_OWNED');
    });

    it('reuse refuses a root without a valid owner marker (ambiguous)', async () => {
      const root = join(base, 'reuse-foreign');
      await mkdir(root);
      await writeFile(join(root, 'data'), 'x');
      const v = await evaluateRoot(root, { reuse: true, probe: noDaemon });
      assert.ok(!v.ok);
      assert.equal(v.code, 'ROOT_NOT_OWNED');
    });

    it('reuse accepts a harness-owned root', async () => {
      const root = join(base, 'reuse-owned');
      await mkdir(root);
      await writeOwnerMarker(root, 'run-x');
      const v = await evaluateRoot(root, { reuse: true, probe: noDaemon });
      assert.ok(v.ok);
    });

    it('refuses when a daemon is live in the root store, regardless of mode', async () => {
      const root = join(base, 'live');
      await mkdir(root);
      await writeOwnerMarker(root, 'run-x');
      const liveProbe = async () => 'live' as const;
      const v = await evaluateRoot(root, { reuse: true, probe: liveProbe });
      assert.ok(!v.ok);
      assert.equal(v.code, 'ROOT_DAEMON_LIVE');
    });

    it('refuses when the root store daemon liveness is ambiguous', async () => {
      const root = join(base, 'ambig');
      await mkdir(root);
      await writeOwnerMarker(root, 'run-x');
      const ambiguousProbe = async () => 'ambiguous' as const;
      const v = await evaluateRoot(root, { reuse: true, probe: ambiguousProbe });
      assert.ok(!v.ok);
      assert.equal(v.code, 'ROOT_DAEMON_LIVE');
    });
  });

  describe('prepareRoot', () => {
    it('creates the marker, store and worktree under a fresh root', async () => {
      const root = join(base, 'prep-fresh');
      const { store, worktree } = await prepareRoot(root, 'run-p');
      assert.equal(store, join(root, 'store'));
      assert.equal(worktree, join(root, 'worktree'));
      assert.ok(await readOwnerMarker(root));
    });

    it('refuses a symlinked store or worktree (no writes escape via a planted link)', async () => {
      const root = join(base, 'prep-symlink');
      await mkdir(root, { recursive: true });
      const elsewhere = join(base, 'prep-symlink-target');
      await mkdir(elsewhere, { recursive: true });
      await symlink(elsewhere, join(root, 'worktree'));
      await assert.rejects(prepareRoot(root, 'run-p'), /symlink/i);
    });

    it('is idempotent under --reuse: a retry with the same runId keeps the original marker', async () => {
      const root = join(base, 'prep-reuse');
      await prepareRoot(root, 'run-same');
      const before = await readOwnerMarker(root);
      const { store, worktree } = await prepareRoot(root, 'run-same');
      assert.equal(store, join(root, 'store'));
      assert.equal(worktree, join(root, 'worktree'));
      const after = await readOwnerMarker(root);
      assert.equal(after?.created_at_ms, before?.created_at_ms);
    });

    it('refuses a second concurrent claimant instead of silently taking over ownership', async () => {
      const root = join(base, 'prep-race');
      await prepareRoot(root, 'run-winner');
      // A second, distinct run racing on the same (now-owned) root must refuse
      // rather than proceed as if it had claimed it.
      await assert.rejects(prepareRoot(root, 'run-loser'), /concurrent run claimed ownership/);
      const marker = await readOwnerMarker(root);
      assert.equal(marker?.run_id, 'run-winner');
    });
  });

  describe('mayDeleteRoot', () => {
    it('permits deletion only when the marker names this run', async () => {
      const root = join(base, 'delete-scope');
      await mkdir(root);
      await writeOwnerMarker(root, 'run-mine');
      assert.equal(await mayDeleteRoot(root, 'run-mine'), true);
      assert.equal(await mayDeleteRoot(root, 'run-other'), false);
    });

    it('refuses deletion when there is no marker', async () => {
      const root = join(base, 'delete-unmarked');
      await mkdir(root);
      assert.equal(await mayDeleteRoot(root, 'run-mine'), false);
    });
  });
});
