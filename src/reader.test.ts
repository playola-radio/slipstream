import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCas } from './cas.ts';
import { createReader, isStableAcross } from './reader.ts';

async function withReader(
  fn: (ctx: { root: string; read: (p: string) => ReturnType<ReturnType<typeof createReader>['read']>; cas: Awaited<ReturnType<typeof createCas>> }) => Promise<void>,
  opts: { maxBytes?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'slip-root-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-store-'));
  try {
    const cas = await createCas(store);
    const reader = createReader({ root, cas, maxBytes: opts.maxBytes });
    await fn({ root, read: (p) => reader.read(p), cas });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

test('reads a regular file as content and stores its exact bytes', async () => {
  await withReader(async ({ root, read, cas }) => {
    await writeFile(join(root, 'a.txt'), 'hello');
    const snap = await read('a.txt');
    assert.equal(snap.kind, 'content');
    if (snap.kind !== 'content') return;
    assert.equal(snap.size, 5);
    assert.deepEqual(await cas.read(snap.sha256), Buffer.from('hello'));
  });
});

test('an empty file reads as zero-byte content, never absent', async () => {
  await withReader(async ({ root, read }) => {
    await writeFile(join(root, 'empty.txt'), '');
    const snap = await read('empty.txt');
    assert.equal(snap.kind, 'content');
    if (snap.kind === 'content') assert.equal(snap.size, 0);
  });
});

test('a binary file is stored verbatim as content', async () => {
  await withReader(async ({ root, read, cas }) => {
    const bytes = Buffer.from([0, 159, 146, 150, 0, 255]);
    await writeFile(join(root, 'b.bin'), bytes);
    const snap = await read('b.bin');
    assert.equal(snap.kind, 'content');
    if (snap.kind === 'content') assert.deepEqual(await cas.read(snap.sha256), bytes);
  });
});

test('a missing path reads as absent', async () => {
  await withReader(async ({ read }) => {
    assert.deepEqual(await read('nope.txt'), { kind: 'absent' });
  });
});

test('a symlink is excluded (never followed) and reads as absent', async () => {
  await withReader(async ({ root, read }) => {
    await writeFile(join(root, 'target.txt'), 'secret');
    await symlink(join(root, 'target.txt'), join(root, 'link.txt'));
    assert.deepEqual(await read('link.txt'), { kind: 'absent' });
  });
});

test('a directory path reads as absent (not a regular file)', async () => {
  await withReader(async ({ root, read }) => {
    await mkdir(join(root, 'sub'));
    assert.deepEqual(await read('sub'), { kind: 'absent' });
  });
});

test('a file over the size limit reads as unavailable/oversize, never a fake blob', async () => {
  await withReader(
    async ({ root, read }) => {
      await writeFile(join(root, 'big.txt'), Buffer.alloc(20));
      assert.deepEqual(await read('big.txt'), { kind: 'unavailable', reason: 'oversize' });
    },
    { maxBytes: 10 },
  );
});

test('an unreadable file reads as unavailable/unreadable', async () => {
  await withReader(async ({ root, read }) => {
    const p = join(root, 'locked.txt');
    await writeFile(p, 'nope');
    await chmod(p, 0o000);
    try {
      assert.deepEqual(await read('locked.txt'), { kind: 'unavailable', reason: 'unreadable' });
    } finally {
      await chmod(p, 0o644);
    }
  });
});

test('isStableAcross flags a size change during the read as unstable', () => {
  assert.equal(isStableAcross({ size: 10, mtimeMs: 5 }, { size: 12, mtimeMs: 5 }), false);
  assert.equal(isStableAcross({ size: 10, mtimeMs: 5 }, { size: 10, mtimeMs: 9 }), false);
  assert.equal(isStableAcross({ size: 10, mtimeMs: 5 }, { size: 10, mtimeMs: 5 }), true);
});
