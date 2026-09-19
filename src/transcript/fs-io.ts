import {
  lstat as fsLstat,
  open,
  readdir,
  readlink as fsReadlink,
  realpath as fsRealpath,
  stat as fsStat,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { StatResult, TranscriptFileIO } from './file-reader.ts';
import type { DiscoveryIO, FirstLineResult, ListResult, MissingProbe, TreeResult } from './discovery.ts';

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

const FATAL_UTF8 = new TextDecoder('utf8', { fatal: true });
const FIRST_LINE_CHUNK = 64 * 1024;
/** A first line longer than this is not line-delimited JSONL; disclose it
 * malformed rather than accumulate unbounded memory. */
const MAX_FIRST_LINE = 16 * 1024 * 1024;

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
      // Read the COMPLETE first line: a Claude first record can exceed one chunk,
      // and a truncated prefix fails to parse, which would silently fall through to
      // slug-trust (mis-binding) or falsely split a multibyte char (false malformed).
      const chunks: Buffer[] = [];
      let total = 0;
      let pos = 0;
      let sawByte = false;
      for (;;) {
        const buf = Buffer.allocUnsafe(FIRST_LINE_CHUNK);
        const { bytesRead } = await handle.read(buf, 0, FIRST_LINE_CHUNK, pos);
        if (bytesRead === 0) break; // EOF before any newline
        sawByte = true;
        pos += bytesRead;
        const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
        if (nl >= 0) {
          chunks.push(buf.subarray(0, nl));
          total += nl;
          break;
        }
        chunks.push(buf.subarray(0, bytesRead));
        total += bytesRead;
        // A single line beyond this bound is pathological (not line-delimited
        // JSONL); disclose it malformed rather than read unbounded memory.
        if (total > MAX_FIRST_LINE) return { ok: false, reason: 'malformed' };
      }
      if (!sawByte) return { ok: false, reason: 'empty' };
      let line: string;
      try {
        // Fatal decode over the COMPLETE line bytes: a lossily-decoded id/cwd would
        // coin a fabricated session identity or membership. Invalid UTF-8 is
        // malformed, not a clean read; decoding the whole line at once keeps a
        // multibyte char that straddles a chunk boundary intact.
        line = FATAL_UTF8.decode(Buffer.concat(chunks, total));
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      return { ok: true, line };
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

  async probe(path: string): Promise<MissingProbe> {
    let stats;
    try {
      stats = await fsLstat(path);
    } catch (err) {
      // ENOENT (nothing there) and ENOTDIR (a parent component is not a directory,
      // so nothing can exist below it) are both confirmed absence. Anything else
      // (e.g. EACCES) is a failure to inspect, which must NOT masquerade as absence.
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'error' };
    }
    if (!stats.isSymbolicLink()) return { kind: 'present' };
    try {
      // The RAW literal target: callers resolve it against the filesystem so an
      // intervening symlink is followed before any `..` in the target.
      return { kind: 'symlink', target: await fsReadlink(path) };
    } catch {
      return { kind: 'error' };
    }
  },
};
