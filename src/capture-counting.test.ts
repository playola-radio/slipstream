import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fstatSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapture } from './session.ts';
import { createFakePlatform } from './test/fake-platform.ts';

// Counting tests: each one counts operations, never time.

async function withTempPair(fn: (root: string, store: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'slip-cwt-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-cst-'));
  try {
    await fn(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

/** Every blob file in the store, keyed by name, with its inode. */
async function blobInodes(store: string): Promise<Map<string, number>> {
  const base = join(store, 'blobs', 'sha256');
  const out = new Map<string, number>();
  for (const shard of await readdir(base)) {
    for (const name of await readdir(join(base, shard))) {
      out.set(name, (await stat(join(base, shard, name))).ino);
    }
  }
  return out;
}

/** Count fsyncs of open files whose inode is in `inodes`, while `fn` runs. */
async function countFileSyncs(inodes: Set<number>, fn: () => Promise<void>): Promise<number> {
  const probe = await open(import.meta.filename, 'r');
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void>; datasync: () => Promise<void> };
  await probe.close();
  let count = 0;
  const counting = (original: () => Promise<void>) =>
    function (this: { fd: number }) {
      if (inodes.has(fstatSync(this.fd).ino)) count += 1;
      return original.call(this);
    };
  const sync = mock.method(proto, 'sync', counting(proto.sync));
  const datasync = mock.method(proto, 'datasync', counting(proto.datasync));
  try {
    await fn();
  } finally {
    sync.mock.restore();
    datasync.mock.restore();
  }
  return count;
}

async function seedWorktree(root: string): Promise<void> {
  await mkdir(join(root, 'src'));
  for (let i = 0; i < 20; i++) await writeFile(join(root, 'src', `f${i}.ts`), `export const v${i} = ${i};\n`);
}

describe('counting: starting a capture over blobs already in the store', () => {
  it('a new capture publishes no new blobs and fsyncs no blob files', async () => {
    await withTempPair(async (root, store) => {
      await seedWorktree(root);
      const first = await startCapture({ root, storeDir: store }, { platform: createFakePlatform() });
      await first.stop();
      const before = await blobInodes(store);
      assert.ok(before.size >= 20);

      const syncs = await countFileSyncs(new Set(before.values()), async () => {
        const second = await startCapture({ root, storeDir: store }, { platform: createFakePlatform() });
        await second.stop();
      });

      assert.deepEqual(await blobInodes(store), before);
      assert.equal(syncs, 0);
    });
  });

  it('resuming a capture publishes no new blobs and fsyncs no blob files', async () => {
    await withTempPair(async (root, store) => {
      await seedWorktree(root);
      const first = await startCapture({ root, storeDir: store }, { platform: createFakePlatform() });
      const sessionId = first.sessionId;
      await first.stop();
      const before = await blobInodes(store);

      const syncs = await countFileSyncs(new Set(before.values()), async () => {
        const resumed = await startCapture(
          { root, storeDir: store, resumeSessionId: sessionId },
          { platform: createFakePlatform() },
        );
        await resumed.stop();
      });

      assert.deepEqual(await blobInodes(store), before);
      assert.equal(syncs, 0);
    });
  });
});
