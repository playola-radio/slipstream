import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCas } from './cas.ts';

async function withCas(fn: (cas: Awaited<ReturnType<typeof createCas>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'slip-cas-'));
  try {
    await fn(await createCas(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('put returns the sha256 and byte length of the content', async () => {
  await withCas(async (cas) => {
    const ref = await cas.put(Buffer.from('hello'));
    assert.equal(
      ref.sha256,
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    assert.equal(ref.size, 5);
  });
});

test('put stores the exact bytes retrievable by hash', async () => {
  await withCas(async (cas) => {
    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    const ref = await cas.put(bytes);
    assert.deepEqual(await cas.read(ref.sha256), bytes);
  });
});

test('an empty file is a real zero-byte blob, not absent', async () => {
  await withCas(async (cas) => {
    const ref = await cas.put(Buffer.alloc(0));
    assert.equal(ref.size, 0);
    assert.equal(await cas.has(ref.sha256), true);
    assert.deepEqual(await cas.read(ref.sha256), Buffer.alloc(0));
  });
});

test('put is idempotent for identical content', async () => {
  await withCas(async (cas) => {
    const a = await cas.put(Buffer.from('same'));
    const b = await cas.put(Buffer.from('same'));
    assert.equal(a.sha256, b.sha256);
    assert.equal(await cas.has(a.sha256), true);
  });
});

test('put shards blobs by the first two hex characters of the hash', async () => {
  await withCas(async (cas) => {
    const ref = await cas.put(Buffer.from('hello'));
    const stored = await readFile(cas.pathFor(ref.sha256));
    assert.deepEqual(stored, Buffer.from('hello'));
    assert.ok(cas.pathFor(ref.sha256).includes(`/2c/${ref.sha256}`));
  });
});

test('has reports false for content that was never stored', async () => {
  await withCas(async (cas) => {
    assert.equal(await cas.has('0'.repeat(64)), false);
  });
});
