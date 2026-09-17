import { access, lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Owner-only permissions for everything Slipstream writes (captured source bytes). */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * A storage-layer failure (ENOSPC, quota, permission, I/O). Distinct from a
 * source-file read problem: a full or broken *store* must never be laundered
 * into an `unavailable` snapshot — that would fabricate a coverage claim. The
 * `code` mirrors the OS errno so callers can single out ENOSPC/EDQUOT.
 */
export class StorageError extends Error {
  readonly code: string | undefined;
  readonly operation: string;
  constructor(operation: string, cause: unknown) {
    const code = (cause as { code?: string } | null)?.code;
    super(`storage ${operation} failed${code ? ` (${code})` : ''}`, { cause });
    this.name = 'StorageError';
    this.code = code;
    this.operation = operation;
  }
}

/** fsync a directory so a newly created/renamed entry within it is durable. */
export async function fsyncDir(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch (err) {
    throw new StorageError(`fsync-dir(${dir})`, err);
  } finally {
    await handle?.close();
  }
}

/**
 * Write the whole buffer, looping on short writes. A single `handle.write` may
 * commit fewer bytes than requested under storage pressure; a truncated line
 * would corrupt every record after it, so the loop is not optional.
 */
export async function writeAll(handle: Pick<FileHandle, 'write'>, buf: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await handle.write(buf, offset, buf.length - offset);
    if (bytesWritten <= 0) throw new Error('write made no progress');
    offset += bytesWritten;
  }
}

/**
 * Create `dir` and any missing ancestors 0700, fsyncing each newly-created
 * directory's parent so the new entry is durable. `mkdir(recursive)` alone does
 * not flush parent directory entries — a crash could lose an acknowledged blob
 * or leave a surviving event pointing at a directory that never made it to disk.
 */
export async function mkdirpDurable(dir: string): Promise<void> {
  const missing: string[] = [];
  let cur = dir;
  for (;;) {
    try {
      await access(cur);
      break;
    } catch {
      missing.push(cur);
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    for (const d of missing.reverse()) {
      try {
        await mkdir(d, { mode: DIR_MODE });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        continue; // a concurrent creator won; nothing new to flush here
      }
      await fsyncDir(dirname(d)); // persist the new entry in its parent
    }
  } catch (err) {
    throw err instanceof StorageError ? err : new StorageError(`mkdirp(${dir})`, err);
  }
}

/**
 * Reject a storage path that is not exclusively the owner's: a symlink (could
 * redirect writes outside the store), group/other-accessible modes, or a
 * different owner. The store holds real captured source bytes, so lax
 * permissions on an *existing* path are a hard startup error (Q5).
 */
export async function assertOwnerOnly(path: string, kind: 'dir' | 'file'): Promise<void> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) {
    throw new StorageError(`insecure-path(${path})`, new Error('storage path is a symlink'));
  }
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) {
    throw new StorageError(`insecure-path(${path})`, new Error(`storage path is not a ${kind}`));
  }
  if ((st.mode & 0o077) !== 0) {
    throw new StorageError(`insecure-path(${path})`, new Error('storage path is group/other-accessible'));
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new StorageError(`insecure-path(${path})`, new Error('storage path is owned by another user'));
  }
}
