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
import type {
  DiscoveryIO,
  FirstLineResult,
  HeadLinesResult,
  ListResult,
  MissingProbe,
  TreeResult,
} from './discovery.ts';

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

/** Head-scan bounds for finding a Claude transcript's first cwd-bearing record.
 * Enough lines to clear a cwd-less preamble; a per-line cap skips a large
 * attachment (its cwd, if any, recurs on the smaller records around it); a total
 * cap bounds the read even when large lines are skipped. */
const HEAD_SCAN_LINES = 64;
const HEAD_LINE_CAP = 256 * 1024;
const HEAD_SCAN_BYTES = 4 * 1024 * 1024;

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
        const lineLen = nl >= 0 ? nl : bytesRead;
        // A single line beyond this bound is pathological (not line-delimited
        // JSONL); disclose it malformed rather than read unbounded memory. Checked
        // whether or not the chunk ends the line, so a huge line terminated by a
        // newline cannot slip past the bound an unterminated one is held to.
        if (total + lineLen > MAX_FIRST_LINE) return { ok: false, reason: 'malformed' };
        chunks.push(buf.subarray(0, lineLen));
        total += lineLen;
        if (nl >= 0) break;
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

  async readHeadLines(path: string): Promise<HeadLinesResult> {
    let handle;
    try {
      handle = await open(path, 'r');
    } catch {
      return { ok: false, reason: 'inaccessible' };
    }
    try {
      const lines: string[] = [];
      let pos = 0;
      let sawByte = false;
      let truncated = false; // stopped at a line/byte budget, not EOF: more may lie beyond
      let cur: Buffer[] = []; // the current line's bytes, across chunk boundaries
      let curLen = 0;
      let skip = false; // the current line exceeded the per-line cap: discard it
      const finish = (seg: Buffer): boolean => {
        // Finalize the current line [.. seg]; return true when the line budget is hit.
        if (!skip && curLen + seg.length <= HEAD_LINE_CAP) {
          cur.push(Buffer.from(seg));
          try {
            // Fatal-decode the whole line at once so a multibyte char split across a
            // chunk survives; an undecodable line is skipped, not fabricated.
            lines.push(FATAL_UTF8.decode(Buffer.concat(cur)));
          } catch {
            /* skip an undecodable line */
          }
        }
        cur = [];
        curLen = 0;
        skip = false;
        return lines.length >= HEAD_SCAN_LINES;
      };
      outer: for (;;) {
        const buf = Buffer.allocUnsafe(FIRST_LINE_CHUNK);
        const { bytesRead } = await handle.read(buf, 0, FIRST_LINE_CHUNK, pos);
        if (bytesRead === 0) break; // EOF: the whole file was read
        sawByte = true;
        pos += bytesRead;
        let start = 0;
        for (let i = 0; i < bytesRead; i += 1) {
          if (buf[i] !== 0x0a) continue;
          if (finish(buf.subarray(start, i))) {
            truncated = true; // hit the line budget with more file to read
            break outer;
          }
          start = i + 1;
        }
        if (start < bytesRead) {
          const seg = buf.subarray(start, bytesRead);
          curLen += seg.length;
          if (curLen > HEAD_LINE_CAP) {
            skip = true;
            cur = [];
          } else {
            cur.push(Buffer.from(seg));
          }
        }
        if (pos >= HEAD_SCAN_BYTES) {
          truncated = true; // hit the byte budget
          break;
        }
      }
      if (!sawByte) return { ok: false, reason: 'empty' };
      return { ok: true, lines, truncated };
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
