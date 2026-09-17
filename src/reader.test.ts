import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, open, writeFile, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { isStableAcross } from './reader.ts';
import { withReader } from './test/helpers.ts';

describe('reader', () => {
  describe('read', () => {
    it('reads a regular file as content and stores its exact bytes', async () => {
      await withReader(async ({ root, read, cas }) => {
        await writeFile(join(root, 'a.txt'), 'hello');
        const snap = await read('a.txt');
        assert.equal(snap.kind, 'content');
        if (snap.kind !== 'content') return;
        assert.equal(snap.size, 5);
        assert.deepEqual(await cas.read(snap.sha256), Buffer.from('hello'));
      });
    });

    it('reads an empty file as zero-byte content, never absent', async () => {
      await withReader(async ({ root, read }) => {
        await writeFile(join(root, 'empty.txt'), '');
        const snap = await read('empty.txt');
        assert.equal(snap.kind, 'content');
        if (snap.kind === 'content') assert.equal(snap.size, 0);
      });
    });

    it('stores a binary file verbatim as content', async () => {
      await withReader(async ({ root, read, cas }) => {
        const bytes = Buffer.from([0, 159, 146, 150, 0, 255]);
        await writeFile(join(root, 'b.bin'), bytes);
        const snap = await read('b.bin');
        assert.equal(snap.kind, 'content');
        if (snap.kind === 'content') assert.deepEqual(await cas.read(snap.sha256), bytes);
      });
    });

    it('reads a missing path as absent', async () => {
      await withReader(async ({ read }) => {
        assert.deepEqual(await read('nope.txt'), { kind: 'absent' });
      });
    });

    it('excludes a symlink (never following it) and reads it as absent', async () => {
      await withReader(async ({ root, read }) => {
        await writeFile(join(root, 'target.txt'), 'secret');
        await symlink(join(root, 'target.txt'), join(root, 'link.txt'));
        assert.deepEqual(await read('link.txt'), { kind: 'absent' });
      });
    });

    it('reads a directory path as absent (not a regular file)', async () => {
      await withReader(async ({ root, read }) => {
        await mkdir(join(root, 'sub'));
        assert.deepEqual(await read('sub'), { kind: 'absent' });
      });
    });

    it('reads a file over the size limit as unavailable/oversize, never a fake blob', async () => {
      await withReader(
        async ({ root, read }) => {
          await writeFile(join(root, 'big.txt'), Buffer.alloc(20));
          assert.deepEqual(await read('big.txt'), { kind: 'unavailable', reason: 'oversize' });
        },
        { maxBytes: 10 },
      );
    });

    it('rejects a file that grows over the limit after the path lstat', async () => {
      await withReader(
        async ({ root, read }) => {
          const path = join(root, 'growing.txt');
          await writeFile(path, 'small');
          assert.deepEqual(await read('growing.txt'), { kind: 'unavailable', reason: 'oversize' });
        },
        {
          maxBytes: 5,
          openFile: async (path, flags) => {
            await writeFile(path, 'now too large');
            return open(path, flags);
          },
        },
      );
    });

    it('opens nonblocking and rejects a non-file swapped in after lstat', async () => {
      await withReader(
        async ({ root, read }) => {
          const path = join(root, 'swapped');
          await writeFile(path, 'file');
          assert.deepEqual(await read('swapped'), { kind: 'absent' });
        },
        {
          openFile: async (path, flags) => {
            assert.notEqual(flags & constants.O_NONBLOCK, 0);
            await mkdir(`${path}-directory`);
            return open(`${path}-directory`, flags);
          },
        },
      );
    });

    it('maps an EACCES open to unavailable/unreadable', async () => {
      // Deterministic at the openFile seam — no real chmod, so this holds even
      // when the suite runs as root. Real permission enforcement is proven by the
      // real-OS tier (session.os.test.ts).
      await withReader(
        async ({ root, read }) => {
          await writeFile(join(root, 'locked.txt'), 'nope');
          assert.deepEqual(await read('locked.txt'), { kind: 'unavailable', reason: 'unreadable' });
        },
        {
          openFile: async () => {
            const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          },
        },
      );
    });
  });

  describe('isStableAcross', () => {
    it('flags a size or mtime change during the read as unstable', () => {
      assert.equal(isStableAcross({ size: 10, mtimeMs: 5, ctimeMs: 5 }, { size: 12, mtimeMs: 5, ctimeMs: 5 }), false);
      assert.equal(isStableAcross({ size: 10, mtimeMs: 5, ctimeMs: 5 }, { size: 10, mtimeMs: 9, ctimeMs: 9 }), false);
      assert.equal(isStableAcross({ size: 10, mtimeMs: 5, ctimeMs: 5 }, { size: 10, mtimeMs: 5, ctimeMs: 5 }), true);
    });

    it('flags a ctime-only change as unstable (restored mtime cannot hide a mid-read write)', () => {
      // A writer that restores the original mtime via utimes still bumps ctime,
      // so a matching size+mtime with a moved ctime must still read as torn.
      assert.equal(isStableAcross({ size: 10, mtimeMs: 5, ctimeMs: 5 }, { size: 10, mtimeMs: 5, ctimeMs: 8 }), false);
    });
  });
});
