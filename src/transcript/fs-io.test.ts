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
    // A valid first line longer than the internal read chunk (64 KiB), with a
    // multibyte character (é) straddling the 64 KiB boundary, followed by a
    // second line. A chunked read must return the COMPLETE first line, never a
    // truncated prefix and never a false "malformed" from a split multibyte char.
    const pad = 'x'.repeat(65_535);
    await writeFile(join(dir, 'longline.jsonl'), `{"pad":"${pad}é","cwd":"/work/proj"}\n{"next":1}\n`);
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

  it('returns a complete first line longer than the read chunk, decoding across the boundary', async () => {
    const result = await nodeDiscoveryIO.readFirstLine(join(dir, 'longline.jsonl'));
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.line.startsWith('{"pad":"'));
    assert.ok(result.ok && result.line.endsWith('é","cwd":"/work/proj"}'), 'multibyte across the boundary survives');
    assert.ok(result.ok && !result.line.includes('\n'), 'stops at the first newline');
    assert.ok(result.ok && JSON.parse(result.line).cwd === '/work/proj', 'the complete line parses');
  });

  it('reports an oversized first line as malformed even when a newline terminates it', async () => {
    // The size bound must hold whether or not the line ends: a terminated giant
    // line is as unusable as an unterminated one and must not slip through as ok.
    const oversized = Buffer.concat([Buffer.alloc(16 * 1024 * 1024 + 1, 0x78), Buffer.from('\n')]);
    await writeFile(join(dir, 'oversized.jsonl'), oversized);
    assert.deepEqual(await nodeDiscoveryIO.readFirstLine(join(dir, 'oversized.jsonl')), {
      ok: false,
      reason: 'malformed',
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

describe('nodeDiscoveryIO.readHeadLines', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ss-headlines-'));
    await writeFile(
      join(dir, 'preamble.jsonl'),
      '{"type":"ai-title"}\n{"type":"user","cwd":"/work/proj"}\n{"type":"assistant"}\n',
    );
    await writeFile(join(dir, 'empty.jsonl'), '');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the head lines so a cwd past the preamble is reachable', async () => {
    const result = await nodeDiscoveryIO.readHeadLines(join(dir, 'preamble.jsonl'));
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.lines, [
      '{"type":"ai-title"}',
      '{"type":"user","cwd":"/work/proj"}',
      '{"type":"assistant"}',
    ]);
    assert.equal(result.ok && result.truncated, false, 'the whole file was read');
    assert.equal(result.ok && result.skipped, false, 'no line was dropped');
  });

  it('skips an oversized line but keeps the cwd-bearing line around it', async () => {
    // A large attachment line (over the per-line cap) is discarded, not accumulated
    // unbounded; the smaller cwd-bearing records around it still come back so the
    // cwd remains reachable.
    const huge = 'x'.repeat(256 * 1024 + 1);
    await writeFile(
      join(dir, 'huge.jsonl'),
      `{"type":"ai-title"}\n{"pad":"${huge}"}\n{"type":"user","cwd":"/work/proj"}\n`,
    );
    const result = await nodeDiscoveryIO.readHeadLines(join(dir, 'huge.jsonl'));
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.lines.includes('{"type":"ai-title"}'));
    assert.ok(result.ok && result.lines.includes('{"type":"user","cwd":"/work/proj"}'));
    assert.ok(result.ok && !result.lines.some((l) => l.includes('x'.repeat(1000))), 'the oversized line is skipped');
    assert.equal(result.ok && result.skipped, true, 'dropping the oversized line is disclosed, not silent');
  });

  it('reports an empty file distinctly', async () => {
    assert.deepEqual(await nodeDiscoveryIO.readHeadLines(join(dir, 'empty.jsonl')), {
      ok: false,
      reason: 'empty',
    });
  });

  it('reports a missing file as inaccessible', async () => {
    assert.deepEqual(await nodeDiscoveryIO.readHeadLines(join(dir, 'nope.jsonl')), {
      ok: false,
      reason: 'inaccessible',
    });
  });
});
