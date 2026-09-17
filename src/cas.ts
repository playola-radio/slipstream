import { createHash, randomUUID } from 'node:crypto';
import { access, open, mkdir, readFile, rename } from 'node:fs/promises';
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
   * Force a blob already present on disk (e.g. written by a prior process) to be
   * durable: fsync its file and shard directory. Recovery calls this before
   * reusing an existing blob as a reconciliation endpoint (Q5).
   */
  ensureDurable(sha256: string): Promise<void>;
  pathFor(sha256: string): string;
}

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

  const pathFor = (sha256: string): string => join(base, sha256.slice(0, 2), sha256);

  const has = async (sha256: string): Promise<boolean> => {
    try {
      await access(pathFor(sha256));
      return true;
    } catch {
      return false;
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

    durable.add(sha256);
    return { sha256, size: bytes.length };
  };

  const put = async (bytes: Buffer): Promise<BlobRef> => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (durable.has(sha256)) return { sha256, size: bytes.length };

    const existing = inFlight.get(sha256);
    if (existing) return existing;

    const pending = publish(sha256, bytes).finally(() => inFlight.delete(sha256));
    inFlight.set(sha256, pending);
    return pending;
  };

  const read = (sha256: string): Promise<Buffer> => readFile(pathFor(sha256));

  const ensureDurable = async (sha256: string): Promise<void> => {
    if (durable.has(sha256)) return;
    const dest = pathFor(sha256);
    let handle;
    try {
      handle = await open(dest, 'r');
      await handle.sync();
    } catch (err) {
      throw new StorageError('fsync-blob', err);
    } finally {
      await handle?.close();
    }
    await fsyncDir(dirname(dest)); // persist the blob's shard entry
    durable.add(sha256);
  };

  return { put, read, has, ensureDurable, pathFor };
}

export { StorageError } from './storage.ts';
