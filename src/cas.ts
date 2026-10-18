import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DIR_MODE,
  FILE_MODE,
  StorageError,
  assertOwnerOnly,
  fsyncDir,
  mkdirpDurable,
  writeAll,
} from './storage.ts';

export interface BlobRef {
  sha256: string;
  size: number;
}

export interface Cas {
  put(bytes: Buffer): Promise<BlobRef>;
  read(sha256: string): Promise<Buffer>;
  has(sha256: string): Promise<boolean>;
  /**
   * Make a blob already present on disk (e.g. written by a prior process) durable
   * before an event references it. Recovery calls this before reusing an existing
   * blob as a reconciliation endpoint (Q5).
   */
  ensureDurable(sha256: string): Promise<void>;
  pathFor(sha256: string): string;
}

/**
 * When an on-disk blob can be trusted without rewriting it: the only way a file
 * reaches its content address is a fully written, fsynced temp file renamed into
 * place, so a regular file of the expected size there holds the right bytes. Only
 * its directory entry might not be durable yet — so the shard (and base) are
 * fsynced once by this instance, after the blob was seen, before it is trusted.
 * That relies on one instance per store per process (the daemon shares one), and
 * no other process writing the store concurrently (the daemon's store lock;
 * standalone capture refuses a daemon-owned store).
 */
export async function createCas(rootDir: string): Promise<Cas> {
  const base = join(rootDir, 'sha256');
  await mkdirpDurable(base);
  await assertOwnerOnly(rootDir, 'dir');
  await assertOwnerOnly(base, 'dir');

  /** sha256 -> durably published (temp+fsync+rename+dir-fsync completed this process). */
  const durable = new Set<string>();
  /** shard dirs whose creation has been fsync'd into `base`. */
  const durableShards = new Set<string>();
  /** In-flight publishes, keyed by sha, so concurrent same-hash puts share one write. */
  const inFlight = new Map<string, Promise<BlobRef>>();
  /** shard dirs fsynced by this instance (with `base` before them), covering every entry present then. */
  const syncedShards = new Map<string, Promise<void>>();
  let baseSynced: Promise<void> | undefined;

  const pathFor = (sha256: string): string => join(base, sha256.slice(0, 2), sha256);

  const has = async (sha256: string): Promise<boolean> => {
    try {
      await access(pathFor(sha256));
      return true;
    } catch {
      return false;
    }
  };

  const syncShardOnce = (shard: string): Promise<void> => {
    let pending = syncedShards.get(shard);
    if (!pending) {
      pending = (async () => {
        baseSynced ??= fsyncDir(base);
        await baseSynced;
        await fsyncDir(shard);
      })();
      pending.catch(() => {
        syncedShards.delete(shard);
        baseSynced = undefined;
      });
      syncedShards.set(shard, pending);
    }
    return pending;
  };

  /** Size of the regular file at the blob's address, or undefined if there is none. */
  const storedSize = async (sha256: string): Promise<number | undefined> => {
    try {
      const st = await lstat(pathFor(sha256));
      return st.isFile() ? st.size : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new StorageError('stat-blob', err);
    }
  };

  const publish = async (sha256: string, bytes: Buffer): Promise<BlobRef> => {
    const dest = pathFor(sha256);
    const shard = dirname(dest);

    if (!durableShards.has(shard)) {
      try {
        await mkdir(shard, { recursive: true, mode: DIR_MODE });
      } catch (err) {
        throw new StorageError('mkdir-shard', err);
      }
      await fsyncDir(base); // persist the new shard directory entry
      durableShards.add(shard);
    }

    const tmp = `${dest}.${randomUUID()}.tmp`;
    let handle;
    try {
      try {
        handle = await open(tmp, 'wx', FILE_MODE);
        await writeAll(handle, bytes);
        await handle.sync();
      } catch (err) {
        throw new StorageError('write-blob', err);
      } finally {
        await handle?.close();
      }

      try {
        await rename(tmp, dest);
      } catch (err) {
        throw new StorageError('rename-blob', err);
      }
      await fsyncDir(shard); // persist the rename into the shard directory
    } catch (err) {
      // An earlier sync of this shard no longer covers the entry that may have landed.
      syncedShards.delete(shard);
      throw err;
    } finally {
      await unlink(tmp).catch(() => {});
    }

    durable.add(sha256);
    return { sha256, size: bytes.length };
  };

  const put = async (bytes: Buffer): Promise<BlobRef> => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (durable.has(sha256)) return { sha256, size: bytes.length };

    const existing = inFlight.get(sha256);
    if (existing) return existing;

    const pending = (async () => {
      if ((await storedSize(sha256)) === bytes.length) {
        await syncShardOnce(dirname(pathFor(sha256)));
        durable.add(sha256);
        return { sha256, size: bytes.length };
      }
      return publish(sha256, bytes);
    })().finally(() => inFlight.delete(sha256));
    inFlight.set(sha256, pending);
    return pending;
  };

  const read = (sha256: string): Promise<Buffer> => readFile(pathFor(sha256));

  const ensureDurable = async (sha256: string): Promise<void> => {
    if (durable.has(sha256)) return;
    if ((await storedSize(sha256)) === undefined) {
      throw new StorageError('fsync-blob', Object.assign(new Error(`blob ${sha256} is missing`), { code: 'ENOENT' }));
    }
    await syncShardOnce(dirname(pathFor(sha256)));
    durable.add(sha256);
  };

  return { put, read, has, ensureDurable, pathFor };
}

export { StorageError } from './storage.ts';
