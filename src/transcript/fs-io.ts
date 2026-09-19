import { open, readdir, readlink as fsReadlink, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { StatResult, TranscriptFileIO } from './file-reader.ts';
import type { DiscoveryIO, FirstLineResult, ListResult, TreeResult } from './discovery.ts';

/** The real filesystem IO for transcript files. Missing → `missing`; any other
 * stat/read error → `inaccessible` (disclosed, never a silent empty read). */
export const nodeTranscriptFileIO: TranscriptFileIO = {
  async stat(path: string): Promise<StatResult> {
    try {
      const s = await fsStat(path);
      return { ok: true, size: s.size, dev: s.dev, ino: Number(s.ino) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'inaccessible' };
    }
  },
  async read(path: string, start: number, end: number): Promise<Buffer> {
    const handle = await open(path, 'r');
    try {
      const length = end - start;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

function classifyDirError(err: unknown): 'missing' | 'inaccessible' {
  return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'inaccessible';
}

/** The real filesystem IO for transcript discovery. */
export const nodeDiscoveryIO: DiscoveryIO = {
  async listDir(dir: string): Promise<ListResult> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const paths = entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => join(dir, e.name));
      return { ok: true, paths };
    } catch (err) {
      return { ok: false, reason: classifyDirError(err) };
    }
  },

  async listTreeJsonl(dir: string, limit: number): Promise<TreeResult> {
    const paths: string[] = [];
    let truncated = false;
    let incomplete = false;
    const stack: string[] = [dir];
    let rootErrored: 'missing' | 'inaccessible' | undefined;
    let first = true;
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (err) {
        if (first) rootErrored = classifyDirError(err);
        else incomplete = true; // a subdirectory we could not read: disclose the gap
        continue;
      } finally {
        first = false;
      }
      for (const e of entries) {
        const full = join(current, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          if (paths.length >= limit) {
            truncated = true;
            continue;
          }
          paths.push(full);
        }
      }
    }
    if (rootErrored) return { ok: false, reason: rootErrored };
    return { paths, truncated, incomplete };
  },

  async readFirstLine(path: string): Promise<FirstLineResult> {
    let handle;
    try {
      handle = await open(path, 'r');
    } catch {
      return { ok: false, reason: 'inaccessible' };
    }
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead === 0) return { ok: false, reason: 'empty' };
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const nl = text.indexOf('\n');
      return { ok: true, line: nl >= 0 ? text.slice(0, nl) : text };
    } catch {
      return { ok: false, reason: 'inaccessible' };
    } finally {
      await handle.close();
    }
  },

  async realpath(path: string): Promise<string | undefined> {
    try {
      return await fsRealpath(path);
    } catch {
      return undefined;
    }
  },

  async readlink(path: string): Promise<string | undefined> {
    try {
      const target = await fsReadlink(path);
      // Resolve a relative target against the link's own directory so callers
      // always receive an absolute path.
      return resolve(dirname(path), target);
    } catch {
      return undefined;
    }
  },
};
