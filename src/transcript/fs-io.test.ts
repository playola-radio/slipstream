import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeDiscoveryIO } from './fs-io.ts';

describe('nodeDiscoveryIO.probe', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ss-probe-'));
    await writeFile(join(dir, 'file'), 'x');
    await symlink('/nowhere/gone', join(dir, 'dangling'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a plain missing entry as absent', async () => {
    assert.deepEqual(await nodeDiscoveryIO.probe(join(dir, 'missing')), { kind: 'absent' });
  });

  it('reports a path under a non-directory (ENOTDIR) as absent, not an error', async () => {
    // `file` is a regular file, so `file/child` can never exist. ENOTDIR is
    // confirmed absence — misreporting it as an error would wrongly disclose an
    // out-of-root dead cwd and degrade an unrelated root's coverage.
    assert.deepEqual(await nodeDiscoveryIO.probe(join(dir, 'file', 'child')), { kind: 'absent' });
  });

  it('reports an existing non-symlink as present', async () => {
    assert.deepEqual(await nodeDiscoveryIO.probe(join(dir, 'file')), { kind: 'present' });
  });

  it('reports a dangling symlink with its raw target, not as absent', async () => {
    assert.deepEqual(await nodeDiscoveryIO.probe(join(dir, 'dangling')), {
      kind: 'symlink',
      target: '/nowhere/gone',
    });
  });
});
