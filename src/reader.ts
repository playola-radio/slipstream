import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Cas } from './cas.ts';
import { StorageError } from './storage.ts';
import type { Snapshot } from './snapshot.ts';

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

interface StatShape {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * A read is trustworthy only if the file did not change while we were reading
 * it. If size, mtime, or ctime moved between the pre-read and post-read stat,
 * the bytes we hold may be a torn mix of two states — which we must never
 * record as a real endpoint. ctime is included because it cannot be set
 * backward via `utimes`, so it still moves when a writer restores the original
 * mtime to hide a mid-read change. Callers retry, then fall back to
 * `unavailable/unstable`.
 */
export function isStableAcross(before: StatShape, after: StatShape): boolean {
  return before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

export interface Reader {
  read(relPath: string): Promise<Snapshot>;
}

export interface ReaderOptions {
  root: string;
  cas: Cas;
  maxBytes?: number;
  openFile?: (path: string, flags: number) => Promise<FileHandle>;
}

const STABILITY_RETRIES = 3;

export function createReader(opts: ReaderOptions): Reader {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const retries = STABILITY_RETRIES;
  const openFile = opts.openFile ?? open;

  const read = async (relPath: string): Promise<Snapshot> => {
    const abs = join(opts.root, relPath);

    for (let attempt = 0; attempt <= retries; attempt++) {
      let before: StatShape;
      try {
        const st = await lstat(abs);
        if (st.isSymbolicLink() || !st.isFile()) return { kind: 'absent' };
        before = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
        return { kind: 'unavailable', reason: 'io-error' };
      }

      if (before.size > maxBytes) return { kind: 'unavailable', reason: 'oversize' };

      let handle;
      try {
        handle = await openFile(abs, constants.O_RDONLY | constants.O_NONBLOCK);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { kind: 'absent' };
        if (code === 'EACCES' || code === 'EPERM') return { kind: 'unavailable', reason: 'unreadable' };
        return { kind: 'unavailable', reason: 'io-error' };
      }

      try {
        const opened = await handle.stat();
        if (!opened.isFile()) return { kind: 'absent' };
        if (opened.size > maxBytes) return { kind: 'unavailable', reason: 'oversize' };

        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        const st = await handle.stat();
        if (st.size > maxBytes) return { kind: 'unavailable', reason: 'oversize' };
        if (!isStableAcross(before, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs })) {
          continue; // torn read; re-observe from a fresh stat
        }
        const ref = await opts.cas.put(bytes.subarray(0, offset));
        return { kind: 'content', sha256: ref.sha256, size: ref.size };
      } catch (err) {
        // A failure to durably publish the blob is a *storage* fault, not an
        // unreadable source file. Never launder it into an `unavailable`
        // snapshot — propagate so capture can suspend and disclose a gap.
        if (err instanceof StorageError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') return { kind: 'unavailable', reason: 'unreadable' };
        return { kind: 'unavailable', reason: 'io-error' };
      } finally {
        await handle.close();
      }
    }

    return { kind: 'unavailable', reason: 'unstable' };
  };

  return { read };
}
