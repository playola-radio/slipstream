import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCas, StorageError } from './cas.ts';
import { withCas } from './test/helpers.ts';

describe('cas', () => {
  describe('put', () => {
    it('returns the sha256 and byte length of the content', async () => {
      await withCas(async (cas) => {
        const ref = await cas.put(Buffer.from('hello'));
        assert.equal(ref.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
        assert.equal(ref.size, 5);
      });
    });

    it('stores the exact bytes retrievable by hash', async () => {
      await withCas(async (cas) => {
        const bytes = Buffer.from([0, 1, 2, 255, 254]);
        const ref = await cas.put(bytes);
        assert.deepEqual(await cas.read(ref.sha256), bytes);
      });
    });

    it('stores an empty file as a real zero-byte blob, not absent', async () => {
      await withCas(async (cas) => {
        const ref = await cas.put(Buffer.alloc(0));
        assert.equal(ref.size, 0);
        assert.equal(await cas.has(ref.sha256), true);
        assert.deepEqual(await cas.read(ref.sha256), Buffer.alloc(0));
      });
    });

    it('is idempotent for identical content', async () => {
      await withCas(async (cas) => {
        const a = await cas.put(Buffer.from('same'));
        const b = await cas.put(Buffer.from('same'));
        assert.equal(a.sha256, b.sha256);
        assert.equal(await cas.has(a.sha256), true);
      });
    });

    it('shards blobs by the first two hex characters of the hash', async () => {
      await withCas(async (cas) => {
        const ref = await cas.put(Buffer.from('hello'));
        const stored = await readFile(cas.pathFor(ref.sha256));
        assert.deepEqual(stored, Buffer.from('hello'));
        assert.ok(cas.pathFor(ref.sha256).includes(`/2c/${ref.sha256}`));
      });
    });
  });

  describe('has', () => {
    it('reports false for content that was never stored', async () => {
      await withCas(async (cas) => {
        assert.equal(await cas.has('0'.repeat(64)), false);
      });
    });
  });

  describe('durable publish', () => {
    it('writes blobs owner-only (0600) inside owner-only (0700) shards', async () => {
      await withCas(async (cas) => {
        const ref = await cas.put(Buffer.from('perms'));
        const blobPath = cas.pathFor(ref.sha256);
        assert.equal((await stat(blobPath)).mode & 0o777, 0o600);
        assert.equal((await stat(dirname(blobPath))).mode & 0o777, 0o700);
      });
    });

    it('leaves no temp files behind after a successful put', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'slip-cas-'));
      try {
        const cas = await createCas(dir);
        const ref = await cas.put(Buffer.from('clean'));
        const { readdir } = await import('node:fs/promises');
        const shard = dirname(cas.pathFor(ref.sha256));
        const entries = await readdir(shard);
        assert.deepEqual(entries, [ref.sha256]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('removes its temp file when publication fails', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'slip-cas-fail-'));
      try {
        const cas = await createCas(dir);
        const bytes = Buffer.from('rename must fail');
        const sha256 = '65441fb767011edf9b8bdfb5e39b3fdf42376a50bd2f46b0d259752f5b70e589';
        const dest = cas.pathFor(sha256);
        await mkdir(dest, { recursive: true });

        await assert.rejects(() => cas.put(bytes), StorageError);
        assert.deepEqual(await readdir(dirname(dest)), [sha256]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('shares one publish across concurrent puts of identical content', async () => {
      await withCas(async (cas) => {
        const bytes = Buffer.from('concurrent');
        const [a, b, c] = await Promise.all([cas.put(bytes), cas.put(bytes), cas.put(bytes)]);
        assert.equal(a.sha256, b.sha256);
        assert.equal(b.sha256, c.sha256);
        assert.deepEqual(await cas.read(a.sha256), bytes);
      });
    });

    it('raises a typed StorageError when the store root is not writable', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'slip-cas-ro-'));
      try {
        const cas = await createCas(dir);
        const { chmod } = await import('node:fs/promises');
        await chmod(join(dir, 'sha256'), 0o500); // read+execute, no write
        await assert.rejects(() => cas.put(Buffer.from('denied')), (err: unknown) => {
          assert.ok(err instanceof StorageError, `expected StorageError, got ${err}`);
          return true;
        });
      } finally {
        const { chmod } = await import('node:fs/promises');
        await chmod(join(dir, 'sha256'), 0o700).catch(() => {});
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
