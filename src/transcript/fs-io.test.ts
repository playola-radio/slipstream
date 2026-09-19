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

describe('nodeDiscoveryIO.readFirstLine', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ss-firstline-'));
    await writeFile(join(dir, 'good.jsonl'), '{"type":"session_meta"}\n{"more":1}\n');
    await writeFile(join(dir, 'empty.jsonl'), '');
    // A first line whose id string carries a raw 0xFF byte (invalid UTF-8).
    await writeFile(
      join(dir, 'badutf8.jsonl'),
      Buffer.concat([Buffer.from('{"type":"session_meta","payload":{"id":"s', 'utf8'), Buffer.from([0xff]), Buffer.from('","cwd":"/x"}}\n', 'utf8')]),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the first line of a readable file', async () => {
    assert.deepEqual(await nodeDiscoveryIO.readFirstLine(join(dir, 'good.jsonl')), {
      ok: true,
      line: '{"type":"session_meta"}',
    });
  });

  it('reports an empty file distinctly', async () => {
    assert.deepEqual(await nodeDiscoveryIO.readFirstLine(join(dir, 'empty.jsonl')), {
      ok: false,
      reason: 'empty',
    });
  });

  it('reports an invalid-UTF-8 first line as malformed, never a lossily-decoded string', async () => {
    // Lossy decoding would coin a "s�" id that JSON.parse accepts, fabricating a
    // session identity. A fatal decode reports the line malformed instead.
    assert.deepEqual(await nodeDiscoveryIO.readFirstLine(join(dir, 'badutf8.jsonl')), {
      ok: false,
      reason: 'malformed',
    });
  });
});
